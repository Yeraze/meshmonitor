/**
 * One Auto-Responder trigger matcher for Meshtastic and MeshCore (#5924).
 *
 * A trigger has a `syntax`:
 *  - `'pattern'`: the placeholder DSL. Comma-separated alternatives, literal
 *    text anchored `^…$`, case-insensitive, `{name}` / `{name:regex}`
 *    captures, homoglyph-normalised on both sides.
 *  - `'regex'`: one bare regex, unanchored and case-insensitive. Named groups
 *    `(?<name>…)` supply params.
 *
 * A stored trigger with no `syntax` keeps its old behaviour: Meshtastic reads
 * as `'pattern'`, MeshCore as `'regex'` (`resolveResponderSyntax`). New
 * triggers made in the UI default to `'pattern'` on both sides.
 *
 * This file holds no regex engine. The server passes RE2 (`compileUserRegex`,
 * src/server/utils/responderTriggerMatcher.ts); the browser passes the native
 * engine (`compileNativeLikeRe2`). Both sides run the same parsing, splitting,
 * checks and param extraction, so the UI preview cannot drift from the
 * server. It must stay free of Node-native imports: the client bundles it.
 */
import { applyHomoglyphOptimization } from './homoglyph.js';
import { splitTriggerPatterns } from './autoResponderUtils.js';

export type ResponderSyntax = 'pattern' | 'regex';
export const RESPONDER_SYNTAXES: readonly ResponderSyntax[] = ['pattern', 'regex'];

export function isResponderSyntax(value: unknown): value is ResponderSyntax {
  return value === 'pattern' || value === 'regex';
}

/** The trigger's syntax, or the legacy default when the field is missing or unknown. */
export function resolveResponderSyntax(value: unknown, legacyDefault: ResponderSyntax): ResponderSyntax {
  return isResponderSyntax(value) ? value : legacyDefault;
}

/** Per pattern (one comma alternative in pattern mode, the whole regex in regex mode). */
export const MAX_RESPONDER_PATTERN_LENGTH = 100;

/**
 * Charset allowlist: any printable Unicode. Letters, marks (incl. variation
 * selectors U+FE0E/FE0F), numbers, punctuation, symbols (emoji, skin tones),
 * spaces, tab/CR/LF, ZWJ (U+200D, emoji sequences), ZWNJ (U+200C, Persian /
 * Indic text) and tag characters (subdivision flags such as England).
 * Everything else is rejected: control characters, other format characters,
 * line/paragraph separators, private-use, lone surrogates, unassigned.
 */
export const PRINTABLE_CHARSET_RE =
  /^(?:[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\t\n\r\u{E0020}-\u{E007F}]|\u200C|\u200D)+$/u;

/**
 * Catastrophic-backtracking shapes (regex mode only; RE2 is linear-time, this
 * also bounds compile cost and keeps the browser engine safe):
 *  - `(\.\*){2,}` repeated `.*` groups
 *  - `(\+.*\+)` / `(\*.*\*)` nested unbounded reps
 *  - `(\{[0-9]{3,}\})` explicit count ≥ 100
 *  - `(\{[0-9]+,\})` unbounded `{n,}` repetition
 */
