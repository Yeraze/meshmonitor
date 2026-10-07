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
      data: traceroutes
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
      data: visible[0]
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
