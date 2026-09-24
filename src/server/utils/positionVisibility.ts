/**
 * Position visibility gate (#5277 Coverage Report epic, Phase 1 WP3 §2.6).
 *
 * Extracted verbatim (no behaviour change) from the private `buildPositionFilter`
 * that used to live in `analysisRoutes.ts`, so `coverageRoutes.ts` can reuse the
 * exact same three-part gate `/positions` and `/coverage-grid` already enforce:
 *
 *  - live-node presence (#4163 follow-up): a DISPLAY gate applied to EVERYONE.
 *    Position telemetry lives in the `telemetry` table and is NOT cascade-
 *    deleted when a node is removed, so bulk deletes that don't purge telemetry
 *    ("Clean up inactive nodes", "Prune Outside ROI") leave orphaned lat/lon
 *    rows behind. Those rows have no node record — hence no marker on any map —
 *    so they must not contribute heatmap/coverage density. A position whose
 *    `(sourceId, nodeNum)` has no current node is dropped.
 *  - `hideFromMap` (#4162/#4163): a DISPLAY gate applied to EVERYONE, admins
 *    included. A node with "Hide from Map" set has no marker on any map
 *    surface (`useAnalysisNodes`/`embedPublicRoutes` drop it), so its
 *    historical position telemetry must not contribute heatmap or
 *    coverage-grid density either.
 *  - per-channel `viewOnMap` + `positionOverrideIsPrivate`: PERMISSION gates
 *    applied only to non-admins.
 *
 * The predicate parameter is generalised to the minimal shape it actually
 * needs, `{ sourceId, nodeNum }`, rather than `PositionRow` — `PositionRow`
 * still satisfies it structurally, and `coverageRoutes.ts` can run the same
 * gate against `senderNodeNum` / `receiverNodeNum` without importing
 * `analysisRoutes.ts`'s private row type.
 */
import databaseService from '../../services/database.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import type { DbNode } from '../../db/types.js';

/** The minimal row shape `buildPositionFilter`'s predicate needs. */
export interface VisibilityRow {
  sourceId: string;
  nodeNum: number;
}

/**
 * Batch-load every node for each of `sourceIds` into a `sourceId -> DbNode[]`
 * map. Extracted so callers that need the same node set for more than one
 * purpose (e.g. `buildPositionFilter` AND their own name/position lookups)
 * pay for `getAllNodes` once instead of twice.
 */
export async function loadNodesBySource(sourceIds: string[]): Promise<Map<string, DbNode[]>> {
  const entries = await Promise.all(
    sourceIds.map(async (srcId) => [srcId, await databaseService.nodes.getAllNodes(srcId)] as const),
  );
  return new Map(entries);
}

/**
 * Build a synchronous position-row filter enforcing the three gates
 * documented above. Always returns a predicate (never null): whether
 * orphaned rows exist can't be known without inspecting each position, so
 * filtering can't be skipped up front. The predicate is pure and cheap (one
 * Map lookup per row).
 *
 * Pre-fetches all permissions and node metadata once so the returned
 * predicate is pure and cheap to call per item — avoids N async DB
 * round-trips inside a hot per-row filter loop.
 *
 * `nodesBySource`, when supplied, is used instead of an internal
 * `loadNodesBySource` call — lets a caller that already loaded nodes (e.g.
 * for its own name lookups) avoid a second `getAllNodes` scan.
 */
export async function buildPositionFilter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5277 req.user's shape isn't exported as a type from authMiddleware; matches the original analysisRoutes.ts signature
  user: any,
  sourceIds: string[],
  nodesBySource?: Map<string, DbNode[]>,
): Promise<(pos: VisibilityRow) => boolean> {
  const isAdmin = !!user?.isAdmin;
  const userId: number | null = user?.id ?? null;

  // Batch-load node metadata for all nodes across permitted sources so the
  // filter predicate runs synchronously. `hideFromMap` is read for every user
  // (display gate); channel/positionOverrideIsPrivate only feed the non-admin
  // permission gates below.
  const nodesBySourceResolved = nodesBySource ?? (await loadNodesBySource(sourceIds));
  const nodeInfoByKey = new Map<
    string,
    { channel: number; positionOverrideIsPrivate: boolean; hideFromMap: boolean }
  >();
  for (const srcId of sourceIds) {
    const nodes = nodesBySourceResolved.get(srcId) ?? [];
    for (const n of nodes) {
      nodeInfoByKey.set(`${srcId}:${n.nodeNum}`, {
        channel: n.channel ?? 0,
        positionOverrideIsPrivate: !!n.positionOverrideIsPrivate,
        hideFromMap: !!n.hideFromMap,
      });
    }
  }

  // Admins bypass the permission gates, but the display gates still apply: a
  // position whose owning node is hidden (`hideFromMap`) or no longer exists
  // (orphaned telemetry from a deleted/pruned node — #4163) has no marker, so
  // it contributes no density.
  if (isAdmin) {
    return (pos: VisibilityRow): boolean => {
      const info = nodeInfoByKey.get(`${pos.sourceId}:${pos.nodeNum}`);
      return !!info && !info.hideFromMap;
    };
  }

  // Fetch channel permission sets once per source
  const permsBySource = new Map<string, Record<string, { viewOnMap?: boolean } | undefined>>();
  for (const srcId of sourceIds) {
    const perms = userId !== null
      ? await databaseService.getUserPermissionSetAsync(userId, srcId)
      : {};
    permsBySource.set(srcId, perms);
  }

  // Fetch virtual-channel (channel DB) permissions and nodes_private:read once
  const channelDbPerms: Record<number, { viewOnMap: boolean } | undefined> = userId !== null
    ? await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(userId)
    : {};
  const canViewPrivate = userId !== null
    ? await databaseService.checkPermissionAsync(userId, 'nodes_private', 'read')
    : false;

  return (pos: VisibilityRow): boolean => {
    const info = nodeInfoByKey.get(`${pos.sourceId}:${pos.nodeNum}`);

    // #4163: orphaned telemetry (owning node deleted/pruned) has no node record
    // and therefore no marker, so it contributes no density. Drop it before the
    // permission gates rather than defaulting it onto channel 0.
    if (!info) return false;

    // #4162/#4163: hidden nodes have no marker, so contribute no density.
    if (info.hideFromMap) return false;

    // Block private-position nodes unless the user has nodes_private:read
    if (info.positionOverrideIsPrivate && !canViewPrivate) return false;

    // Block nodes on channels the user lacks viewOnMap permission for
    const perms = permsBySource.get(pos.sourceId) ?? {};
    const ch = info.channel;
    if (ch < CHANNEL_DB_OFFSET) {
      return perms[`channel_${ch}`]?.viewOnMap === true;
    }
    return channelDbPerms[ch - CHANNEL_DB_OFFSET]?.viewOnMap === true;
  };
}
