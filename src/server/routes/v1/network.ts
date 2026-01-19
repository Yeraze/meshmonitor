/**
 * v1 API - Network Endpoint
 *
 * Provides read-only access to network-wide statistics and information
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/network
 * Get network-wide statistics and summary information
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const allNodes = databaseService.getAllNodes();
    const activeNodes = databaseService.getActiveNodes(7);
    const traceroutes = databaseService.getAllTraceroutes();

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
router.get('/topology', (_req: Request, res: Response) => {
  try {
    const nodes = databaseService.getAllNodes();
    const traceroutes = databaseService.getAllTraceroutes();

    const topology = {
      nodes: nodes.map(n => ({
        nodeId: n.nodeId,
        nodeNum: n.nodeNum,
        longName: n.longName,
        shortName: n.shortName,
        role: n.role,
        hopsAway: n.hopsAway,
        latitude: n.latitude,
        longitude: n.longitude,
        lastHeard: n.lastHeard
      })),
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