export const DANGEROUS_SHAPE_RE = /(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/;

export type ResponderPatternErrorCode = 'empty' | 'too_long' | 'charset' | 'redos' | 'invalid';

/** Compiles a regex source or throws. RE2 on the server, native in the browser. */
export type RegexCompiler = (source: string, flags: string) => RegExp;

export interface ResponderTriggerInput {
  /** MeshCore `pattern` or Meshtastic `trigger`. */
  pattern: string | string[];
  syntax: ResponderSyntax;
}

export interface CompiledResponderPattern {
  /** The pattern as the user wrote it (one comma alternative in pattern mode). */
  pattern: string;
  /** The regex source that runs (anchored DSL expansion, or the bare regex). */
  source: string;
  regex: RegExp;
  /** Pattern mode: `{name}` placeholders in capture order. Empty in regex mode. */
  paramNames: string[];
}

export interface CompiledResponderTrigger {
  syntax: ResponderSyntax;
  patterns: CompiledResponderPattern[];
}

export interface ResponderMatch {
  matched: boolean;
  params: Record<string, string>;
  /** The pattern that matched (pattern mode: the comma alternative). */
  matchedPattern?: string;
  /** The regex source that matched. */
  source?: string;
}

/**
 * The separate patterns a trigger holds. Pattern mode splits on top-level
 * commas (the DSL separator); regex mode never splits, since a comma is
 * ordinary regex text (`a{1,3}`). An array is taken as already split.
 */
export function responderPatternList(pattern: string | string[] | undefined | null, syntax: ResponderSyntax): string[] {
  if (Array.isArray(pattern)) {
    return pattern.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  }
  if (typeof pattern !== 'string' || !pattern.trim()) return [];
  return syntax === 'pattern' ? splitTriggerPatterns(pattern) : [pattern];
}

/**
 * Expand one placeholder-DSL pattern into an anchored regex source. Literal
 * text is escaped; `{name}` becomes `([^\s]+)`, `{name:re}` becomes `(re)`.
 * A repeated name reuses its first definition.
 */
export function parsePatternDsl(patternStr: string): { source: string; paramNames: string[] } {
  interface ParamSpec { name: string; pattern?: string }
  const params: ParamSpec[] = [];
  let source = '';
  let placeholders = 0;
  let i = 0;
  while (i < patternStr.length) {
    if (patternStr[i] === '{') {
      const startPos = i + 1;
      let depth = 1;
      let colonPos = -1;
      let endPos = -1;
      // Find the matching closing brace, allowing nested braces in the regex.
      for (let j = startPos; j < patternStr.length && depth > 0; j++) {
        if (patternStr[j] === '{') {
          depth++;
        } else if (patternStr[j] === '}') {
          depth--;
          if (depth === 0) endPos = j;
        } else if (patternStr[j] === ':' && depth === 1 && colonPos === -1) {
          colonPos = j;
        }
      }
      if (endPos !== -1) {
        const name = colonPos !== -1 ? patternStr.substring(startPos, colonPos) : patternStr.substring(startPos, endPos);
        const re = colonPos !== -1 ? patternStr.substring(colonPos + 1, endPos) : undefined;
        if (!params.find((p) => p.name === name)) params.push({ name, pattern: re });
        // The Nth placeholder takes the Nth distinct definition (the
        // historical behaviour of the Meshtastic matcher). A placeholder
        // past the last definition (a repeated name) stays literal text.
        const def = params[placeholders];
        if (def) {
          placeholders++;
          source += `(${def.pattern || '[^\\s]+'})`;
        } else {
          source += escapeLiteral(patternStr.substring(i, endPos + 1));
        }
        i = endPos + 1;
        continue;
      }
    }
    // Escape regex specials in literal text (an unmatched `{` included).
    source += escapeLiteral(patternStr[i]);
    i++;
  }
  return { source: `^${source}$`, paramNames: params.map((p) => p.name) };
}

function escapeLiteral(text: string): string {
  let out = '';
  for (const ch of text) out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  return out;
}

/** Store-time checks for one pattern. Regex mode adds the ReDoS shape check. */
export function checkResponderPattern(pattern: string, syntax: ResponderSyntax): ResponderPatternErrorCode | undefined {
  if (!pattern) return 'empty';
  if (pattern.length > MAX_RESPONDER_PATTERN_LENGTH) return 'too_long';
  if (!PRINTABLE_CHARSET_RE.test(pattern)) return 'charset';
  if (syntax === 'regex' && DANGEROUS_SHAPE_RE.test(pattern)) return 'redos';
  return undefined;
}

export interface CompileResponderOptions {
  /**
   * Apply the store-time checks (length, charset, ReDoS shape) to every
   * pattern. Regex mode always applies them, as MeshCore always has. Pattern
   * mode applies them only when asked (route / UI validation), so a stored
   * Meshtastic trigger that predates the checks keeps matching.
   */
  validate?: boolean;
}

/**
 * Compile every pattern of a trigger. Fails as a whole on the first bad
 * pattern when validating; otherwise a pattern-mode alternative that does not
 * compile is skipped (it matches nothing), as the Meshtastic matcher did.
 */
export function compileResponderTrigger(
  trigger: ResponderTriggerInput,
  compile: RegexCompiler,
  options: CompileResponderOptions = {},
): { compiled: CompiledResponderTrigger | null; error?: ResponderPatternErrorCode; detail?: string; failedPattern?: string } {
  const { syntax } = trigger;
  const list = responderPatternList(trigger.pattern, syntax);
  if (list.length === 0) return { compiled: null, error: 'empty' };
  const strict = options.validate === true || syntax === 'regex';
  const patterns: CompiledResponderPattern[] = [];
  for (const pattern of list) {
    if (strict) {
      const code = checkResponderPattern(pattern, syntax);
      if (code) return { compiled: null, error: code, failedPattern: pattern };
    }
    let source: string;
    let paramNames: string[] = [];
    if (syntax === 'pattern') {
      ({ source, paramNames } = parsePatternDsl(applyHomoglyphOptimization(pattern)));
    } else {
      source = pattern;
    }
    try {
      patterns.push({ pattern, source, regex: compile(source, 'i'), paramNames });
    } catch (err) {
      if (strict) return { compiled: null, error: 'invalid', detail: (err as Error).message, failedPattern: pattern };
    }
  }
  if (patterns.length === 0) return { compiled: null, error: 'invalid' };
  return { compiled: { syntax, patterns } };
}

function namedGroups(m: RegExpExecArray | RegExpMatchArray): Record<string, string> {
  const out: Record<string, string> = {};
  if (m.groups) {
    for (const [k, v] of Object.entries(m.groups)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/** Run a compiled trigger against one message; the first matching pattern wins. */
export function runResponderTrigger(compiled: CompiledResponderTrigger, text: string): ResponderMatch {
  if (compiled.syntax === 'regex') {
    for (const p of compiled.patterns) {
      const m = text.match(p.regex);
      if (m) return { matched: true, params: namedGroups(m), matchedPattern: p.pattern, source: p.source };
    }
    return { matched: false, params: {} };
  }
  // Pattern mode: homoglyph-normalise the text (#2136), then take params from
  // the ORIGINAL text when it also matches, so a Cyrillic word such as
  // "Барнаул" is not handed on as "Бapнayл".
  const normalized = applyHomoglyphOptimization(text);
  for (const p of compiled.patterns) {
    const m = normalized.match(p.regex);
    if (!m) continue;
    const original = text.match(p.regex);
    const params: Record<string, string> = {};
    p.paramNames.forEach((name, idx) => {
      params[name] = original?.[idx + 1] ?? m[idx + 1];
    });
    return { matched: true, params, matchedPattern: p.pattern, source: p.source };
  }
  return { matched: false, params: {} };
}

/**
 * Fill `{name}` placeholders in a response with captured params. The same
 * rule the Meshtastic text response has always used; unknown placeholders
 * (e.g. `{NODE_ID}` tokens) are left for the token expander.
 */
export function substituteResponderParams(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{${key}}`).join(value ?? '');
  }
  return out;
}
