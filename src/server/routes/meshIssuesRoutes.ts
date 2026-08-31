/**
 * Mesh Issues Analysis API (#4964, Phase 1 WP4)
 *
 * Mounted at `/api/analysis/mesh-issues`. Read-only and passive: findings are
 * synthesized entirely from rows already on disk by `meshIssuesAnalysisService`
 * (nodes/telemetry/traceroutes), and `POST /run-now` only triggers that same
 * passive read — it emits no radio traffic. There is no TX guard because
 * there is nothing here to guard (see surveyRoutes.ts for the same reasoning).
 *
 * ## Cross-source permission filtering (#3745 leak class)
 *
 * `mesh_issues` is a GLOBAL table (see schema/meshIssues.ts) — findings carry
 * no `sourceId`. But a finding's `evidence`/`sourceIds` name the sources whose
 * rows contributed to it, and a user who can only read source B must not see
 * a finding assembled entirely from source A's data. So `GET /` intersects
 * each finding's stored `sourceIds` with the caller's permitted source set:
 * an empty intersection drops the row entirely; a non-empty intersection is
 * returned as the finding's `sourceIds` (never the full stored list). This
 * uses `resolvePermittedSourceIds()` from `../utils/permittedSources.js` —
 * shared with `analysisRoutes.ts` (#4964 post-epic follow-ups; previously a
 * near-identical private copy per MESH_ISSUES_P1_SPEC.md §2.16 / §5.13).
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { meshIssuesScheduler } from '../services/meshIssuesScheduler.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { MESH_ISSUE_TYPES } from '../services/meshIssues/types.js';
import type {
  MeshIssueSeverity,
  MeshIssueConfidence,
  MeshIssueStatus,
} from '../services/meshIssues/types.js';
import type { DbMeshIssue } from '../../db/repositories/meshIssues.js';
import type { DbNode } from '../../db/types.js';

/**
 * `getAllNodes(ALL_SOURCES)` rows carry a real `sourceId` column at runtime,
 * but it is deliberately absent from the narrower `DbNode` interface — same
 * precedent as `meshIssuesAnalysisService.ts`'s local `NodeRow` type.
 */
type NodeRow = DbNode & { sourceId: string };

const router = Router();
router.use(optionalAuth());

// ── Wire shape (frozen — MESH_ISSUES_P1_SPEC.md §2.16; WP5 codes against this) ─

interface MeshIssueWire {
  id: number;
  issueType: string;
  subjectKey: string;
  nodeNum: number | null;
  nodeName: string | null;
  severity: MeshIssueSeverity;
  confidence: MeshIssueConfidence;
  evidence: Record<string, unknown>;
  sourceIds: string[];
  firstDetected: number;
  lastDetected: number;
  status: MeshIssueStatus;
  /** Phase 3 WP3 — dismiss/restore (§4.1, §4.4). */
  dismissed: boolean;
  dismissedAt: number | null;
}

/**
 * `longName ?? shortName ?? !hex`, resolved server-side from one
 * `getAllNodes(ALL_SOURCES)` call so the report needs no second round trip.
 *
 * Rows are filtered to `permitted` BEFORE any name is picked — the same
 * #3745 leak class the rest of this route guards against. Without this
 * filter a sourceA-only user could be shown a `nodeName` that only ever
 * appeared in a sourceB row: an implicit disclosure of sourceB data this
 * route otherwise redacts. Among the surviving (permitted) rows for a node,
 * the first row with a non-null name wins (deterministic given
 * `getAllNodes`'s row order; a display convenience, not the full
 * newest-wins merge that `nodeSnapshot.ts` does for rule evaluation). A node
 * with no permitted row carrying a name falls back to `!hex` at the call
 * site.
 */
async function buildNodeNameMap(permitted: string[]): Promise<Map<number, string>> {
  // intentional cross-source: resolves a display name for a finding's node
  // regardless of which permitted source most recently reported it.
  const nodes = (await databaseService.nodes.getAllNodes(ALL_SOURCES)) as NodeRow[];
  const map = new Map<number, string>();
  for (const node of nodes) {
    if (!permitted.includes(node.sourceId)) continue;
    if (map.has(node.nodeNum)) continue;
    const name = node.longName || node.shortName || null;
    if (name) map.set(node.nodeNum, name);
  }
  return map;
}

function hexNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

// ── D12: evidence redaction (Phase 3 WP3 §4.3) ────────────────────────────

/** Guards `redactEvidence`'s recursive walk against a pathological shape. */
const EVIDENCE_MAX_DEPTH = 6;

const NODE_NUM_SUFFIX = 'NodeNum';
const NAME_SUFFIX = 'Name';

