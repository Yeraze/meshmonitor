/**
 * NodeInfo Enrichment — shared route handlers.
 *
 * One handler pair, mounted identically by `nodesRoutes.ts` (legacy /api
 * surface) and `v1/nodes.ts` (`/api/v1/nodes` + `/api/v1/sources/:sourceId/nodes`),
 * rather than duplicating the handler body across both routers the way the
 * older `copy-candidates`/`copy-nodeinfo` routes do. See
 * docs/internal/dev-notes/NODEINFO_ENRICHMENT_PHASE1_SPEC.md §2c.
 *
 * No existing cross-router (top-level `routes/` + `routes/v1/`) shared-handler
 * location was found — `meshcoreRouteShared.ts` is the closest precedent, but
 * it's used only within the flat `routes/meshcore*.ts` family. A new `shared/`
 * subdirectory is used here per the spec.
 */
import { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { ok, fail } from '../../utils/apiResponse.js';
import {
  analyzeEnrichment,
  applyEnrichment,
  type EnrichmentApplyItem,
} from '../../services/nodeInfoEnrichmentService.js';

/** Shape of one raw (unvalidated) item from the request body. */
interface RawApplyItem {
  nodeNum?: unknown;
  targetSourceId?: unknown;
  donorSourceId?: unknown;
}

/**
 * GET .../enrichment/analysis
 *
 * Read-only. Computes the source universe the caller may read from — admins
 * see every source; everyone else is restricted to sources they hold
 * `nodes:read` on (an anonymous/unauthenticated caller has none, so the
 * response is `{ nodes: [], summary: { nodeCount:0, targetCount:0, fieldCount:0 } }`,
 * never a 403 — analysis is always safe to call, it just narrows scope).
 */
export async function handleEnrichmentAnalysis(req: Request, res: Response): Promise<Response> {
  try {
    const user = (req as any).user;
    const userId: number | null = user?.id ?? null;
    const isAdmin: boolean = user?.isAdmin ?? false;

    // undefined = no restriction (admin path); analyzeEnrichment treats
    // undefined as "all sources".
    let readableSourceIds: string[] | undefined;
    if (!isAdmin) {
      const allSources = await databaseService.sources.getAllSources();
      const readable: string[] = [];
      for (const source of allSources) {
        const canRead = userId !== null
          && await databaseService.checkPermissionAsync(userId, 'nodes', 'read', source.id);
        if (canRead) readable.push(source.id);
      }
      readableSourceIds = readable;
    }

    const analysis = await analyzeEnrichment(readableSourceIds);
    return ok(res, analysis);
  } catch (error) {
    logger.error('Error analyzing NodeInfo enrichment:', error);
    return fail(res, 500, 'ENRICHMENT_ANALYSIS_FAILED', 'Failed to analyze enrichment');
  }
}

/**
 * POST .../enrichment/apply
 *
 * Write, fail-closed over the whole batch:
 *  - `items` must be a non-empty array (else 400 INVALID_REQUEST).
 *  - Each item must have a numeric `nodeNum`, string `targetSourceId` /
 *    `donorSourceId`, and the two source ids must differ (else 400
 *    INVALID_ITEM).
 *  - Non-admin callers must hold `nodes:read` on every distinct donor source
 *    AND `nodes:write` on every distinct target source referenced anywhere in
 *    the batch — a single missing grant rejects the entire batch with 403
 *    FORBIDDEN and a `missing` list (extends copy-nodeinfo's single-op 403
 *    semantics to a set).
 *  - `applyEnrichment` itself is fill-blanks-only (via `copyNodeInfo` with no
 *    `fields` arg) — never overwrites a non-blank target field.
 */
export async function handleEnrichmentApply(req: Request, res: Response): Promise<Response> {
  try {
    const user = (req as any).user;
    const userId: number | null = user?.id ?? null;
    const isAdmin: boolean = user?.isAdmin ?? false;

    const body = req.body ?? {};
    const rawItems = body.items;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return fail(res, 400, 'INVALID_REQUEST', 'items must be a non-empty array');
    }

    const items: EnrichmentApplyItem[] = [];
    for (const raw of rawItems as RawApplyItem[]) {
      const { nodeNum, targetSourceId, donorSourceId } = raw ?? {};
      const valid = typeof nodeNum === 'number' && Number.isFinite(nodeNum)
        && typeof targetSourceId === 'string' && targetSourceId.length > 0
        && typeof donorSourceId === 'string' && donorSourceId.length > 0
        && donorSourceId !== targetSourceId;
      if (!valid) {
        return fail(
          res,
          400,
          'INVALID_ITEM',
          'Each item requires a numeric nodeNum, string targetSourceId and donorSourceId, and donorSourceId must differ from targetSourceId',
        );
      }
      items.push({ nodeNum: nodeNum as number, targetSourceId: targetSourceId as string, donorSourceId: donorSourceId as string });
    }

    if (!isAdmin) {
      const donorSourceIds = new Set(items.map(i => i.donorSourceId));
      const targetSourceIds = new Set(items.map(i => i.targetSourceId));
      const missing: Array<{ sourceId: string; action: 'read' | 'write' }> = [];

      for (const sourceId of donorSourceIds) {
        const canRead = userId !== null
          && await databaseService.checkPermissionAsync(userId, 'nodes', 'read', sourceId);
        if (!canRead) missing.push({ sourceId, action: 'read' });
      }
      for (const sourceId of targetSourceIds) {
        const canWrite = userId !== null
          && await databaseService.checkPermissionAsync(userId, 'nodes', 'write', sourceId);
        if (!canWrite) missing.push({ sourceId, action: 'write' });
      }

      if (missing.length > 0) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permission', { missing });
      }
    }

    const pushToNodeDb = body.pushToNodeDb === true;
    const result = await applyEnrichment(items, { pushToNodeDb });
    return ok(res, result);
  } catch (error) {
    logger.error('Error applying NodeInfo enrichment:', error);
    return fail(res, 500, 'ENRICHMENT_APPLY_FAILED', 'Failed to apply enrichment');
  }
}
