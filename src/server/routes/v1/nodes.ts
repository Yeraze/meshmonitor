/**
 * v1 API - Nodes Endpoint
 *
 * Provides read-only access to mesh network node information
 * Respects user permissions - requires nodes:read permission
 */

import express, { Request, Response } from 'express';
import databaseService, { DbNode } from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { filterNodesByChannelPermission } from '../../utils/nodeEnhancer.js';

const router = express.Router();

/**
 * Check if user has nodes:read permission
 */
async function hasNodesReadPermission(userId: number | null, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;

  const permissions = userId !== null
    ? await databaseService.getUserPermissionSetAsync(userId)
    : {};

  return permissions.nodes?.read === true;
}

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
 * Requires nodes:read permission
 *
 * Query parameters:
 * - active: boolean - Only return nodes active within last 7 days
 * - sinceDays: number - Override default 7 day activity window
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    // Check permission
    if (!await hasNodesReadPermission(userId, isAdmin)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: 'nodes', action: 'read' }
      });
    }

    const active = req.query.active === 'true';
    const sinceDays = req.query.sinceDays ? parseInt(req.query.sinceDays as string) : 7;

    let nodes;
    if (active) {
      nodes = databaseService.getActiveNodes(sinceDays);
    } else {
      nodes = await databaseService.getAllNodesAsync();
    }

    // Filter nodes based on channel read permissions
    const filteredNodes = await filterNodesByChannelPermission(nodes, user);

    // Enrich nodes with uptime data from telemetry
    const enrichedNodes = filteredNodes.map(enrichNodeWithUptime);

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
 * Requires nodes:read permission
 */
router.get('/:nodeId', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    // Check permission
    if (!await hasNodesReadPermission(userId, isAdmin)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: 'nodes', action: 'read' }
      });
    }

    const { nodeId } = req.params;
    const allNodes = await databaseService.getAllNodesAsync();
    const node = allNodes.find(n => n.nodeId === nodeId);

    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Node ${nodeId} not found`
      });
    }

    // Check if user has permission to view this node based on its channel
    const [filteredNode] = await filterNodesByChannelPermission([node], user);
    if (!filteredNode) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'No permission to view this node',
        required: { resource: `channel_${node.channel ?? 0}`, action: 'read' }
      });
    }

    // Enrich with uptime data from telemetry
    const enrichedNode = enrichNodeWithUptime(filteredNode);

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