/**
 * Recursively rewrites `value` (a JSON-shaped tree — object, array, or
 * scalar) so it discloses nothing the caller could not read directly.
 * Two rules, applied at every depth up to `EVIDENCE_MAX_DEPTH`:
 *
 *  1. A key named `sources` holding an array of strings is intersected with
 *     `permitted`.
 *  2. On a plain object, every `<prefix>NodeNum` numeric field (including
 *     the bare `nodeNum` field, prefix `''`) is paired with a sibling
 *     `<prefix>Name` field — `nodeNum`/`name`, `nodeNum`/`longName`, or a
 *     rule-specific pair like `bestSitedNodeNum`/`bestSitedName` or
 *     `coveredByNodeNum`/`coveredByName`. That sibling's value is REPLACED
 *     (never merged) by `nodeNames.get(nodeNum) ?? null`, so an unpermitted
 *     name cannot survive. A `*Name` field with no matching `*NodeNum`
 *     sibling (e.g. `roleName`, or an unrelated `name` field on an object
 *     with no `nodeNum`) is left untouched — it does not carry a node label.
 *
 * Arrays and plain objects are walked; anything else (string, number,
 * boolean, null) is returned as-is. Past the depth cap, the subtree is
 * returned unwalked rather than throwing.
 */
function redactValue(
  value: unknown,
  permitted: string[],
  nodeNames: Map<number, string>,
  depth: number,
): unknown {
  if (depth >= EVIDENCE_MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, permitted, nodeNames, depth + 1));
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Collect every `<prefix>NodeNum` numeric field on this object, keyed by
    // prefix ('' for the bare `nodeNum` field — note the lowercase `n`, which
    // does not match the camelCase `NodeNum` suffix used by prefixed
    // variants like `bestSitedNodeNum`, so it is matched by literal equality
    // instead).
    const nodeNumByPrefix = new Map<string, number>();
    for (const [key, v] of Object.entries(obj)) {
      if (typeof v !== 'number') continue;
      if (key === 'nodeNum') {
        nodeNumByPrefix.set('', v);
      } else if (key.endsWith(NODE_NUM_SUFFIX)) {
        nodeNumByPrefix.set(key.slice(0, key.length - NODE_NUM_SUFFIX.length), v);
      }
    }

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) {
      if (key === 'sources' && Array.isArray(v) && v.every((s) => typeof s === 'string')) {
        out[key] = (v as string[]).filter((s) => permitted.includes(s));
        continue;
      }

      // Rule 2: a name-carrying field paired with a `*NodeNum` sibling.
      // `name`/`longName` pair with the bare `nodeNum` field (prefix '');
      // any other `<prefix>Name` field pairs with `<prefix>NodeNum`.
      let namePrefix: string | null = null;
      if (key === 'name' || key === 'longName') {
        namePrefix = '';
      } else if (key.endsWith(NAME_SUFFIX)) {
        namePrefix = key.slice(0, key.length - NAME_SUFFIX.length);
      }
      if (namePrefix !== null && nodeNumByPrefix.has(namePrefix)) {
        out[key] = nodeNames.get(nodeNumByPrefix.get(namePrefix)!) ?? null;
        continue;
      }

      out[key] = redactValue(v, permitted, nodeNames, depth + 1);
    }
    return out;
  }

  return value;
}

/** See `redactValue` for the two rules. Exported for direct unit testing
 *  (spec §4.3 / §8 — `meshIssuesRoutes.redaction.test.ts`). */
export function redactEvidence(
  evidence: Record<string, unknown>,
  permitted: string[],
  nodeNames: Map<number, string>,
): Record<string, unknown> {
  return redactValue(evidence, permitted, nodeNames, 0) as Record<string, unknown>;
}

/**
 * Parses one stored `DbMeshIssue` row into the wire shape, intersecting its
 * `sourceIds` with the caller's `permitted` set. Returns `null` when the row
 * should be dropped (fail-closed on malformed `sourceIds`, or an empty
 * intersection with `permitted`). Malformed `evidence` never drops the row —
 * it falls back to `{}` (spec §2.16).
 */
function toWireIssue(
  row: DbMeshIssue,
  permitted: string[],
  nodeNames: Map<number, string>,
): MeshIssueWire | null {
  let evidence: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.evidence);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      evidence = parsed as Record<string, unknown>;
    }
  } catch (error) {
    logger.warn(`[mesh-issues] Malformed evidence JSON on issue ${row.id}, falling back to {}:`, error);
  }

  let sourceIds: string[] | null = null;
  try {
    const parsed = JSON.parse(row.sourceIds);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      sourceIds = parsed;
    }
  } catch {
    // fall through — sourceIds stays null
  }
  if (sourceIds === null) {
    logger.warn(`[mesh-issues] Malformed sourceIds JSON on issue ${row.id}, dropping row (fail closed)`);
    return null;
  }

  const intersected = sourceIds.filter((id) => permitted.includes(id));
  if (intersected.length === 0) return null;

  return {
    id: row.id,
    issueType: row.issueType,
    subjectKey: row.subjectKey,
    nodeNum: row.nodeNum,
    nodeName: row.nodeNum != null ? (nodeNames.get(row.nodeNum) ?? hexNodeId(row.nodeNum)) : null,
    severity: row.severity,
    confidence: row.confidence,
    evidence: redactEvidence(evidence, permitted, nodeNames),
    sourceIds: intersected,
    firstDetected: row.firstDetected,
    lastDetected: row.lastDetected,
    status: row.status,
    dismissed: row.dismissed,
    dismissedAt: row.dismissedAt,
  };
}

