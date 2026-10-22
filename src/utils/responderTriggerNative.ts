/**
 * Browser copy of the Auto-Responder trigger matcher (#5924).
 *
 * The server compiles with RE2 (src/server/utils/autoResponderMatcher.ts).
 * The browser cannot load RE2 (a native module), so this passes the built-in
 * engine to the same shared core (src/utils/responderTrigger.ts), shaped to
 * act like RE2:
 *  - constructs RE2 rejects (lookaround, backreferences) are rejected here too;
 *  - RE2 always runs in Unicode mode, so `u` is tried first (with `\pL`
 *    rewritten to `\p{L}`, which `u` mode needs). A pattern `u` mode refuses
 *    but RE2 takes (e.g. an identity escape such as `\-`) falls back to plain
 *    `i`.
 *
 * `responderTriggerParity.test.ts` and `meshcoreResponderMatch.test.ts` check
 * this against the server. Rare RE2-only syntax (`(?i)`, `(?P<name>…)`, `\A`,
 * `\z`) can still differ.
 */
import {
  compileResponderTrigger,
  runResponderTrigger,
  MAX_RESPONDER_PATTERN_LENGTH,
  type ResponderMatch,
  type ResponderPatternErrorCode,
  type ResponderSyntax,
  type ResponderTriggerInput,
} from './responderTrigger.js';

// RE2 throws on these; the native engine would quietly accept them.
const RE2_UNSUPPORTED_RE = /\(\?<?[=!]|\\[1-9]/;
const RE2_UNSUPPORTED_MESSAGE = 'Lookaround and backreferences are not supported';

export function compileNativeLikeRe2(source: string, flags: string): RegExp {
  if (RE2_UNSUPPORTED_RE.test(source)) throw new Error(RE2_UNSUPPORTED_MESSAGE);
  try {
    return new RegExp(source.replace(/\\([pP])([A-Za-z])/g, '\\$1{$2}'), `${flags}u`);
  } catch {
    return new RegExp(source, flags);
  }
}

/** Client error text, by code. */
const ERROR_TEXT: Record<ResponderPatternErrorCode, string> = {
  empty: 'Pattern is required',
  too_long: `Pattern too long (max ${MAX_RESPONDER_PATTERN_LENGTH} chars)`,
  charset: 'Pattern contains characters the server does not accept',
  redos: 'Pattern too complex (possible ReDoS)',
  invalid: 'Invalid regex syntax',
};

export function validateResponderTriggerNative(
  pattern: string | string[],
  syntax: ResponderSyntax,
): { valid: boolean; error?: string } {
  const r = compileResponderTrigger({ pattern, syntax }, compileNativeLikeRe2, { validate: true });
  if (r.compiled) return { valid: true };
  const text = r.detail === RE2_UNSUPPORTED_MESSAGE ? RE2_UNSUPPORTED_MESSAGE : ERROR_TEXT[r.error ?? 'invalid'];
  // Name the failing alternative when there are several.
  const where = syntax === 'pattern' && r.failedPattern !== undefined && r.failedPattern !== pattern
    ? ` ("${r.failedPattern}")`
    : '';
  return { valid: false, error: `${text}${where}` };
}

/** Does this message fire this trigger on the server, and with what params? */
export function matchResponderTriggerNative(trigger: ResponderTriggerInput, text: string): ResponderMatch {
  const { compiled } = compileResponderTrigger(trigger, compileNativeLikeRe2);
  return compiled ? runResponderTrigger(compiled, text) : { matched: false, params: {} };
}
