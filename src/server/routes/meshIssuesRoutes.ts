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
 * mirrors `resolvePermittedSourceIds()` in `analysisRoutes.ts`, copied below
 * rather than exported/refactored — see MESH_ISSUES_P1_SPEC.md §2.16 / §5.13.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { meshIssuesScheduler } from '../services/meshIssuesScheduler.js';
import type {
  MeshIssueSeverity,
  MeshIssueConfidence,
  MeshIssueStatus,
} from '../services/meshIssues/types.js';
import type { DbMeshIssue } from '../../db/repositories/meshIssues.js';
import type { Source } from '../../db/repositories/sources.js';
import type { DbNode } from '../../db/types.js';

/**
 * `getAllNodes(ALL_SOURCES)` rows carry a real `sourceId` column at runtime,
 * but it is deliberately absent from the narrower `DbNode` interface — same
 * precedent as `meshIssuesAnalysisService.ts`'s local `NodeRow` type.
 */
type NodeRow = DbNode & { sourceId: string };

const router = Router();
router.use(optionalAuth());

// ── Copied from analysisRoutes.ts (module-private there; MESH_ISSUES_P1_SPEC.md
// §2.16 explicitly directs copying rather than refactoring that 1000+ line file
// in this phase) ─────────────────────────────────────────────────────────────

/**
 * `allSourcesIn` lets a caller that already fetched `getAllSources()` (Phase 3
 * WP3's `sourceNames` map, §4.1) share that single query rather than paying
 * for a second round trip here.
 */
async function resolvePermittedSourceIds(
  req: Request,
  resource: string = 'nodes',
  allSourcesIn?: Source[],
): Promise<string[]> {
  const user = req.user;
  const isAdmin = user?.isAdmin ?? false;
  const allSources = allSourcesIn ?? (await databaseService.sources.getAllSources());
  const enabled = allSources.filter((s) => s.enabled !== false);

  if (isAdmin) return enabled.map((s) => s.id);

  const checks = await Promise.all(
    enabled.map(async (s) => {
      const ok = user
        ? await databaseService.checkPermissionAsync(user.id, resource, 'read', s.id)
        : await databaseService.checkPermissionAsync(0, resource, 'read', s.id);
      return ok ? s.id : null;
    }),
  );
  return checks.filter((id): id is string => id !== null);
}

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

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/analysis/mesh-issues?includeClosed=true&includeDismissed=true
 *
 * Dismissed findings are excluded by default; `includeDismissed=true` (Phase
 * 3 WP3) includes them, styled/actioned client-side via the `dismissed` /
 * `dismissedAt` wire fields. `counts` is computed over the returned
 * (post-filter) set and gains `dismissed` — the count of returned rows with
 * `dismissed === true` (spec §4.1 / P3-D12: the other three counters keep
 * their Phase 1 meaning).
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

    const includeClosed = req.query.includeClosed === 'true';
    const includeDismissed = req.query.includeDismissed === 'true';
    const [rows, nodeNames] = await Promise.all([
      databaseService.getMeshIssuesAsync({ includeClosed, includeDismissed }),
      buildNodeNameMap(permitted),
    ]);

    const issues: MeshIssueWire[] = [];
    for (const row of rows) {
      const wire = toWireIssue(row, permitted, nodeNames);
      if (wire) issues.push(wire);
    }

    const counts = {
      critical: issues.filter((i) => i.severity === 'critical').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
      total: issues.length,
      dismissed: issues.filter((i) => i.dismissed).length,
    };

    const sourceNames: Record<string, string> = {};
    for (const s of allSources) {
      if (permitted.includes(s.id)) sourceNames[s.id] = s.name;
    }

    ok(res, { issues, counts, sourceNames });
  } catch (error) {
    logger.error('[API] Error fetching mesh issues:', error);
    fail(res, 500, 'MESH_ISSUES_FETCH_FAILED', 'Failed to fetch mesh issues');
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
