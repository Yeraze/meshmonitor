/**
 * Mask secrets in MeshCore CLI command and reply text (#5892).
 *
 * Every place that STORES a CLI line (the `meshcore_cli_history` table and the
 * `details.command` of a MeshCore audit row) runs it through here first. The
 * radio still gets the real text; only what we keep is masked.
 *
 * Secret-bearing commands in the MeshCore CLI (repeater / room server CommonCLI
 * plus the 1.18 companion CLI):
 *   - `password <new>`             admin password
 *   - `set <key> <value>`          when `<key>` names a secret:
 *       guest.password, admin.password, password, prv.key, any `*.key`,
 *       any `*.password` / `*.pwd` / `*.pass` / `*.psk` / `*.secret`
 *       (wifi.password, bridge.secret, ...)
 *   - `login <password>`           in case a client sends it as a CLI line
 *   - `get <secret key>`           the command is harmless, but the REPLY
 *                                  carries the secret (`get prv.key`,
 *                                  `get guest.password`)
 */

export const REDACTED = '********';

/** Config keys whose value is a secret. Matched on the whole key. */
const SECRET_KEY_PATTERN = /^(?:[a-z0-9_]+\.)*(?:password|passwd|pwd|pass|psk|secret|key)$/i;

/** Verbs whose every argument is a secret. */
const SECRET_ARG_VERBS = new Set(['password', 'passwd', 'login']);

interface ParsedCli {
  /** Leading whitespace kept so the masked line reads like the original. */
  lead: string;
  verb: string;
  rest: string;
}

function parse(command: string): ParsedCli | null {
  const m = /^(\s*)(\S+)(.*)$/s.exec(command);
  if (!m) return null;
  return { lead: m[1], verb: m[2], rest: m[3] };
}

/** The secret key a `set`/`get` line names, if it names one. */
function secretKeyOf(rest: string): string | null {
  const m = /^\s+(\S+)/.exec(rest);
  if (!m) return null;
  return SECRET_KEY_PATTERN.test(m[1]) ? m[1] : null;
}

/**
 * The plain-text secret a command carries, or null when it carries none.
 * Used to scrub an echo of that value out of the reply or error.
 */
export function extractCliSecret(command: string): string | null {
  const p = parse(command);
  if (!p) return null;
  const verb = p.verb.toLowerCase();
  if (SECRET_ARG_VERBS.has(verb)) {
    const value = p.rest.trim();
    return value.length > 0 ? value : null;
  }
  if (verb === 'set') {
    const m = /^\s+(\S+)\s+(.+)$/s.exec(p.rest);
    if (m && SECRET_KEY_PATTERN.test(m[1])) {
      const value = m[2].trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Mask the secret argument of a MeshCore CLI command. Other text is unchanged. */
export function redactCliCommand(command: string): string {
  if (typeof command !== 'string' || command.length === 0) return command;
  const p = parse(command);
  if (!p) return command;
  const verb = p.verb.toLowerCase();
  if (SECRET_ARG_VERBS.has(verb)) {
    return p.rest.trim().length > 0 ? `${p.lead}${p.verb} ${REDACTED}` : command;
  }
  if (verb === 'set') {
    const m = /^(\s+)(\S+)(\s+)(.+)$/s.exec(p.rest);
    if (m && SECRET_KEY_PATTERN.test(m[2])) {
      return `${p.lead}${p.verb}${m[1]}${m[2]}${m[3]}${REDACTED}`;
    }
  }
  return command;
}

/** True when the command reads a secret back (`get prv.key`, `get guest.password`). */
export function isSecretReadCommand(command: string): boolean {
  const p = parse(command);
  if (!p || p.verb.toLowerCase() !== 'get') return false;
  return secretKeyOf(p.rest) !== null;
}

/**
 * Mask secrets in a reply (or error) to `command`:
 *   - a secret read: the value after the firmware's `> ` prompt (or the whole
 *     reply when there is no prompt) is replaced;
 *   - a secret write: any echo of the value is replaced.
 */
export function redactCliReply(command: string, reply: string | null | undefined): string | null {
  if (reply === null || reply === undefined) return null;
  if (typeof reply !== 'string' || reply.length === 0) return reply ?? null;
  if (isSecretReadCommand(command)) {
    const m = /^(\s*>\s*)(.*)$/s.exec(reply);
    if (m) return m[2].trim().length > 0 ? `${m[1]}${REDACTED}` : reply;
    // Errors such as "Error: unknown config" hold no secret; keep them.
    if (/^\s*(err|error|unknown)\b/i.test(reply)) return reply;
    return REDACTED;
  }
  const secret = extractCliSecret(command);
  if (secret && reply.includes(secret)) {
    return reply.split(secret).join(REDACTED);
  }
  return reply;
}
