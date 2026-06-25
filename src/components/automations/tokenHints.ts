/**
 * `{{ }}` token hinting for builder text fields (#3653 follow-up).
 *
 * Builds the set of valid interpolation paths for the current trigger + the
 * known variables, so the editor can highlight `{{ trigger.* }}` / `{{ var.* }}`
 * tokens and flag unrecognized ones (typos) inline.
 */
import { TRIGGER_TOKENS, UNIVERSAL_TOKENS } from './SubstitutionsHelp';

// Mirrors the engine's interpolate TOKEN regex.
const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** The set of valid token paths for a trigger type + the defined variables. */
export function validTokenSet(triggerType: string, variableNames: string[]): Set<string> {
  const set = new Set<string>(['NOW']);
  for (const [k] of TRIGGER_TOKENS[triggerType] ?? []) set.add(`trigger.${k}`);
  for (const [k] of UNIVERSAL_TOKENS) set.add(`trigger.${k}`);
  for (const name of variableNames) set.add(`var.${name}`);
  return set;
}

export interface TokenSegment { text: string; token: boolean; known: boolean }

/**
 * Split text into plain + token segments for highlighting. An empty token
 * (`{{ }}`) is treated as plain text (it renders blank and isn't a typo).
 */
export function tokenize(text: string, valid: Set<string>): TokenSegment[] {
  const segs: TokenSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) segs.push({ text: text.slice(last, start), token: false, known: true });
    const path = m[1].trim();
    segs.push({ text: m[0], token: path.length > 0, known: path.length === 0 || valid.has(path) });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), token: false, known: true });
  return segs;
}

/** Distinct unrecognized token paths in the text (for an inline warning). */
export function unknownTokens(text: string, valid: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const path = m[1].trim();
    if (path.length > 0 && !valid.has(path)) out.add(path);
  }
  return [...out];
}
