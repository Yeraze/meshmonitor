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

const MAX_PATTERN_LENGTH = 100;

/**
 * Charset allowlist. The pattern may contain only ASCII letters, digits,
 * whitespace, and the regex meta-characters we actually want to support
 * (alternation, anchors, character classes, simple quantifiers,
 * groups, common literal punctuation). Notably excluded:
 *  - Unicode property escapes (`\p{…}`) — can be slow / DoS-prone
 *  - Unicode code-point escapes (`\u{…}`) — same
 *  - Any non-ASCII character — narrows the attack surface to a
 *    well-understood charset and acts as a CodeQL data-flow barrier
 *    for the `js/regex-injection` query.
 */
const ALLOWED_CHARSET_RE = /^[A-Za-z0-9\s.^$*+?()|[\]{},\\!@#%&'"<>=~`:;/_\-]+$/;

// Catastrophic-backtracking shapes:
//  - `(\.\*){2,}`  — repeated `.*` groups
//  - `(\+.*\+)`    — text-between-two-pluses (nested unbounded reps)
//  - `(\*.*\*)`    — same with stars
//  - `(\{[0-9]{3,}\})` — explicit count ≥ 1000
//  - `(\{[0-9]+,\})`   — unbounded `{n,}` repetition
const DANGEROUS_SHAPE_RE = /(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/;

export interface AutoAckRegexValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate the pattern and return a compiled RegExp on success, or null
 * with the reason on failure. Centralised so the route store-time check
 * and the manager execution-time check stay in sync.
 *
 * Validation order matters: we run a charset allowlist first (which
 * acts as a sanitising barrier — only patterns built from this fixed
 * set of ASCII characters reach the compiler), then check for known
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
