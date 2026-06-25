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

export type TokenSeverity = 'error' | 'warn';
export interface TokenDiag { token: string; severity: TokenSeverity; detail: string }

/**
 * Per-token diagnostics for the bar below a field. Distinct, in first-seen
 * order; only problematic tokens are returned (valid ones produce nothing):
 *   - `{{ var.x }}` with no such variable   → error "does not exist"
 *   - `{{ trigger.x }}` of another trigger   → warn  "is undefined for this trigger"
 *   - `{{ trigger.x }}` of no trigger        → error "is not a recognized trigger field"
 *   - anything else (no var./trigger. prefix)→ error "is not a recognized token"
 */
export function diagnoseTokens(text: string, valid: Set<string>): TokenDiag[] {
  const seen = new Set<string>();
  const out: TokenDiag[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const path = m[1].trim();
    if (path.length === 0 || valid.has(path) || seen.has(path)) continue;
    seen.add(path);
    if (path.startsWith('var.')) {
      out.push({ token: path, severity: 'error', detail: 'does not exist' });
    } else if (path.startsWith('trigger.')) {
      out.push(anyTriggerTokenSet().has(path)
        ? { token: path, severity: 'warn', detail: 'is undefined for this trigger' }
        : { token: path, severity: 'error', detail: 'is not a recognized trigger field' });
    } else {
      out.push({ token: path, severity: 'error', detail: 'is not a recognized token' });
    }
  }
  return out;
}