// ── Wire-level pagination (#4964 post-epic follow-ups) ─────────────────────

const DEFAULT_PAGE_LIMIT = 500;
const MIN_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 2000;

/** `limit` query param: default 500, clamped to [50, 2000]. A missing or
 * non-finite value falls back to the default rather than clamping NaN. */
function parsePageLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? DEFAULT_PAGE_LIMIT), 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(n, MIN_PAGE_LIMIT), MAX_PAGE_LIMIT);
}

/** `offset` query param: default 0, floored at 0. A missing or non-finite
 * value falls back to 0 rather than propagating NaN. */
function parsePageOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? 0), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** critical -> warning -> info, matching `SEVERITY_ORDER` on the frontend
 * (`meshIssueTypes.ts`). */
const SEVERITY_RANK: Record<MeshIssueSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Sorts the FULL filtered set by severity rank, then `lastDetected` desc,
 * then `id` desc as a final tiebreak — the last field is what makes ordering
 * deterministic across identical requests (two findings can share a
 * `lastDetected` millisecond), which in turn is what makes offset-based
 * pagination stable page-to-page.
 */
function sortIssues(issues: MeshIssueWire[]): MeshIssueWire[] {
  return [...issues].sort((a, b) => {
    const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDelta !== 0) return severityDelta;
    const lastDetectedDelta = b.lastDetected - a.lastDetected;
    if (lastDetectedDelta !== 0) return lastDetectedDelta;
    return b.id - a.id;
  });
}

interface MeshIssueCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
  /** Count of the matching set with `dismissed === true`. */
  dismissed: number;
}

/** Computed over whatever set is passed in — the caller decides full vs. filtered. */
function computeCounts(issues: MeshIssueWire[]): MeshIssueCounts {
  return {
    critical: issues.filter((i) => i.severity === 'critical').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
    total: issues.length,
    dismissed: issues.filter((i) => i.dismissed).length,
  };
}

// ── Shared filter parsing (#4964 report reorg WP1, spec §4.1) ──────────────

const ALL_ISSUE_TYPES: readonly string[] = Object.values(MESH_ISSUE_TYPES);
const VALID_SEVERITIES: readonly MeshIssueSeverity[] = ['critical', 'warning', 'info'];
const VALID_TIERS: readonly string[] = ['A', 'B', 'C'];

interface IssueFilterSpec {
  severities: MeshIssueSeverity[] | null;
  tiers: string[] | null; // 'A' | 'B' | 'C'
  issueTypes: string[] | null;
  nodeNum: number | 'none' | null;
  sourceIds: string[] | null; // already intersected with `permitted`
  q: string | null; // lowercased
  includeClosed: boolean;
  includeDismissed: boolean;
}

/** Clamp-never-reject: splits on commas, trims, keeps only tokens present in
 * `valid`. An absent/blank param, or a param whose tokens are ALL unknown,
 * resolves to `null` ("no constraint") rather than an empty-but-present
 * array or a 400. */
function parseCsvFilter<T extends string>(raw: unknown, valid: readonly T[]): T[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const kept = tokens.filter((t): t is T => (valid as readonly string[]).includes(t));
  return kept.length > 0 ? [...new Set(kept)] : null;
}

/** Clamp-never-reject: unknown tokens dropped; an all-unknown list == null
 * (spec §4.1). Applies to both `GET /` and `GET /summary` — the caller is
 * responsible for nulling out the `GET /`-only fields (`issueTypes`,
 * `nodeNum`) before filtering with a `/summary` request's parse result. */
