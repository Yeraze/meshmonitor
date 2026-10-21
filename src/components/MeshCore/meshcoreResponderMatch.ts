/**
 * Client copy of the MeshCore Auto-Responder pattern rules (#5808, #5924).
 *
 * The server (`MeshCoreManager.checkAutoResponder`) runs each trigger through
 * `matchResponderTrigger` (src/server/utils/autoResponderMatcher.ts) in the
 * trigger's `syntax`:
 *  - `'regex'` (a saved trigger with no `syntax`): a bare regex, at most 100
 *    characters, printable Unicode only, no catastrophic backtracking shape,
 *    then RE2 with `i`. Unanchored and case-insensitive.
 *  - `'pattern'` (new triggers): the Meshtastic placeholder DSL.
 *
 * This file runs the same shared core with the browser engine
 * (src/utils/responderTriggerNative.ts). `meshcoreResponderMatch.test.ts`
 * checks the two against each other.
 */
import { compileNativeLikeRe2, matchResponderTriggerNative, validateResponderTriggerNative } from '../../utils/responderTriggerNative';
import { resolveResponderSyntax, type ResponderMatch, type ResponderSyntax } from '../../utils/responderTrigger';

/** MeshCore's legacy default: a saved trigger with no `syntax` is a regex. */
export const MESHCORE_LEGACY_SYNTAX: ResponderSyntax = 'regex';

export function meshCoreTriggerSyntax(trigger: { syntax?: unknown }): ResponderSyntax {
  return resolveResponderSyntax(trigger.syntax, MESHCORE_LEGACY_SYNTAX);
}

export interface PatternCompile {
  regex: RegExp | null;
  error?: string;
}

/** Regex mode only: the compiled regex, or why the server would refuse it. */
export function compileMeshCoreResponderPattern(pattern: string): PatternCompile {
  const v = validateResponderTriggerNative(pattern, 'regex');
  if (!v.valid) return { regex: null, error: v.error };
  try {
    return { regex: compileNativeLikeRe2(pattern, 'i') };
  } catch {
    return { regex: null, error: 'Invalid regex syntax' };
  }
}

export function validateMeshCoreResponderPattern(
  pattern: string,
  syntax: ResponderSyntax = MESHCORE_LEGACY_SYNTAX,
): { valid: boolean; error?: string } {
  return validateResponderTriggerNative(pattern, syntax);
}

/** Does this message fire this pattern on the server, and with what params? */
export function matchMeshCoreResponderPattern(
  pattern: string,
  text: string,
  syntax: ResponderSyntax = MESHCORE_LEGACY_SYNTAX,
): ResponderMatch {
  return matchResponderTriggerNative({ pattern, syntax }, text);
}

/** Does this message fire this pattern on the server? */
export function meshCoreResponderPatternMatches(
  pattern: string,
  text: string,
  syntax: ResponderSyntax = MESHCORE_LEGACY_SYNTAX,
): boolean {
  return matchMeshCoreResponderPattern(pattern, text, syntax).matched;
}
