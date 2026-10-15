/**
 * Client copy of the MeshCore Auto-Responder pattern rules (#5808).
 *
 * The server (`MeshCoreManager.checkAutoResponder`) compiles each trigger's
 * pattern with `compileAutoAckRegex` (src/server/utils/autoAckRegex.ts): at
 * most 100 characters, an ASCII charset allowlist, a check for catastrophic
 * backtracking shapes, then RE2 with the `i` flag. A message matches when
 * `regex.test(text)` is true: case-insensitive and unanchored.
 *
 * The client cannot load RE2 (a native module), so it compiles with the
 * built-in RegExp, rejects the constructs RE2 does not support (lookaround,
 * backreferences) up front, and turns on `u` mode for Unicode classes.
 * `meshcoreResponderMatch.test.ts` checks the two against each other. Rare
 * RE2-only syntax (`(?i)`, `(?P<name>…)`, `\A`, `\z`) can still differ.
 */

const MAX_PATTERN_LENGTH = 100;
// Keep in lockstep with ALLOWED_CHARSET_RE in src/server/utils/autoAckRegex.ts.
const ALLOWED_CHARSET_RE = /^[A-Za-z0-9\s.^$*+?()|[\]{},\\!@#%&'"<>=~`:;/_-]+$/;
// Keep in lockstep with DANGEROUS_SHAPE_RE in src/server/utils/autoAckRegex.ts.
const DANGEROUS_SHAPE_RE = /(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/;
// RE2 throws on these; the native engine would quietly accept them.
const RE2_UNSUPPORTED_RE = /\(\?<?[=!]|\\[1-9]/;

export interface PatternCompile {
  regex: RegExp | null;
  error?: string;
}

export function compileMeshCoreResponderPattern(pattern: string): PatternCompile {
  if (!pattern) return { regex: null, error: 'Pattern is required' };
  if (pattern.length > MAX_PATTERN_LENGTH) return { regex: null, error: 'Pattern too long (max 100 chars)' };
  if (!ALLOWED_CHARSET_RE.test(pattern)) {
    return { regex: null, error: 'Pattern contains characters the server does not accept' };
  }
  if (DANGEROUS_SHAPE_RE.test(pattern)) return { regex: null, error: 'Pattern too complex (possible ReDoS)' };
  if (RE2_UNSUPPORTED_RE.test(pattern)) {
    return { regex: null, error: 'Lookaround and backreferences are not supported' };
  }
  // RE2 reads `\p{L}` / `\pL` as a Unicode class; the built-in engine does
  // too, but only in `u` mode (without it `\p{L}` is the literal "p{L}").
  if (/\\[pP]/.test(pattern)) {
    try {
      return { regex: new RegExp(pattern.replace(/\\([pP])([A-Za-z])/g, '\\$1{$2}'), 'iu') };
    } catch {
      // fall through to the plain compile
    }
  }
  try {
    return { regex: new RegExp(pattern, 'i') };
  } catch {
    return { regex: null, error: 'Invalid regex syntax' };
  }
}

export function validateMeshCoreResponderPattern(pattern: string): { valid: boolean; error?: string } {
  const r = compileMeshCoreResponderPattern(pattern);
  return r.regex ? { valid: true } : { valid: false, error: r.error };
}

/** Does this message fire this pattern on the server? */
export function meshCoreResponderPatternMatches(pattern: string, text: string): boolean {
  const { regex } = compileMeshCoreResponderPattern(pattern);
  return !!regex && regex.test(text);
}
