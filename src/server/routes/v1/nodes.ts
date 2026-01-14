/**
 * v1 API - Nodes Endpoint
 *
 * Provides read-only access to mesh network node information
 */

import express, { Request, Response } from 'express';
import databaseService, { DbNode } from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * Enrich node data with latest uptime from telemetry
 */
function enrichNodeWithUptime(node: DbNode): DbNode & { uptimeSeconds?: number } {
  const uptimeTelemetry = databaseService.getLatestTelemetryForType(node.nodeId, 'uptimeSeconds');
  return {
    ...node,
    uptimeSeconds: uptimeTelemetry?.value
  };
}

/**
 * GET /api/v1/nodes
 * Get all nodes in the mesh network
 *
 * Query parameters:
 * - active: boolean - Only return nodes active within last 7 days
 * - sinceDays: number - Override default 7 day activity window
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const active = req.query.active === 'true';
    const sinceDays = req.query.sinceDays ? parseInt(req.query.sinceDays as string) : 7;

    let nodes;
    if (active) {
      nodes = databaseService.getActiveNodes(sinceDays);
    } else {
      nodes = databaseService.getAllNodes();
    }

    // Enrich nodes with uptime data from telemetry
    const enrichedNodes = nodes.map(enrichNodeWithUptime);

    res.json({
      success: true,
      count: enrichedNodes.length,
      data: enrichedNodes
    });
  } catch (error) {
    logger.error('Error getting nodes:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve nodes'
    });
  }
});

/**
 * GET /api/v1/nodes/:nodeId
 * Get a specific node by node ID
 */
router.get('/:nodeId', (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const allNodes = databaseService.getAllNodes();
    const node = allNodes.find(n => n.nodeId === nodeId);

    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Node ${nodeId} not found`
      });
    }

    // Enrich with uptime data from telemetry
    const enrichedNode = enrichNodeWithUptime(node);

    res.json({
      success: true,
      data: enrichedNode
    });
  } catch (error) {
    logger.error('Error getting node:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve node'
    });
  }
});

export default router;