function parseIssueFilters(query: Request['query'], permitted: string[]): IssueFilterSpec {
  const severities = parseCsvFilter(query.severity, VALID_SEVERITIES);
  const tiers = parseCsvFilter(query.tier, VALID_TIERS);
  const issueTypes = parseCsvFilter(query.issueType, ALL_ISSUE_TYPES);

  let nodeNum: number | 'none' | null = null;
  if (typeof query.nodeNum === 'string') {
    if (query.nodeNum === 'none') {
      nodeNum = 'none';
    } else {
      const n = Number(query.nodeNum);
      if (Number.isInteger(n)) nodeNum = n;
    }
  }

  const requestedSources = parseSourcesParam(query.sources);
  let sourceIds: string[] | null = null;
  if (requestedSources) {
    const intersected = requestedSources.filter((s) => permitted.includes(s));
    sourceIds = intersected.length > 0 ? intersected : null;
  }

  const q = typeof query.q === 'string' && query.q.trim() !== '' ? query.q.trim().toLowerCase() : null;

  return {
    severities,
    tiers,
    issueTypes,
    nodeNum,
    sourceIds,
    q,
    includeClosed: query.includeClosed === 'true',
    includeDismissed: query.includeDismissed === 'true',
  };
}

/**
 * Applied AFTER `toWireIssue` (so it sees redacted sourceIds and the
 * resolved `nodeName`), BEFORE counts/total/sort/slice. Every dimension with
 * a `null` value in `f` is "no constraint" — matches everything.
 */
function matchesFilters(issue: MeshIssueWire, f: IssueFilterSpec): boolean {
  if (f.severities && !f.severities.includes(issue.severity)) return false;
  if (f.tiers && !f.tiers.includes(issue.issueType.charAt(0))) return false;
  if (f.issueTypes && !f.issueTypes.includes(issue.issueType)) return false;
  if (f.nodeNum === 'none') {
    if (issue.nodeNum !== null) return false;
  } else if (typeof f.nodeNum === 'number') {
    if (issue.nodeNum !== f.nodeNum) return false;
  }
  if (f.sourceIds && !issue.sourceIds.some((s) => f.sourceIds!.includes(s))) return false;
  if (f.q) {
    const nodeNameLower = issue.nodeName?.toLowerCase() ?? '';
    const subjectKeyLower = issue.subjectKey.toLowerCase();
    if (!nodeNameLower.includes(f.q) && !subjectKeyLower.includes(f.q)) return false;
  }
  return true;
}

// ── Summary (#4964 report reorg WP1, spec §4.3) ─────────────────────────────

export interface MeshIssueTypeSummary {
  issueType: string;
  total: number;
  bySeverity: { critical: number; warning: number; info: number };
  /** Highest severity present. `null` only if total === 0 (never emitted). */
  worstSeverity: MeshIssueSeverity;
  dismissed: number;
  /** Newest `lastDetected` across this type's findings. */
  latestDetected: number;
}

export interface MeshIssueNodeSummary {
  /** `null` == the Mesh-wide pseudo-group (spec §6.3). */
  nodeNum: number | null;
  /** `longName ?? shortName ?? !hex`; `null` for the Mesh-wide group. */
  nodeName: string | null;
  total: number;
  bySeverity: { critical: number; warning: number; info: number };
  worstSeverity: MeshIssueSeverity;
  /** Distinct issue types under this node, ordered worst-severity-first then
   *  lexicographic. Drives the badge row. */
  issueTypes: string[];
  latestDetected: number;
}

export interface MeshIssuesSummary {
  byType: MeshIssueTypeSummary[]; // only types with total > 0
  byNode: MeshIssueNodeSummary[]; // ranked; see spec §6.3
  counts: MeshIssueCounts; // same shape as GET /
  total: number; // === counts.total
  sourceNames: Record<string, string>;
}

function worstSeverityOf(bySeverity: { critical: number; warning: number; info: number }): MeshIssueSeverity {
  if (bySeverity.critical > 0) return 'critical';
  if (bySeverity.warning > 0) return 'warning';
  return 'info';
}

/**
 * Pure aggregation, unit-tested directly (`meshIssuesRoutes.test.ts`). Never
 * touches `evidence` — the summary payload has no field for it.
 *
 * `byType` ordering: worst-severity rank, then `total` desc, then `issueType`
 * asc. `byNode` ordering: the Mesh-wide (`nodeNum: null`) group pinned first,
 * then worst-severity rank, then `total` desc, then `latestDetected` desc,
 * then `nodeNum` asc as a deterministic tiebreak (spec §6.3).
 */
