/**
 * `{{ }}` token hinting for builder text fields (#3653 follow-up).
 *
 * Classifies each `{{ trigger.* }}` / `{{ var.* }}` / `{{ NOW }}` token so the
 * editor can highlight it and catch typos:
 *   - 'ok'      valid for the CURRENT trigger (or a known var / NOW)
 *   - 'foreign' a real token, but it belongs to a DIFFERENT trigger (it'll
 *               render blank here) — not a typo, just not available
 *   - 'bad'     unrecognized everywhere → likely a typo
 */
import { TRIGGER_TOKENS, UNIVERSAL_TOKENS } from './SubstitutionsHelp';

// Mirrors the engine's interpolate TOKEN regex.
const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export type TokenStatus = 'ok' | 'foreign' | 'bad';

/** Valid token paths for a trigger type + the defined variables (the 'ok' set). */
export function validTokenSet(triggerType: string, variableNames: string[]): Set<string> {
  const set = new Set<string>(['NOW']);
  for (const [k] of TRIGGER_TOKENS[triggerType] ?? []) set.add(`trigger.${k}`);
  for (const [k] of UNIVERSAL_TOKENS) set.add(`trigger.${k}`);
  for (const name of variableNames) set.add(`var.${name}`);
  return set;
}

/** Every `trigger.*` token across ALL trigger types (+ universals) — for the 'foreign' tier. */
let anyCache: Set<string> | null = null;
export function anyTriggerTokenSet(): Set<string> {
  if (anyCache) return anyCache;
  const set = new Set<string>();
  for (const toks of Object.values(TRIGGER_TOKENS)) for (const [k] of toks) set.add(`trigger.${k}`);
  for (const [k] of UNIVERSAL_TOKENS) set.add(`trigger.${k}`);
  anyCache = set;
  return set;
}

/** Classify a single token path against the current-trigger valid set. */
export function classifyToken(path: string, valid: Set<string>): TokenStatus {
  if (path.length === 0 || valid.has(path)) return 'ok';
  if (path.startsWith('trigger.') && anyTriggerTokenSet().has(path)) return 'foreign';
  return 'bad';
}

export interface TokenSegment { text: string; token: boolean; status: TokenStatus }

/** Split text into plain + token segments for highlighting. */
export function tokenize(text: string, valid: Set<string>): TokenSegment[] {
  const segs: TokenSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) segs.push({ text: text.slice(last, start), token: false, status: 'ok' });
    const path = m[1].trim();
    segs.push({ text: m[0], token: path.length > 0, status: classifyToken(path, valid) });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last), token: false, status: 'ok' });
  return segs;
}

/** Distinct genuinely-unrecognized ('bad') token paths in the text. */
export function unknownTokens(text: string, valid: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const path = m[1].trim();
    if (classifyToken(path, valid) === 'bad') out.add(path);
  }
  return [...out];
}

/** Distinct 'foreign' (valid-but-wrong-trigger) token paths in the text. */
export function foreignTokens(text: string, valid: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) {
    const path = m[1].trim();
    if (classifyToken(path, valid) === 'foreign') out.add(path);
  }
  return [...out];
}
