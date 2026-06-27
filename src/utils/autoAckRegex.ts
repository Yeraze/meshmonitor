/**
 * Auto-acknowledge regex helpers shared by the client validator.
 *
 * The server validates auto-ack patterns with RE2 (see `src/utils/safeRegex.ts`),
 * which — unlike the browser's native `RegExp` — rejects lookaround and
 * backreferences. The client must mirror that accept set so a pattern the server
 * cannot compile is never persisted; otherwise the save 400s and the whole
 * Auto-Acknowledge section freezes (#3806).
 */

/**
 * Returns true when `pattern` uses regex constructs that RE2 cannot compile:
 * lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) — but NOT named capture groups like
 * `(?<name>)`, which RE2 supports — or backreferences (`\1`…`\9`).
 */
export function hasRE2IncompatibleConstructs(pattern: string): boolean {
  return /\(\?<?[=!]/.test(pattern) || /\\[1-9]/.test(pattern);
}
