/**
 * v1 API - Traceroutes Endpoint
 *
 * Provides read-only access to traceroute data showing network paths
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { maskTraceroutesByChannel } from '../../utils/nodeEnhancer.js';

const router = express.Router({ mergeParams: true });

/** Resolve sourceId from path or query. */
function getScopedSourceId(req: Request): string | undefined {
  const fromPath = typeof req.params.sourceId === 'string' ? req.params.sourceId : undefined;
  if (fromPath) return fromPath;
  const fromQuery = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
  return fromQuery;
}

/**
 * GET /api/v1/traceroutes
 * Get all traceroute records
 *
 * Query parameters:
 * - fromNodeId: string - Filter by source node
 * - toNodeId: string - Filter by destination node
 * - limit: number - Max number of records to return (default: 100)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { fromNodeId, toNodeId, limit } = req.query;
    const sourceIdStr = getScopedSourceId(req);
    const maxLimit = parseInt(limit as string) || 100;

    let traceroutes = databaseService.getAllTraceroutes(maxLimit, sourceIdStr);

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
    traceroutes = await maskTraceroutesByChannel(traceroutes, (req as any).user, sourceIdStr);

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
    const sourceIdParam = getScopedSourceId(req);
    const allTraceroutes = databaseService.getAllTraceroutes(100, sourceIdParam);
    const traceroute = allTraceroutes.find(t => t.fromNodeId === fromNodeId && t.toNodeId === toNodeId);

    if (!traceroute) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `No traceroute found from ${fromNodeId} to ${toNodeId}`
      });
    }

    // Mask if the traceroute's channel is inaccessible to this user
    const visible = await maskTraceroutesByChannel([traceroute], (req as any).user, sourceIdParam);
    if (visible.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions'
      });
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
