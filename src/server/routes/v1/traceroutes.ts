/**
 * v1 API - Traceroutes Endpoint
 *
 * Provides read-only access to traceroute data showing network paths
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import type { NodeViewAccess } from '../../utils/nodeEnhancer.js';
import { fail } from '../../utils/apiResponse.js';
import { canViewRowChannel, loadV1Access, requireScopedSourceId } from './sourceParam.js';
import { isAnyMeshCoreSourceType } from '../../../utils/nodeTypeCategory.js';
import { meshcoreTraceToV1, withMeshtasticProtocol } from '../../utils/protocolRows.js';

/**
 * The MeshCore traces this source initiated (newest first), as v1 rows.
 * Read from the database, so it works while the source is disconnected.
 * `traceroute:read` on the source is checked by the caller's `attachSource`.
 */
export async function loadMeshCoreTracesV1(sourceId: string, limit: number) {
  const groups = await databaseService.meshcoreHopSnr.getInitiatedTraces(sourceId, 0, limit);
  const local = (await databaseService.meshcore.getLocalNodePublicKeysBySource([sourceId])).get(sourceId) ?? null;
  const rows: NonNullable<ReturnType<typeof meshcoreTraceToV1>>[] = [];
  for (const group of groups) {
    const row = meshcoreTraceToV1(group, { localPublicKey: local });
    if (row) rows.push(row);
  }
  return rows;
}

type SourcedRequest = Request & { source?: { type?: string } };

/** A traceroute heard on a channel the token user cannot view on this source
 *  is left out. */
function visibleOnSource<T>(rows: T[], access: NodeViewAccess, sourceId: string): T[] {
  return rows.filter((row) => canViewRowChannel(access, sourceId, (row as { channel?: number | null }).channel));
}

const router = express.Router({ mergeParams: true });

/**
 * GET /api/v1/traceroutes
 * Get all traceroute records
 *
 * Query parameters:
 * - fromNodeId: string - Filter by source node
 * - toNodeId: string - Filter by destination node
 * - limit: number - Max number of records to return (default: 100)
 */
// #5363: this public data API returns stored traceroutes as recorded. The
// display-time sign-flip correction of routePositions snapshots applies to the
// app's map payloads (poll, /api/traceroutes, dashboard, WebSocket) only.
router.get('/', async (req: Request, res: Response) => {
  try {
    const { fromNodeId, toNodeId, limit } = req.query;
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);
    const maxLimit = parseInt(limit as string) || 100;

    if (isAnyMeshCoreSourceType((req as SourcedRequest).source?.type)) {
      let rows = await loadMeshCoreTracesV1(sourceId, maxLimit);
      if (fromNodeId) rows = rows.filter((t) => t.fromNodeId === fromNodeId);
      if (toNodeId) rows = rows.filter((t) => t.toNodeId === toNodeId);
      return res.json({ success: true, count: rows.length, data: rows });
    }

    let traceroutes = await databaseService.getAllTraceroutesAsync(maxLimit, sourceId);

    // Apply filters
    if (fromNodeId) {
      traceroutes = traceroutes.filter(t => t.fromNodeId === fromNodeId);
    }
    if (toNodeId) {
      traceroutes = traceroutes.filter(t => t.toNodeId === toNodeId);
    }

    // Apply limit (redundant with the repo limit, but guards against fromNodeId/toNodeId pre-filtering)
    traceroutes = traceroutes.slice(0, maxLimit);

    // Mask traceroutes from channels the user cannot access
    traceroutes = visibleOnSource(traceroutes, access, sourceId);

    res.json({
      success: true,
      count: traceroutes.length,
      data: traceroutes.map(withMeshtasticProtocol)
    });
  } catch (error) {
    logger.error('Error getting traceroutes:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve traceroutes'
    });
  }
});

/**
 * GET /api/v1/traceroutes/:fromNodeId/:toNodeId
 * Get traceroute between two specific nodes
 */
router.get('/:fromNodeId/:toNodeId', async (req: Request, res: Response) => {
  try {
    const { fromNodeId, toNodeId } = req.params;
    const sourceId = requireScopedSourceId(req, res);
    if (!sourceId) return;
    const access = await loadV1Access(req);
    if (isAnyMeshCoreSourceType((req as SourcedRequest).source?.type)) {
      const rows = await loadMeshCoreTracesV1(sourceId, 100);
      const hit = rows.find((t) => t.fromNodeId === fromNodeId && t.toNodeId === toNodeId);
      if (!hit) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No traceroute found from ${fromNodeId} to ${toNodeId}`
        });
      }
      return res.json({ success: true, data: hit });
    }
    const allTraceroutes = await databaseService.getAllTraceroutesAsync(100, sourceId);
    const traceroute = allTraceroutes.find(t => t.fromNodeId === fromNodeId && t.toNodeId === toNodeId);

    if (!traceroute) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `No traceroute found from ${fromNodeId} to ${toNodeId}`
      });
    }

    // Mask if the traceroute's channel is inaccessible to this user
    const visible = visibleOnSource([traceroute], access, sourceId);
    if (visible.length === 0) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    res.json({
      success: true,
      data: withMeshtasticProtocol(visible[0])
    });
  } catch (error) {
    logger.error('Error getting traceroute:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve traceroute'
    });
  }
});

export default router;