export function buildSummary(issues: MeshIssueWire[], sourceNames: Record<string, string>): MeshIssuesSummary {
  const byTypeAgg = new Map<
    string,
    { bySeverity: { critical: number; warning: number; info: number }; dismissed: number; latestDetected: number }
  >();
  const byNodeAgg = new Map<
    number | null,
    {
      nodeName: string | null;
      bySeverity: { critical: number; warning: number; info: number };
      typeWorst: Map<string, MeshIssueSeverity>;
      latestDetected: number;
    }
  >();

  for (const issue of issues) {
    let t = byTypeAgg.get(issue.issueType);
    if (!t) {
      t = { bySeverity: { critical: 0, warning: 0, info: 0 }, dismissed: 0, latestDetected: 0 };
      byTypeAgg.set(issue.issueType, t);
    }
    t.bySeverity[issue.severity]++;
    if (issue.dismissed) t.dismissed++;
    if (issue.lastDetected > t.latestDetected) t.latestDetected = issue.lastDetected;

    let n = byNodeAgg.get(issue.nodeNum);
    if (!n) {
      n = {
        nodeName: issue.nodeNum === null ? null : issue.nodeName,
        bySeverity: { critical: 0, warning: 0, info: 0 },
        typeWorst: new Map(),
        latestDetected: 0,
      };
      byNodeAgg.set(issue.nodeNum, n);
    }
    n.bySeverity[issue.severity]++;
    const existingWorst = n.typeWorst.get(issue.issueType);
    if (!existingWorst || SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existingWorst]) {
      n.typeWorst.set(issue.issueType, issue.severity);
    }
    if (issue.lastDetected > n.latestDetected) n.latestDetected = issue.lastDetected;
  }

  const byType: MeshIssueTypeSummary[] = Array.from(byTypeAgg.entries()).map(([issueType, v]) => {
    const total = v.bySeverity.critical + v.bySeverity.warning + v.bySeverity.info;
    return {
      issueType,
      total,
      bySeverity: v.bySeverity,
      worstSeverity: worstSeverityOf(v.bySeverity),
      dismissed: v.dismissed,
      latestDetected: v.latestDetected,
    };
  });
  byType.sort((a, b) => {
    const rankDelta = SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity];
    if (rankDelta !== 0) return rankDelta;
    const totalDelta = b.total - a.total;
    if (totalDelta !== 0) return totalDelta;
    return a.issueType.localeCompare(b.issueType);
  });

  const byNode: MeshIssueNodeSummary[] = Array.from(byNodeAgg.entries()).map(([nodeNum, v]) => {
    const total = v.bySeverity.critical + v.bySeverity.warning + v.bySeverity.info;
    const issueTypes = Array.from(v.typeWorst.entries())
      .sort(([aType, aSev], [bType, bSev]) => {
        const rankDelta = SEVERITY_RANK[aSev] - SEVERITY_RANK[bSev];
        if (rankDelta !== 0) return rankDelta;
        return aType.localeCompare(bType);
      })
      .map(([type]) => type);
    return {
      nodeNum,
      nodeName: v.nodeName,
      total,
      bySeverity: v.bySeverity,
      worstSeverity: worstSeverityOf(v.bySeverity),
      issueTypes,
      latestDetected: v.latestDetected,
    };
  });
  byNode.sort((a, b) => {
    if (a.nodeNum === null && b.nodeNum !== null) return -1;
    if (a.nodeNum !== null && b.nodeNum === null) return 1;
    const rankDelta = SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity];
    if (rankDelta !== 0) return rankDelta;
    const totalDelta = b.total - a.total;
    if (totalDelta !== 0) return totalDelta;
    const latestDelta = b.latestDetected - a.latestDetected;
    if (latestDelta !== 0) return latestDelta;
    return (a.nodeNum ?? 0) - (b.nodeNum ?? 0);
  });

  const counts = computeCounts(issues);
  return { byType, byNode, counts, total: counts.total, sourceNames };
}

// ── Bulk dismiss/restore scope parsing (#4964 report reorg WP1, spec §4.4) ──

export type MeshIssueBulkScope =
  | { scope: 'issueType'; issueType: string }
  | { scope: 'node'; nodeNum: number | null };

function parseBulkScope(
  body: unknown,
): { ok: true; scope: MeshIssueBulkScope } | { ok: false; code: 'INVALID_BULK_SCOPE' | 'INVALID_ISSUE_TYPE' } {
  if (!body || typeof body !== 'object') return { ok: false, code: 'INVALID_BULK_SCOPE' };
  const b = body as Record<string, unknown>;

  if (b.scope === 'issueType') {
    if (typeof b.issueType !== 'string') return { ok: false, code: 'INVALID_BULK_SCOPE' };
    if (!ALL_ISSUE_TYPES.includes(b.issueType)) return { ok: false, code: 'INVALID_ISSUE_TYPE' };
    return { ok: true, scope: { scope: 'issueType', issueType: b.issueType } };
  }

  if (b.scope === 'node') {
    if (b.nodeNum === null) return { ok: true, scope: { scope: 'node', nodeNum: null } };
    if (typeof b.nodeNum === 'number' && Number.isInteger(b.nodeNum)) {
      return { ok: true, scope: { scope: 'node', nodeNum: b.nodeNum } };
    }
    return { ok: false, code: 'INVALID_BULK_SCOPE' };
  }

  return { ok: false, code: 'INVALID_BULK_SCOPE' };
}

