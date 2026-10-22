/**
 * Shared regex-safety check for the MeshCore auto-acknowledge feature.
 *
 * The auto-ack trigger pattern is user-supplied and stored per-source. It is
 * later compiled and run against every inbound message in the manager hot
 * path. We reject patterns that are obvious ReDoS shapes (nested quantifiers,
 * unbounded repetitions, very large explicit counts) to keep the compile +
 * execution costs bounded — both in the store-time route handler and at
 * execution time in the manager.
 *
 * This is intentionally a structural pre-check, not a parser. It catches the
 * common catastrophic-backtracking patterns flagged by `js/regex-injection`
 * (CodeQL) without trying to fully validate arbitrary regex grammar; the
 * subsequent `new RegExp(pattern, 'i')` call still throws on syntactically
 * invalid input.
 */

import { compileUserRegex } from '../../utils/safeRegex.js';
import {
  DANGEROUS_SHAPE_RE,
  MAX_RESPONDER_PATTERN_LENGTH,
  PRINTABLE_CHARSET_RE,
} from '../../utils/responderTrigger.js';

/**
 * Length cap, charset allowlist and ReDoS shapes are shared with the
 * Auto-Responder (src/utils/responderTrigger.ts, #5924). The charset allows
 * any printable Unicode (emoji, accents, CJK, ZWJ sequences) and rejects
 * control and stray format characters. Message Forwarding (#5446) uses this
 * check too, so it gets the same relaxation.
 *
 * RE2 always runs in Unicode mode (it reports flags `iu`), so a non-ASCII
 * literal or class matches whole code points, not UTF-16 halves.
 */
const MAX_PATTERN_LENGTH = MAX_RESPONDER_PATTERN_LENGTH;
const ALLOWED_CHARSET_RE = PRINTABLE_CHARSET_RE;

export interface AutoAckRegexValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate the pattern and return a compiled RegExp on success, or null
 * with the reason on failure. Centralised so the route store-time check
 * and the manager execution-time check stay in sync.
 *
 * Validation order matters: we run a charset allowlist first (printable
 * Unicode only), then check for known
 * catastrophic-backtracking shapes, and finally let `RegExp` reject
 * any remaining syntactic invalidity.
 */
export function compileAutoAckRegex(pattern: string): { regex: RegExp | null; error?: string } {
  if (!pattern) return { regex: null, error: 'empty pattern' };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { regex: null, error: `pattern too long (max ${MAX_PATTERN_LENGTH} chars)` };
  }
  if (!ALLOWED_CHARSET_RE.test(pattern)) {
    return { regex: null, error: 'pattern contains disallowed characters' };
  }
  if (DANGEROUS_SHAPE_RE.test(pattern)) {
    return { regex: null, error: 'pattern matches a catastrophic-backtracking shape' };
  }
  try {
    return { regex: compileUserRegex(pattern, 'i') };
  } catch (err) {
    return { regex: null, error: (err as Error).message };
  }
}

/**
 * Boolean form used at the route layer — store-time gate that simply
 * rejects unsafe patterns before they reach the database.
 */
export function validateAutoAckRegex(pattern: string): AutoAckRegexValidation {
  const result = compileAutoAckRegex(pattern);
  return result.regex ? { ok: true } : { ok: false, error: result.error };
}
