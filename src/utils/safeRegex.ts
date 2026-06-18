import RE2 from 're2';

/**
 * Compile a user- or admin-supplied regular expression with RE2 — a
 * linear-time engine that is immune to catastrophic backtracking (ReDoS).
 *
 * Use this everywhere a regex pattern originates from request bodies or stored
 * settings instead of `new RegExp(...)`. RE2 instances implement the standard
 * `RegExp` interface (`test`/`exec`/`match`/`replace`), so they are drop-in at
 * the call site.
 *
 * Trade-off: RE2 does not support backreferences or lookaround (`(?=`, `(?<=`,
 * `\1`, …) and will throw on such patterns — exactly the constructs that make
 * native `RegExp` vulnerable. Callers should keep their existing try/catch so an
 * unsupported or malformed pattern is rejected as "invalid regex".
 *
 * Resolves CodeQL js/regex-injection on user-controlled regex sources.
 */
export function compileUserRegex(pattern: string, flags?: string): RegExp {
  return new RE2(pattern, flags) as unknown as RegExp;
}
