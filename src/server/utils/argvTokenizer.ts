/**
 * Shell-style argv tokenizer for the Automation Engine's action.runScript
 * Arguments field. Splits a single string into argv with quote and backslash
 * handling that matches user expectations from POSIX shells, minus every
 * expansion. This is NOT a shell: it does not expand `$var`, backticks,
 * `$(...)`, globs, or handle redirects and pipes. Callers that want template
 * expansion (e.g. `{{ event.field }}`) run their template pass BEFORE
 * tokenizing.
 *
 * Rules:
 *   - Whitespace between tokens is a separator (any run of ASCII whitespace).
 *   - Single quotes (`'`) preserve their contents verbatim. Backslashes inside
 *     single quotes have no special meaning. Newlines are allowed.
 *   - Double quotes (`"`) preserve whitespace and allow `\\`, `\"`, `\n`, `\t`
 *     escapes; any other `\x` inside double quotes is emitted verbatim as `\x`.
 *   - A bare backslash outside quotes escapes the next character literally
 *     (`hello\ world` yields one token `hello world`). A trailing bare
 *     backslash is treated as a literal backslash.
 *   - Empty or all-whitespace input returns `[]`.
 *   - An unterminated single or double quote throws so the caller can fail the
 *     action cleanly rather than silently truncating argv.
 */

/** Thrown when a quote opens and the string ends before it closes. */
export class ArgvTokenizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvTokenizerError';
  }
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

/**
 * Split `input` into a list of arguments with shell-style quote and escape
 * handling. Returns an empty array for empty or whitespace-only input.
 *
 * @throws {ArgvTokenizerError} on an unterminated quote.
 */
export function tokenizeArgv(input: string): string[] {
  const argv: string[] = [];
  const buf: string[] = [];
  let inToken = false;

  const flush = () => {
    if (inToken) {
      argv.push(buf.join(''));
      buf.length = 0;
      inToken = false;
    }
  };

  const len = input.length;
  let i = 0;
  while (i < len) {
    const ch = input[i];

    if (isWhitespace(ch)) {
      flush();
      i++;
      continue;
    }

    if (ch === "'") {
      inToken = true;
      const start = i;
      i++;
      while (i < len && input[i] !== "'") {
        buf.push(input[i]);
        i++;
      }
      if (i >= len) {
        throw new ArgvTokenizerError(
          `unterminated single quote starting at position ${start}`,
        );
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inToken = true;
      const start = i;
      i++;
      while (i < len && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < len) {
          const next = input[i + 1];
          if (next === '"' || next === '\\') {
            buf.push(next);
            i += 2;
            continue;
          }
          if (next === 'n') { buf.push('\n'); i += 2; continue; }
          if (next === 't') { buf.push('\t'); i += 2; continue; }
          buf.push('\\', next);
          i += 2;
          continue;
        }
        buf.push(input[i]);
        i++;
      }
      if (i >= len) {
        throw new ArgvTokenizerError(
          `unterminated double quote starting at position ${start}`,
        );
      }
      i++;
      continue;
    }

    if (ch === '\\') {
      inToken = true;
      if (i + 1 < len) {
        buf.push(input[i + 1]);
        i += 2;
      } else {
        buf.push('\\');
        i++;
      }
      continue;
    }

    inToken = true;
    buf.push(ch);
    i++;
  }

  flush();
  return argv;
}
