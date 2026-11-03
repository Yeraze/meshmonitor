/**
 * Meshtastic remote-admin CLI — pure helpers (#6154).
 *
 * The free-form CLI console lets an operator type arbitrary `meshtastic` CLI
 * flags that MeshMonitor relays to a remote node through the Virtual Node. This
 * module holds the SHELL-FREE argument handling that makes that safe, plus the
 * danger-command guard. The actual child spawn lives in meshtasticCliRunner.ts
 * (kept separate so route tests can mock the spawn without touching this logic).
 *
 * SECURITY: the user's free-form text is split into an argv array here and
 * handed to `execFile` (never a shell) in the runner. User input is NEVER
 * interpolated into a shell command string, so shell metacharacters (`;`, `|`,
 * `$()`, backticks, `&&`) are inert — they become literal argv tokens.
 */

import { MESHTASTIC_DANGER_COMMAND_PATTERN, isMeshtasticDangerCommand } from '../../utils/meshtasticCliDanger.js';

/**
 * Server-enforced danger pattern. The single source of truth lives in
 * src/utils/meshtasticCliDanger.ts and is shared VERBATIM with the client
 * console (passed to CliConsoleBody as its `dangerPattern`), so the typed-name
 * modal and this server guard always agree on what is destructive.
 *
 * The frontend opens a typed-name confirmation modal for a matching command;
 * this server check means a script or a direct API call cannot bypass the
 * prompt by simply not rendering it — the request is refused without
 * `confirm: true` (DANGER_CONFIRM_REQUIRED). Re-exported here for callers and
 * tests that import it from this module.
 */
export { MESHTASTIC_DANGER_COMMAND_PATTERN };

/**
 * Transport / destination flags the console injects and the user may NOT
 * re-specify. Python `meshtastic` argparse is last-wins, so a trailing
 * `--host`/`--port`/`--dest` in the user's args would override the injected
 * values and defeat the VN-only + remote-only invariants. These are rejected
 * up front (`--flag` and `--flag=value` forms).
 */
const RESERVED_FLAG_PATTERN = /^--(host|port|dest)(=|$)/i;

/** Max length of the free-form argument string the user may submit. */
export const MAX_CLI_ARGS_LENGTH = 2000;
/** Max number of argv tokens parsed from the user's argument string. */
export const MAX_CLI_ARG_COUNT = 64;

/** Thrown when the user's argument string cannot be parsed into argv. */
export class CliArgParseError extends Error {
  readonly code: string;
  constructor(message: string, code = 'CLI_ARGS_INVALID') {
    super(message);
    this.name = 'CliArgParseError';
    this.code = code;
  }
}

/**
 * Split a free-form argument string into an argv array WITHOUT a shell.
 *
 * Quote-aware: single and double quotes group a token and are stripped;
 * a backslash escapes the next character. Unquoted whitespace separates
 * tokens. An unterminated quote throws rather than guessing.
 *
 * This is deliberately a minimal splitter — it does no variable expansion,
 * no glob, no command substitution. Whatever the user types becomes literal
 * argv tokens, which is exactly what makes `execFile` safe.
 */
export function parseCliArgs(input: string): string[] {
  if (input.length > MAX_CLI_ARGS_LENGTH) {
    throw new CliArgParseError(
      `Argument string too long (max ${MAX_CLI_ARGS_LENGTH} characters)`,
      'CLI_ARGS_TOO_LONG',
    );
  }

  const args: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      hasToken = true;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      // Inside single quotes a backslash is literal (shell semantics); keep it.
      if (quote === "'") {
        current += ch;
        hasToken = true;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (quote) {
    throw new CliArgParseError('Unterminated quote in command');
  }
  if (escaped) {
    throw new CliArgParseError('Trailing backslash in command');
  }
  if (hasToken) args.push(current);

  if (args.length === 0) {
    throw new CliArgParseError('Command must contain at least one argument', 'CLI_ARGS_EMPTY');
  }
  if (args.length > MAX_CLI_ARG_COUNT) {
    throw new CliArgParseError(
      `Too many arguments (max ${MAX_CLI_ARG_COUNT})`,
      'CLI_ARGS_TOO_MANY',
    );
  }

  return args;
}

/**
 * True when the argument text names a destructive command. Callers MUST pass
 * the QUOTE-AWARE parsed argv joined with spaces (e.g. `userArgs.join(' ')`),
 * NOT the raw user string — otherwise evasive quoting such as `--rebo"o"t`
 * (which parses to `--reboot`) slips past the guard.
 */
export function isDangerCommand(args: string): boolean {
  return isMeshtasticDangerCommand(args);
}

/**
 * The first injected-transport/dest flag the user tried to re-specify, or null.
 * See RESERVED_FLAG_PATTERN — these cannot be overridden by free-form args.
 */
export function findReservedFlag(userArgs: string[]): string | null {
  for (const tok of userArgs) {
    if (RESERVED_FLAG_PATTERN.test(tok)) return tok;
  }
  return null;
}

export const REDACTED = '********';

/** Config keys / channel fields whose value is a secret. */
const SECRET_KEY_PATTERN = /(?:^|\.)(?:password|passwd|pwd|pass|psk|secret|key|admin_key|private_key)$/i;
/** Flag names whose following token is a secret (or embeds one). */
const SECRET_FLAG_PATTERN = /key|psk|pass|secret|seturl|set-ham/i;

/**
 * Mask secret values in a parsed argv before it is written to the audit log.
 *
 * The radio still gets the real tokens — only the stored audit copy is masked.
 * Meshtastic carries secrets in a few shapes:
 *   - `--set security.admin_key <value>` / any `--set <*.key|*.psk|...> <value>`
 *   - `--ch-set psk <value>`
 *   - `--seturl <url>` (a channel URL embeds the PSK)
 *   - any `--<flag containing key/psk/pass/secret> <value>`
 */
export function redactCliArgsForAudit(argv: string[]): string {
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    const tok = out[i];
    if (tok === '--set' || tok === '--ch-set') {
      const key = out[i + 1];
      if (key !== undefined && SECRET_KEY_PATTERN.test(key) && out[i + 2] !== undefined) {
        out[i + 2] = REDACTED;
        i += 2;
      }
      continue;
    }
    if (tok.startsWith('-') && SECRET_FLAG_PATTERN.test(tok) && out[i + 1] !== undefined && !out[i + 1].startsWith('-')) {
      out[i + 1] = REDACTED;
      i += 1;
    }
  }
  return out.join(' ');
}

/** A Meshtastic node id of the form `!xxxxxxxx` (8 hex digits). */
export function isValidMeshtasticNodeId(id: unknown): id is string {
  return typeof id === 'string' && /^![0-9a-fA-F]{8}$/.test(id);
}

/**
 * Build the full argv for a remote-admin CLI invocation. Always targets a
 * remote node via `--dest` through the Virtual Node loopback endpoint — there
 * is no local-node (no-`--dest`) mode.
 *
 * User args come LAST, which means Python argparse (last-wins) WOULD let a
 * trailing `--host`/`--port`/`--dest` override the injected transport/dest.
 * That is why the caller MUST reject such args first via {@link findReservedFlag}
 * before calling this — the ordering here does not protect the invariants on
 * its own.
 */
export function buildCliArgv(
  target: { host: string; port: number },
  destNodeId: string,
  userArgs: string[],
): string[] {
  return [
    '--host', target.host,
    '--port', String(target.port),
    '--dest', destNodeId,
    ...userArgs,
  ];
}