/**
 * Shared body for `/bulk/dismiss` and `/bulk/restore` (spec §4.4).
 *
 * Flow: resolve `permitted` -> 403 if empty -> parse scope -> read every row
 * (`getMeshIssuesAsync({includeClosed:true, includeDismissed:true})`, the
 * same read `GET /` already does, bounded by the finding count) -> keep rows
 * matching the scope AND passing the `toWireIssue` visibility test AND whose
 * current `dismissed !== target` -> `setMeshIssueDismissedForIdsAsync` ->
 * audit (awaited — the count matters) -> `ok(res, { affected })`.
 *
 * No new repository *read* method: reusing the existing full read keeps one
 * visibility code path and cannot drift from `GET /`. The response never
 * reports a `skipped` count — see spec §4.4/§12.2 (the #3745 leak class).
 */
async function handleBulkDismissOrRestore(
  req: Request,
  res: Response,
  dismissed: boolean,
  auditAction: 'mesh_issue_bulk_dismiss' | 'mesh_issue_bulk_restore',
): Promise<void> {
  const allSources = await databaseService.sources.getAllSources();
  const permitted = await resolvePermittedSourceIds(req, 'nodes', allSources);
  if (permitted.length === 0) {
    fail(res, 403, 'NO_PERMITTED_SOURCES', 'No sources readable by this user');
    return;
  }

  const parsed = parseBulkScope(req.body);
  if (!parsed.ok) {
    fail(
      res,
      400,
      parsed.code,
      parsed.code === 'INVALID_ISSUE_TYPE' ? 'Unknown issue type' : 'Invalid bulk scope',
    );
    return;
  }
  const { scope } = parsed;

  const [rows, nodeNames] = await Promise.all([
    databaseService.getMeshIssuesAsync({ includeClosed: true, includeDismissed: true }),
    buildNodeNameMap(permitted),
  ]);

  const ids: number[] = [];
  for (const row of rows) {
    if (scope.scope === 'issueType' && row.issueType !== scope.issueType) continue;
    if (scope.scope === 'node' && row.nodeNum !== scope.nodeNum) continue;
    if (row.dismissed === dismissed) continue; // already at target state — idempotent no-op
    const wire = toWireIssue(row, permitted, nodeNames);
    if (!wire) continue; // not visible to this caller (empty sourceIds intersection)
    ids.push(row.id);
  }

  const affected = await databaseService.setMeshIssueDismissedForIdsAsync(ids, dismissed, req.user!.id, Date.now());

  const scopeLabel =
    scope.scope === 'issueType' ? scope.issueType : scope.nodeNum === null ? 'Mesh-wide' : `node ${scope.nodeNum}`;
  await databaseService.auditLogAsync(
    req.user!.id,
    auditAction,
    'settings',
    `${dismissed ? 'Dismissed' : 'Restored'} ${affected} mesh issue(s) (${scopeLabel})`,
    req.ip || null,
    null,
    JSON.stringify({ scope, affected }),
  );

  ok(res, { affected });
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/analysis/mesh-issues?includeClosed=true&includeDismissed=true&limit=500&offset=0
 *
 * Dismissed findings are excluded by default; `includeDismissed=true` (Phase
 * 3 WP3) includes them, styled/actioned client-side via the `dismissed` /
 * `dismissedAt` wire fields. `counts` and the new `total` are computed over
 * the FULL filtered (post-permission) set — not the page — so a client can
 * render accurate severity totals while only holding one page of cards
 * (spec: #4964 post-epic follow-ups). `counts.dismissed` keeps its Phase 3
 * meaning: the count of matching rows with `dismissed === true` (P3-D12: the
 * other three counters keep their Phase 1 meaning).
 *
 * `issues` is `sortIssues(full set).slice(offset, offset + limit)` —
 * deterministic ordering (severity, then `lastDetected` desc, then `id` desc)
 * makes repeated/paginated requests stable even when two findings tie on
 * `lastDetected`. `limit` defaults to 500 and clamps to [50, 2000]; `offset`
 * defaults to 0 and floors at 0; an offset past the end of the full set
 * returns an empty `issues` array with `total` still reporting the full
 * count.
 *
 * `sourceNames` is built from the single `getAllSources()` call this handler
 * already needs for `resolvePermittedSourceIds` (hoisted and shared — no
 * second query), restricted to permitted sources only.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const allSources = await databaseService.sources.getAllSources();
    const permitted = await resolvePermittedSourceIds(req, 'nodes', allSources);
    if (permitted.length === 0) {
      return fail(res, 403, 'NO_PERMITTED_SOURCES', 'No sources readable by this user');
    }

    const filters = parseIssueFilters(req.query, permitted);
    const limit = parsePageLimit(req.query.limit);
    const offset = parsePageOffset(req.query.offset);
    const [rows, nodeNames] = await Promise.all([
      databaseService.getMeshIssuesAsync({
        includeClosed: filters.includeClosed,
        includeDismissed: filters.includeDismissed,
      }),
      buildNodeNameMap(permitted),
    ]);

    const fullSet: MeshIssueWire[] = [];
    for (const row of rows) {
      const wire = toWireIssue(row, permitted, nodeNames);
      if (wire) fullSet.push(wire);
    }

    const filteredSet = fullSet.filter((issue) => matchesFilters(issue, filters));
    const counts = computeCounts(filteredSet);

    const issues = sortIssues(filteredSet).slice(offset, offset + limit);

    const sourceNames: Record<string, string> = {};
    for (const s of allSources) {
      if (permitted.includes(s.id)) sourceNames[s.id] = s.name;
    }

    ok(res, { issues, counts, sourceNames, total: filteredSet.length, limit, offset });
  } catch (error) {
    logger.error('[API] Error fetching mesh issues:', error);
    fail(res, 500, 'MESH_ISSUES_FETCH_FAILED', 'Failed to fetch mesh issues');
  }
});

