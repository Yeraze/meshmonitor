/**
 * v1 API - Network Endpoint
 *
 * Provides read-only access to network-wide statistics and information
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { getEffectiveDbNodePosition } from '../../utils/nodeEnhancer.js';

const router = express.Router({ mergeParams: true });

/** Resolve sourceId from path or query. */
function getScopedSourceId(req: Request): string | undefined {
  const fromPath = typeof req.params.sourceId === 'string' ? req.params.sourceId : undefined;
  if (fromPath) return fromPath;
  const fromQuery = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
  return fromQuery;
}

/**
 * GET /api/v1/network
 * Get network-wide statistics and summary information
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sourceId = getScopedSourceId(req);
    const allNodes = await databaseService.nodes.getAllNodes(sourceId);
    const activeNodes = await databaseService.nodes.getActiveNodes(7, sourceId);
    const traceroutes = await databaseService.traceroutes.getAllTraceroutes(100, sourceId);

    const stats = {
      totalNodes: allNodes.length,
      activeNodes: activeNodes.length,
      tracerouteCount: traceroutes.length,
      lastUpdated: Date.now()
    };

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error getting network stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve network statistics'
    });
  }
});

/**
 * GET /api/v1/network/direct-neighbors
 * Get direct neighbor statistics based on zero-hop packets
 * This helps identify which nodes we've heard directly (no relays)
 */
router.get('/direct-neighbors', async (req: Request, res: Response) => {
  try {
    const hoursBack = parseInt(req.query.hours as string) || 24;
    // TODO(#2773 follow-up): getDirectNeighborStatsAsync does not yet accept
    // sourceId — neighbor stats are aggregated across all sources. Extend the
    // repo to scope by sourceId when this endpoint stabilises on the scoped
    // URL shape.
    void getScopedSourceId(req);
    const stats = await databaseService.getDirectNeighborStatsAsync(hoursBack);

    res.json({
      success: true,
      data: stats,
      count: Object.keys(stats).length
    });
  } catch (error) {
    logger.error('Error getting direct neighbor stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve direct neighbor statistics'
    });
  }
});

/**
 * GET /api/v1/network/topology
 * Get network topology data (nodes and their connections)
 */
router.get('/topology', async (req: Request, res: Response) => {
  try {
    const sourceId = getScopedSourceId(req);
    const nodes = await databaseService.nodes.getAllNodes(sourceId);
    const traceroutes = await databaseService.traceroutes.getAllTraceroutes(500, sourceId);

    const topology = {
      nodes: nodes.map(n => {
        // Surface effective position (override if enabled, else device GPS) so
        // topology consumers see the same lat/lon as the rest of the API
        // (issue #2847).
        const eff = getEffectiveDbNodePosition(n);
        return {
          nodeId: n.nodeId,
          nodeNum: n.nodeNum,
          longName: n.longName,
          shortName: n.shortName,
          role: n.role,
          hopsAway: n.hopsAway,
          latitude: eff.latitude,
          longitude: eff.longitude,
          lastHeard: n.lastHeard
        };
      }),
      edges: traceroutes.map(t => ({
        from: t.fromNodeId,
        to: t.toNodeId,
        route: t.route ? JSON.parse(t.route) : [],
        snr: t.snrTowards ? JSON.parse(t.snrTowards) : []
      }))
    };

    res.json({
      success: true,
      data: topology
    });
  } catch (error) {
    logger.error('Error getting network topology:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve network topology'
    });
  }
});

export default router;
