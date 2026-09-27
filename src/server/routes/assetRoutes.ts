/**
 * Asset Tracking routes (#5354, Phase 1), mounted at `/api/assets`.
 *
 * An asset flag is GLOBAL (keyed by the physical nodeNum; see
 * `src/db/schema/assetNodes.ts`), so:
 *  - reads are filtered to nodes that have a row on one of the caller's
 *    permitted sources, or a user scoped to one source would learn node
 *    numbers from another (same rule as `visibleSolarOverrides`);
 *  - writes take the global `settings:write` grant, like the solar override,
 *    because the flag extends storage on every source.
 *
 * No mesh traffic: everything here is storage.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds } from '../utils/permittedSources.js';
import { parseAssetRetentionDays, estimateAssetRows, ASSET_RETENTION_DAYS_RANGE } from '../../utils/assetTracking.js';

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse an unsigned 32-bit nodeNum path param, or null. */
function parseNodeNum(raw: string): number | null {
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
  return n;
}

/** nodeNums with a node row on at least one of `sourceIds`. */
async function visibleNodeNums(nodeNums: number[], sourceIds: string[]): Promise<Set<number>> {
  const permitted = new Set(sourceIds);
  const bySource = await databaseService.nodes.getSourceIdsForNodeNums(nodeNums);
  const visible = new Set<number>();
  for (const [num, sources] of bySource) {
    if (sources.some((s) => permitted.has(s))) visible.add(num);
  }
  return visible;
}

/**
 * GET /api/assets
 * Every tracked asset the caller can see: `[{ nodeNum, retentionDays, updatedAt }]`.
 * Anonymous callers get the rows for the anonymous user's permitted sources.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const all = await databaseService.assetNodes.getAllAsync();
    if (all.length === 0) return ok(res, []);
    const permitted = await resolvePermittedSourceIds(req);
    const visible = await visibleNodeNums(all.map((a) => a.nodeNum), permitted);
    return ok(
      res,
      all
        .filter((a) => visible.has(a.nodeNum))
        .map((a) => ({ nodeNum: a.nodeNum, retentionDays: a.retentionDays, updatedAt: a.updatedAt })),
    );
  } catch (error) {
    logger.error('Error in GET /api/assets:', error);
    return fail(res, 500, 'ASSETS_FETCH_FAILED', 'Failed to load tracked assets');
  }
});

/**
 * GET /api/assets/:nodeNum/estimate?retentionDays=N
 * Estimated rows kept: the node's telemetry rows over the last 24 h on the
 * caller's permitted sources, times the retention days. `estimatedRows` is
 * null when there is no recent data. Scoped by the per-source `nodes:read`
 * grant: `info` (the telemetry grant) is a global resource, so it cannot
 * narrow the count to the sources this caller may read.
 */
router.get('/:nodeNum/estimate', async (req: Request, res: Response) => {
  const nodeNum = parseNodeNum(req.params.nodeNum as string);
  if (nodeNum === null) {
    return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');
  }
  try {
    let retentionDays: number | null;
    if (req.query.retentionDays !== undefined) {
      retentionDays = parseAssetRetentionDays(req.query.retentionDays);
      if (retentionDays === null) {
        return fail(
          res, 400, 'INVALID_ASSET_RETENTION',
          `retentionDays must be a whole number from ${ASSET_RETENTION_DAYS_RANGE.min} to ${ASSET_RETENTION_DAYS_RANGE.max}`,
        );
      }
    } else {
      const asset = await databaseService.assetNodes.getAsync(nodeNum);
      retentionDays = asset?.retentionDays ?? null;
    }
    const permitted = await resolvePermittedSourceIds(req);
    const rowsLast24h = await databaseService.telemetry.countTelemetryForNodeNumSince(
      nodeNum, Date.now() - DAY_MS, permitted,
    );
    return ok(res, {
      nodeNum,
      rowsLast24h,
      retentionDays,
      estimatedRows: retentionDays === null ? null : estimateAssetRows(rowsLast24h, retentionDays),
    });
  } catch (error) {
    logger.error('Error in GET /api/assets/:nodeNum/estimate:', error);
    return fail(res, 500, 'ASSET_ESTIMATE_FAILED', 'Failed to estimate asset storage');
  }
});

/**
 * PUT /api/assets/:nodeNum  body `{ retentionDays }`
 * Mark a node as a tracked asset, or change its retention. `settings:write`.
 */
router.put('/:nodeNum', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  const nodeNum = parseNodeNum(req.params.nodeNum as string);
  if (nodeNum === null) {
    return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');
  }
  // Numbers only in a JSON body: a string "30" is a client bug worth surfacing.
  const raw = req.body?.retentionDays;
  const retentionDays = typeof raw === 'number' ? parseAssetRetentionDays(raw) : null;
  if (retentionDays === null) {
    return fail(
      res, 400, 'INVALID_ASSET_RETENTION',
      `retentionDays must be a whole number from ${ASSET_RETENTION_DAYS_RANGE.min} to ${ASSET_RETENTION_DAYS_RANGE.max}`,
    );
  }
  try {
    const before = await databaseService.assetNodes.getAsync(nodeNum);
    const saved = await databaseService.assetNodes.setAsync(nodeNum, retentionDays, req.user?.id ?? null);
    void databaseService.auditLogAsync(
      req.user?.id ?? null,
      'asset_node_set',
      'settings',
      `Tracked asset ${nodeNum}: retention ${retentionDays} day(s)`,
      req.ip || null,
      before ? JSON.stringify({ retentionDays: before.retentionDays }) : null,
      JSON.stringify({ retentionDays }),
    );
    logger.info(`[AssetRoutes] Node ${nodeNum} tracked as an asset (${retentionDays} days)`);
    return ok(res, saved);
  } catch (error) {
    logger.error('Error in PUT /api/assets/:nodeNum:', error);
    return fail(res, 500, 'ASSET_SAVE_FAILED', 'Failed to save tracked asset');
  }
});

/**
 * DELETE /api/assets/:nodeNum
 * Stop tracking a node as an asset. `settings:write`. Its retained history is
 * then trimmed back to the regular window by the next hourly purge.
 */
router.delete('/:nodeNum', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  const nodeNum = parseNodeNum(req.params.nodeNum as string);
  if (nodeNum === null) {
    return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');
  }
  try {
    const before = await databaseService.assetNodes.getAsync(nodeNum);
    await databaseService.assetNodes.clearAsync(nodeNum);
    if (before) {
      void databaseService.auditLogAsync(
        req.user?.id ?? null,
        'asset_node_cleared',
        'settings',
        `Tracked asset ${nodeNum} cleared`,
        req.ip || null,
        JSON.stringify({ retentionDays: before.retentionDays }),
        null,
      );
      logger.info(`[AssetRoutes] Node ${nodeNum} is no longer a tracked asset`);
    }
    return ok(res);
  } catch (error) {
    logger.error('Error in DELETE /api/assets/:nodeNum:', error);
    return fail(res, 500, 'ASSET_CLEAR_FAILED', 'Failed to clear tracked asset');
  }
});

export default router;