/**
 * GET /api/analysis/mesh-issues/summary
 *
 * Same `403 NO_PERMITTED_SOURCES` gate as `GET /`. Accepts the shared §4.1
 * filters EXCEPT `issueType`/`nodeNum` — those are the dimensions the tiles
 * and node groups themselves represent, so filtering by them would be
 * circular and would empty the dashboard the moment a tile is clicked
 * (spec §4.3). `issueTypes`/`nodeNum` are explicitly nulled out of the
 * parsed filter spec below even if a client sends them. Never returns
 * `evidence` anywhere in the payload.
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const allSources = await databaseService.sources.getAllSources();
    const permitted = await resolvePermittedSourceIds(req, 'nodes', allSources);
    if (permitted.length === 0) {
      return fail(res, 403, 'NO_PERMITTED_SOURCES', 'No sources readable by this user');
    }

    const filters = parseIssueFilters(req.query, permitted);
    filters.issueTypes = null;
    filters.nodeNum = null;

    const [rows, nodeNames] = await Promise.all([
      databaseService.getMeshIssuesAsync({
        includeClosed: filters.includeClosed,
        includeDismissed: filters.includeDismissed,
      }),
      buildNodeNameMap(permitted),
    ]);

    const fullSet: MeshIssueWire[] = [];
    for (const row of rows) {
      const wire = toWireIssue(row, permitted, nodeNames);
      if (wire) fullSet.push(wire);
    }
    const filteredSet = fullSet.filter((issue) => matchesFilters(issue, filters));

    const sourceNames: Record<string, string> = {};
    for (const s of allSources) {
      if (permitted.includes(s.id)) sourceNames[s.id] = s.name;
    }

    ok(res, buildSummary(filteredSet, sourceNames));
  } catch (error) {
    logger.error('[API] Error building mesh issues summary:', error);
    fail(res, 500, 'MESH_ISSUES_SUMMARY_FAILED', 'Failed to build mesh issues summary');
  }
});

/**
 * GET /api/analysis/mesh-issues/status
 *
 * Same permitted-sources gate as GET / — a user with no readable sources
 * cannot see scheduler status either.
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req, 'nodes');
    if (permitted.length === 0) {
      return fail(res, 403, 'NO_PERMITTED_SOURCES', 'No sources readable by this user');
    }

    ok(res, await meshIssuesScheduler.getStatus());
  } catch (error) {
    logger.error('[API] Error fetching mesh issues status:', error);
    fail(res, 500, 'MESH_ISSUES_STATUS_FAILED', 'Failed to fetch mesh issues status');
  }
});

/**
 * POST /api/analysis/mesh-issues/run-now
 *
 * Matches `/api/settings/position-estimation/run-now` — the closest
 * precedent for "trigger a global batch job". No new rate limiter: the
 * global `apiLimiter` already wraps `/api`, and the scheduler's `runLock`
 * makes concurrent runs impossible. Sends no packets, so the mesh-impact
 * checklist adds no cap here.
 */
router.post('/run-now', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    const result = await meshIssuesScheduler.runNow();
    void databaseService.auditLogAsync(
      req.user!.id,
      'mesh_issues_run',
      'settings',
      `Ran mesh issues analysis: ${result.findingCount} finding(s)`,
      req.ip || null,
      null,
      JSON.stringify(result),
    );
    ok(res, result);
  } catch (error) {
    if (error instanceof Error && /in progress/.test(error.message)) {
      return fail(res, 409, 'MESH_ISSUES_RUN_IN_PROGRESS', 'Mesh issues analysis already in progress');
    }
    logger.error('[API] Error running mesh issues analysis:', error);
    fail(res, 500, 'MESH_ISSUES_RUN_FAILED', 'Failed to run mesh issues analysis');
  }
});

