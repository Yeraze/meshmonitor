/**
 * One viewer-correct read of a MeshCore source's nodes (#6263 S1).
 *
 * `meshcore.getNodesBySource` + the enabled location override (a private
 * override's coordinates only with `nodes_private:read`) + the `nodes:viewOnMap`
 * mask + the display-only sign-flip correction. Reads the database, so it works
 * while the source is disconnected. The v1 API and the metrics collector call
 * this; the grants come from a `NodeViewAccess` loaded once per request, so no
 * per-row permission query runs here.
 */
import databaseService from '../../services/database.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { NodeViewAccess } from '../utils/nodeEnhancer.js';
import {
  applyMeshCorePositionOverrides,
  loadMeshCorePositionOverrides,
  type MeshCoreOverrideFields,
} from '../utils/meshcorePositionOverride.js';
import { stripPositions } from '../utils/meshcorePositions.js';
import { applySignFlipToMeshCoreRows, type SignFlipFields } from './signFlipCorrection.js';

export type MeshCoreViewerNode = DbMeshCoreNode & MeshCoreOverrideFields & SignFlipFields;

export interface LoadMeshCoreNodesOptions {
  /**
   * Whether the caller wants positions at all. `false` (metrics, anything that
   * must never carry coordinates) strips them regardless of grants. `true`
   * still requires `nodes:viewOnMap` on the source.
   */
  positions: boolean;
  /** Only nodes heard at or after this time (ms). Omitted = every node. */
  heardSinceMs?: number;
  /** With `heardSinceMs`: at most this many, most recently heard first. */
  limit?: number;
}

export async function loadMeshCoreNodesForViewer(
  sourceId: string,
  access: NodeViewAccess,
  options: LoadMeshCoreNodesOptions,
): Promise<MeshCoreViewerNode[]> {
  const rows: DbMeshCoreNode[] = options.heardSinceMs !== undefined
    ? await databaseService.meshcore.getNodesHeardSince(sourceId, options.heardSinceMs, options.limit ?? Number.MAX_SAFE_INTEGER)
    : await databaseService.meshcore.getNodesBySource(sourceId);

  const overrides = await loadMeshCorePositionOverrides(sourceId);
  // `PositionedRow` wants optional numbers; DB rows carry `number | null`.
  const withOverrides = applyMeshCorePositionOverrides(
    rows as unknown as Array<DbMeshCoreNode & { latitude?: number; longitude?: number; publicKey?: string }>,
    overrides,
    access.canViewPrivate(sourceId),
  ) as unknown as DbMeshCoreNode[];

  const canViewOnMap = access.isAdmin || access.permissions.can('nodes', 'viewOnMap', sourceId);
  const masked = options.positions && canViewOnMap
    ? withOverrides
    : (stripPositions(withOverrides as unknown as Array<{ latitude?: number; longitude?: number }>) as unknown as DbMeshCoreNode[]);

  return (await applySignFlipToMeshCoreRows(masked, sourceId)) as MeshCoreViewerNode[];
}
