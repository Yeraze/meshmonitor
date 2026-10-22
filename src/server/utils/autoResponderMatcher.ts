/**
 * Server-only: the Auto-Responder trigger matcher for Meshtastic and MeshCore
 * (#5924).
 *
 * Lives under src/server/utils (NOT src/utils) because it compiles with RE2
 * through safeRegex.js (a native module). The parsing, splitting, checks and
 * param extraction live in src/utils/responderTrigger.ts, which the browser
 * also runs with its own engine, so the UI preview matches this.
 */
import { compileUserRegex } from '../../utils/safeRegex.js';
import {
  compileResponderTrigger,
  runResponderTrigger,
  type CompiledResponderTrigger,
  type CompileResponderOptions,
  type ResponderPatternErrorCode,
  type ResponderSyntax,
  type ResponderTriggerInput,
  MAX_RESPONDER_PATTERN_LENGTH,
} from '../../utils/responderTrigger.js';

export interface AutoResponderMatch {
  matched: boolean;
  /** param name -> extracted value (from original text when possible) */
  params: Record<string, string>;
  /** The pattern that matched. */
  matchedPattern?: string;
}

/** Compile a trigger with RE2. See `compileResponderTrigger`. */
export function compileResponderTriggerRe2(
  trigger: ResponderTriggerInput,
  options: CompileResponderOptions = {},
): ReturnType<typeof compileResponderTrigger> {
  return compileResponderTrigger(trigger, compileUserRegex, options);
}

/**
 * Match one message against one trigger, in either syntax. Both managers call
 * this. A trigger that does not compile matches nothing.
 */
export function matchResponderTrigger(trigger: ResponderTriggerInput, text: string): AutoResponderMatch {
  const { compiled } = compileResponderTriggerRe2(trigger);
  return compiled ? matchCompiledResponderTrigger(compiled, text) : { matched: false, params: {} };
}

/** Run an already-compiled trigger (MeshCore caches the compile). */
export function matchCompiledResponderTrigger(compiled: CompiledResponderTrigger, text: string): AutoResponderMatch {
  const m = runResponderTrigger(compiled, text);
  return m.matched ? { matched: true, params: m.params, matchedPattern: m.matchedPattern } : { matched: false, params: {} };
}

const ERROR_TEXT: Record<ResponderPatternErrorCode, string> = {
  empty: 'empty pattern',
  too_long: `pattern too long (max ${MAX_RESPONDER_PATTERN_LENGTH} chars)`,
  charset: 'pattern contains disallowed characters',
  redos: 'pattern matches a catastrophic-backtracking shape',
  invalid: 'invalid regex',
};

/** Store-time check of a trigger in either syntax. Same rules the UI applies. */
export function validateResponderTrigger(
  pattern: string | string[],
  syntax: ResponderSyntax,
): { ok: boolean; error?: string } {
  const r = compileResponderTriggerRe2({ pattern, syntax }, { validate: true });
  if (r.compiled) return { ok: true };
  const base = ERROR_TEXT[r.error ?? 'invalid'];
  const where = r.failedPattern !== undefined && syntax === 'pattern' ? ` in "${r.failedPattern}"` : '';
  return { ok: false, error: `${base}${r.detail ? `: ${r.detail}` : ''}${where}` };
}

/**
 * Match one Meshtastic placeholder-DSL pattern (one comma alternative, e.g.
 * "weather {city}" or "zip {z:\\d{5}}"). Kept for existing callers and tests;
 * same as `matchResponderTrigger` in pattern mode.
 */
export function matchAutoResponderPattern(patternStr: string, messageText: string): AutoResponderMatch {
  const m = matchResponderTrigger({ pattern: [patternStr], syntax: 'pattern' }, messageText);
  return { matched: m.matched, params: m.params };
}
