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

async function resolvePermittedSourceIds(
  req: Request,
  resource: string = 'nodes',
): Promise<string[]> {
  const user = req.user;
  const isAdmin = user?.isAdmin ?? false;
  const allSources = await databaseService.sources.getAllSources();
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
    evidence,
    sourceIds: intersected,
    firstDetected: row.firstDetected,
    lastDetected: row.lastDetected,
    status: row.status,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/analysis/mesh-issues?includeClosed=true
 *
 * Dismissed findings are always excluded in Phase 1 (no dismiss UI yet —
 * that's Phase 3). `counts` is computed over the returned (post-filter) set.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req, 'nodes');
    if (permitted.length === 0) {
      return fail(res, 403, 'NO_PERMITTED_SOURCES', 'No sources readable by this user');
    }

    const includeClosed = req.query.includeClosed === 'true';
    const [rows, nodeNames] = await Promise.all([
      databaseService.getMeshIssuesAsync({ includeClosed, includeDismissed: false }),
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
    };

    ok(res, { issues, counts });
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

export default router;
