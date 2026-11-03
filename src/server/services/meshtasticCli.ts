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

/**
 * Server-enforced regex for destructive commands. Kept VERBATIM in sync with
 * the client-side DANGER_COMMAND_PATTERN in
 * src/components/MeshCore/CliConsoleBody.tsx (the shared console primitive the
 * frontend reuses). It matches the Meshtastic destructive flags `--reboot`,
 * `--factory-reset`, `--shutdown`, and the equivalent bare verbs. The trailing
 * `(?!\.)` excludes a danger word used as the prefix of a dotted key.
 *
 * The frontend opens a typed-name confirmation modal for a matching command;
 * this server check means a script or a direct API call cannot bypass the
 * prompt by simply not rendering it — the request is refused without
 * `confirm: true` (DANGER_CONFIRM_REQUIRED).
 */
export const MESHTASTIC_DANGER_COMMAND_PATTERN = /\b(reboot|erase|clkreboot|factory|poweroff|shutdown)\b(?!\.)/i;

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

/** True when the raw argument string contains a destructive command. */
export function isDangerCommand(args: string): boolean {
  return MESHTASTIC_DANGER_COMMAND_PATTERN.test(args);
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
 * is no local-node (no-`--dest`) mode. User args come LAST so they cannot
 * override the leading transport/dest flags with a shell; they are still
 * literal tokens either way.
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