function parseIssueId(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Shared body for `/dismiss` and `/restore` (Phase 3 WP3, spec §4.4).
 *
 * `mesh_issues` is a GLOBAL table with no `sourceId`, so this cannot be
 * `nodes:write` scoped like every other node-write call site — see P3-D7 in
 * MESH_ISSUES_P3_SPEC.md for the full justification. `settings:write` gates
 * the mutation (matching `POST /run-now` above and
 * `PositionEstimationSection`'s `run-now`), and the visibility check below
 * is defence in depth: `settings:write` alone does not imply the caller can
 * even see this finding's sources, so before mutating we intersect the row's
 * stored `sourceIds` with the caller's permitted set and 404 on empty — the
 * same 200/404 distinction the rest of this router uses to avoid confirming
 * the existence of a finding the caller cannot read (#3745 leak class).
 */
async function handleDismissOrRestore(
  req: Request,
  res: Response,
  dismissed: boolean,
  auditAction: 'mesh_issue_dismiss' | 'mesh_issue_restore',
): Promise<void> {
  const id = parseIssueId(req.params.id);
  if (id === null) {
    fail(res, 400, 'INVALID_ISSUE_ID', 'Invalid mesh issue id');
    return;
  }

  const row = await databaseService.getMeshIssueByIdAsync(id);
  if (!row) {
    fail(res, 404, 'MESH_ISSUE_NOT_FOUND', 'No mesh issue with that id');
    return;
  }

  let sourceIds: string[] = [];
  try {
    const parsed = JSON.parse(row.sourceIds);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) sourceIds = parsed;
  } catch {
    // malformed sourceIds -> empty -> intersection empty -> 404 below (fail closed)
  }

  const permitted = await resolvePermittedSourceIds(req, 'nodes');
  const visible = sourceIds.some((s) => permitted.includes(s));
  if (!visible) {
    fail(res, 404, 'MESH_ISSUE_NOT_FOUND', 'No mesh issue with that id');
    return;
  }

  await databaseService.setMeshIssueDismissedAsync(id, dismissed, req.user!.id, Date.now());
  void databaseService.auditLogAsync(
    req.user!.id,
    auditAction,
    'settings',
    `${dismissed ? 'Dismissed' : 'Restored'} mesh issue ${id} (${row.issueType})`,
    req.ip || null,
    null,
    null,
  );
  ok(res);
}

/**
 * POST /api/analysis/mesh-issues/bulk/dismiss
 * POST /api/analysis/mesh-issues/bulk/restore
 *
 * Declarative-scope bulk mutation (spec §4.4) — NOT an id array. See
 * `handleBulkDismissOrRestore` above for the full flow and the partial-
 * visibility semantics (#3745 leak class: a caller only ever affects
 * findings they can see; the response never discloses how many more exist).
 *
 * MUST be registered before `/:id/dismiss` and `/:id/restore` below —
 * `/bulk/dismiss` would otherwise match `/:id/dismiss` first with
 * `id: 'bulk'` and 400 on `INVALID_ISSUE_ID`.
 */
router.post('/bulk/dismiss', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    await handleBulkDismissOrRestore(req, res, true, 'mesh_issue_bulk_dismiss');
  } catch (error) {
    logger.error('[API] Error bulk dismissing mesh issues:', error);
    fail(res, 500, 'MESH_ISSUE_BULK_DISMISS_FAILED', 'Failed to bulk dismiss mesh issues');
  }
});

router.post('/bulk/restore', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    await handleBulkDismissOrRestore(req, res, false, 'mesh_issue_bulk_restore');
  } catch (error) {
    logger.error('[API] Error bulk restoring mesh issues:', error);
    fail(res, 500, 'MESH_ISSUE_BULK_RESTORE_FAILED', 'Failed to bulk restore mesh issues');
  }
});

/**
 * POST /api/analysis/mesh-issues/:id/dismiss
 *
 * Global — hides the finding for every user. See `handleDismissOrRestore`.
 */
router.post('/:id/dismiss', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    await handleDismissOrRestore(req, res, true, 'mesh_issue_dismiss');
  } catch (error) {
    logger.error('[API] Error dismissing mesh issue:', error);
    fail(res, 500, 'MESH_ISSUE_DISMISS_FAILED', 'Failed to dismiss mesh issue');
  }
});

/** POST /api/analysis/mesh-issues/:id/restore — undo a dismissal. */
router.post('/:id/restore', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    await handleDismissOrRestore(req, res, false, 'mesh_issue_restore');
  } catch (error) {
    logger.error('[API] Error restoring mesh issue:', error);
    fail(res, 500, 'MESH_ISSUE_RESTORE_FAILED', 'Failed to restore mesh issue');
  }
});

export default router;
