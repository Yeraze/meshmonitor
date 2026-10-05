/**
 * `{{ }}` token hinting for builder text fields (#3653 follow-up).
 *
 * Classifies each `{{ trigger.* }}` / `{{ node.* }}` / `{{ var.* }}` / `{{ NOW }}`
 * token so the editor can highlight it and catch typos:
 *   - 'ok'      valid for the CURRENT trigger (or a known var / NOW)
 *   - 'foreign' a real token, but it belongs to a DIFFERENT trigger (it'll
 *               render blank here) — not a typo, just not available
 *   - 'bad'     unrecognized everywhere → likely a typo
 */
import {
  TRIGGER_TOKENS,
  UNIVERSAL_TOKENS,
} from './SubstitutionsHelp';
import { NODE_TOKENS, SUBJECT_NODE_TRIGGER_TYPES } from './substitutionNodeTokens';
import { stepOutputRefProblem, stepOutputProblemDetail } from '../../types/automation';

// Mirrors the engine's interpolate TOKEN regex.
const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export type TokenStatus = 'ok' | 'foreign' | 'bad';

const SUBJECT_NODE_SET = new Set<string>(SUBJECT_NODE_TRIGGER_TYPES);

/** Valid token paths for a trigger type + the defined variables (the 'ok' set). */
export function validTokenSet(triggerType: string, variableNames: string[]): Set<string> {
  const set = new Set<string>(['NOW']);
  for (const [k] of TRIGGER_TOKENS[triggerType] ?? []) set.add(`trigger.${k}`);
  for (const [k] of UNIVERSAL_TOKENS) set.add(`trigger.${k}`);
  if (SUBJECT_NODE_SET.has(triggerType)) {
    for (const [k] of NODE_TOKENS) set.add(`node.${k}`);
  }
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

/** Every known `node.*` path — valid on subject-node triggers, foreign elsewhere. */
let anyNodeCache: Set<string> | null = null;
export function anyNodeTokenSet(): Set<string> {
  if (anyNodeCache) return anyNodeCache;
  anyNodeCache = new Set(NODE_TOKENS.map(([k]) => `node.${k}`));
  return anyNodeCache;
}

/**
 * Run outputs (#5636) the field's own step can read through `{{ steps.* }}`:
 * `guaranteed` are stored by a step that always runs first, `possible` by one
 * that runs first on some path, `all` is every name in the automation.
 * `'refused'` marks a field that takes `{{ var.* }}` only. Absent (a field
 * outside the builder) means no step outputs exist.
 */
export type StepTokenScope =
  | { guaranteed: ReadonlySet<string>; possible: ReadonlySet<string>; all: ReadonlySet<string> }
  | 'refused';

const NO_STEP_NAMES: ReadonlySet<string> = new Set<string>();

/** What is wrong with a `steps.*` token path, or null when it will resolve. */
export function stepTokenProblem(path: string, steps?: StepTokenScope): { severity: TokenSeverity; detail: string } | null {
  if (steps === 'refused') return { severity: 'error', detail: 'is always empty: this field takes {{ var.* }} only' };
  const [, name = '', head, ...rest] = path.split('.');
  if (name.length === 0 || (head !== 'output' && !(head === 'ok' && rest.length === 0))) {
    return { severity: 'error', detail: 'is always empty: write steps.NAME.output or steps.NAME.ok' };
  }
  const problem = stepOutputRefProblem(
    name,
    steps ? { guaranteed: new Set(steps.guaranteed), possible: new Set(steps.possible) } : undefined,
    steps?.all ?? NO_STEP_NAMES,
  );
  if (!problem) return null;
  return { severity: problem === 'maybe' ? 'warn' : 'error', detail: stepOutputProblemDetail(problem, name) };
}

/** Classify a single token path against the current-trigger valid set. */
export function classifyToken(path: string, valid: Set<string>, steps?: StepTokenScope): TokenStatus {
  if (path.length === 0 || valid.has(path)) return 'ok';
  if (path.startsWith('steps.')) {
    const problem = stepTokenProblem(path, steps);
    return problem === null ? 'ok' : problem.severity === 'warn' ? 'foreign' : 'bad';
  }
  if (path.startsWith('trigger.') && anyTriggerTokenSet().has(path)) return 'foreign';
  if (path.startsWith('node.') && anyNodeTokenSet().has(path)) return 'foreign';
  return 'bad';
}

export interface TokenSegment { text: string; token: boolean; status: TokenStatus }

/** Split text into plain + token segments for highlighting. */
export function tokenize(text: string, valid: Set<string>, steps?: StepTokenScope): TokenSegment[] {
  const segs: TokenSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) segs.push({ text: text.slice(last, start), token: false, status: 'ok' });
    const path = m[1].trim();
    segs.push({ text: m[0], token: path.length > 0, status: classifyToken(path, valid, steps) });
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
 *   - `{{ node.x }}` with no subject node    → warn  "needs a subject-node trigger"
 *   - `{{ node.x }}` unknown prop            → error "is not a recognized node field"
 *   - `{{ steps.x.output }}` never stored before this step → error "is always empty"
 *   - `{{ steps.x.output }}` stored on only some paths     → warn  "may be empty"
 *   - anything else                          → error "is not a recognized token"
 */
export function diagnoseTokens(text: string, valid: Set<string>, steps?: StepTokenScope): TokenDiag[] {
  const seen = new Set<string>();
  const out: TokenDiag[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const path = m[1].trim();
    if (path.length === 0 || valid.has(path) || seen.has(path)) continue;
    seen.add(path);
    if (path.startsWith('steps.')) {
      const problem = stepTokenProblem(path, steps);
      if (problem) out.push({ token: path, ...problem });
    } else if (path.startsWith('var.')) {
      out.push({ token: path, severity: 'error', detail: 'does not exist' });
    } else if (path.startsWith('trigger.')) {
      out.push(anyTriggerTokenSet().has(path)
        ? { token: path, severity: 'warn', detail: 'is undefined for this trigger' }
        : { token: path, severity: 'error', detail: 'is not a recognized trigger field' });
    } else if (path.startsWith('node.')) {
      out.push(anyNodeTokenSet().has(path)
        ? { token: path, severity: 'warn', detail: 'needs a subject-node trigger' }
        : { token: path, severity: 'error', detail: 'is not a recognized node field' });
    } else {
      out.push({ token: path, severity: 'error', detail: 'is not a recognized token' });
    }
  }
  return out;
}
