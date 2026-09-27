/**
 * Asset Tracking routes (#5354, Phases 1-2), mounted at `/api/assets`.
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
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { parseAssetRetentionDays, estimateAssetRows, ASSET_RETENTION_DAYS_RANGE } from '../../utils/assetTracking.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import {
  buildAssetTrack,
  getAssetTrackCached,
  assetTrackCacheKey,
  clearAssetTrackCache,
} from '../services/assetTrackService.js';

const router = Router();
// The api router mounts this without auth; resolve req.user here, as the
// analysis and aircraft routers do, so GET filtering sees the real caller.
router.use(optionalAuth());

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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
 * Of `sourceIds`, the sources whose copy of `nodeNum` the caller may see on a
 * map. Mirrors `buildPositionFilter` (positionVisibility.ts) for one node:
 *  - presence: a source with no node row contributes nothing (orphaned
 *    telemetry has no marker anywhere), admins included;
 *  - non-admins: a private position override needs `nodes_private:read` on
 *    THAT source (buildPositionFilter checks it unscoped; per-source is the
 *    stricter reading, since the grant is per-source), and the node's channel
 *    needs `viewOnMap`.
 * `hideFromMap` is not applied: the Nodes map only asks for a trail when the
 * operator selects the node, and `/position-history` doesn't apply it either.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5354 req.user's shape isn't exported as a type from authMiddleware; matches buildPositionFilter
async function trackVisibleSources(user: any, nodeNum: number, sourceIds: string[]): Promise<string[]> {
  const isAdmin = !!user?.isAdmin;
  const userId: number | null = user?.id ?? null;
  const nodes = await Promise.all(sourceIds.map((s) => databaseService.nodes.getNode(nodeNum, s)));
  const present = sourceIds
    .map((sourceId, i) => ({ sourceId, node: nodes[i] }))
    .filter((e): e is { sourceId: string; node: NonNullable<typeof e.node> } => !!e.node);
  if (isAdmin) return present.map((e) => e.sourceId);
  if (userId === null) return [];

  const channelDbPerms = present.some((e) => (e.node.channel ?? 0) >= CHANNEL_DB_OFFSET)
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(userId)
    : {};
  const visible: string[] = [];
  for (const { sourceId, node } of present) {
    if (node.positionOverrideIsPrivate
      && !(await databaseService.checkPermissionAsync(userId, 'nodes_private', 'read', sourceId))) {
      continue;
    }
    const ch = node.channel ?? 0;
    let canView: boolean;
    if (ch < CHANNEL_DB_OFFSET) {
      const perms = await databaseService.getUserPermissionSetAsync(userId, sourceId);
      canView = (perms as Record<string, { viewOnMap?: boolean } | undefined>)[`channel_${ch}`]?.viewOnMap === true;
    } else {
      canView = (channelDbPerms as Record<number, { viewOnMap?: boolean } | undefined>)[ch - CHANNEL_DB_OFFSET]?.viewOnMap === true;
    }
    if (canView) visible.push(sourceId);
  }
  return visible;
}

/**
 * GET /api/assets/:nodeNum/track?hours=N&sources=a,b
 * The asset's thinned full-history trail (#5354 Phase 2): at most 2,000
 * points in gap segments, merged and deduped across the caller's visible
 * sources. `hours` is clamped to 1 .. retentionDays x 24 and defaults to the
 * full retention. 404 `NOT_AN_ASSET` when the node isn't tracked or the
 * caller can't see it on any permitted source (so the flag doesn't leak).
 */
router.get('/:nodeNum/track', async (req: Request, res: Response) => {
  const nodeNum = parseNodeNum(req.params.nodeNum as string);
  if (nodeNum === null) {
    return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');
  }
  let requestedHours: number | null = null;
  if (req.query.hours !== undefined) {
    const raw = String(req.query.hours);
    requestedHours = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(requestedHours)) {
      return fail(res, 400, 'INVALID_HOURS', 'hours must be a whole number');
    }
  }
  try {
    const asset = await databaseService.assetNodes.getAsync(nodeNum);
    const permitted = await resolvePermittedSourceIds(req);
    if (!asset || !(await visibleNodeNums([nodeNum], permitted)).has(nodeNum)) {
      return fail(res, 404, 'NOT_AN_ASSET', 'Node is not a tracked asset');
    }
    const maxHours = asset.retentionDays * 24;
    const hours = requestedHours === null ? maxHours : Math.min(maxHours, Math.max(1, requestedHours));

    const requested = parseSourcesParam(req.query.sources);
    const scoped = requested ? permitted.filter((s) => requested.includes(s)) : permitted;
    const sourceIds = await trackVisibleSources(req.user, nodeNum, scoped);

    const now = Date.now();
    const windowStartMs = now - hours * HOUR_MS;
    const track = await getAssetTrackCached(
      assetTrackCacheKey(nodeNum, hours, sourceIds),
      () => buildAssetTrack({ nodeNum, sourceIds, windowStartMs, windowEndMs: now }),
      now,
    );
    return ok(res, {
      nodeNum,
      retentionDays: asset.retentionDays,
      hours,
      windowStartMs,
      totalFixes: track.totalFixes,
      segments: track.segments,
    });
  } catch (error) {
    logger.error('Error in GET /api/assets/:nodeNum/track:', error);
    return fail(res, 500, 'ASSET_TRACK_FAILED', 'Failed to load asset track');
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
    clearAssetTrackCache(nodeNum);
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
    clearAssetTrackCache(nodeNum);
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
