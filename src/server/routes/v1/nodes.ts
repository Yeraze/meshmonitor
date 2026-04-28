/**
 * v1 API - Nodes Endpoint
 *
 * Provides read-only access to mesh network node information
 * Respects user permissions - requires nodes:read permission
 */

import express, { Request, Response } from 'express';
import databaseService, { DbNode } from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { filterNodesByChannelPermission, maskNodeLocationByChannel } from '../../utils/nodeEnhancer.js';

// mergeParams so this router picks up :sourceId when mounted under
// /sources/:sourceId (new shape). At the root /nodes mount it's undefined
// and the handlers fall back to ?sourceId= for backward compat.
const router = express.Router({ mergeParams: true });

/**
 * Resolve the effective source scope for a request. Path param wins over
 * query param; both undefined means "no scope" (legacy cross-source view).
 */
function getScopedSourceId(req: Request): string | undefined {
  const fromPath = typeof req.params.sourceId === 'string' ? req.params.sourceId : undefined;
  if (fromPath) return fromPath;
  const fromQuery = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
  return fromQuery;
}

/**
 * Check if user has nodes:read permission
 */
async function hasNodesReadPermission(userId: number | null, isAdmin: boolean, sourceId?: string): Promise<boolean> {
  if (isAdmin) return true;
  if (userId === null) return false;
  return databaseService.checkPermissionAsync(userId, 'nodes', 'read', sourceId);
}

/**
 * Enrich node data with latest uptime from telemetry (async - works with all DB backends)
 */
async function enrichNodesWithUptime(
  nodes: DbNode[],
  sourceId?: string,
): Promise<(DbNode & { uptimeSeconds?: number })[]> {
  const uptimeMap = await databaseService.telemetry.getLatestTelemetryValueForAllNodes(
    'uptimeSeconds',
    sourceId,
  );
  return nodes.map(node => ({
    ...node,
    uptimeSeconds: uptimeMap.get(node.nodeId)
  }));
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

    const sourceId = getScopedSourceId(req);

    // Check permission (scoped to source if provided)
    if (!await hasNodesReadPermission(userId, isAdmin, sourceId)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: 'nodes', action: 'read' }
      });
    }

    const active = req.query.active === 'true';
    const sinceDays = req.query.sinceDays ? parseInt(req.query.sinceDays as string) : 7;

    // DB-level sourceId filtering — repo accepts it directly, no more
    // fetch-all-then-filter.
    const nodes = active
      ? (await databaseService.nodes.getActiveNodes(sinceDays, sourceId)) as unknown as DbNode[]
      : (await databaseService.nodes.getAllNodes(sourceId)) as unknown as DbNode[];

    // Filter nodes based on channel read permissions
    const filteredNodes = await filterNodesByChannelPermission(nodes, user, sourceId);

    // Strip location fields for nodes whose position came from an inaccessible channel
    const locationMaskedNodes = await maskNodeLocationByChannel(filteredNodes, user, sourceId);

    // Enrich nodes with uptime data from telemetry (scoped to the requested source)
    const enrichedNodes = await enrichNodesWithUptime(locationMaskedNodes, sourceId);

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

    const sourceId = getScopedSourceId(req);

    // Check permission (scoped to source if provided)
    if (!await hasNodesReadPermission(userId, isAdmin, sourceId)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: 'nodes', action: 'read' }
      });
    }

    const { nodeId } = req.params;
    // Scope the lookup to the requested source so the same nodeNum seen on
    // two sources resolves independently (migration 029 made nodes PK
    // composite (nodeNum, sourceId)).
    const sourceNodes = (await databaseService.nodes.getAllNodes(sourceId)) as unknown as DbNode[];
    const node = sourceNodes.find(n => n.nodeId === nodeId);

    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: sourceId
          ? `Node ${nodeId} not found in source ${sourceId}`
          : `Node ${nodeId} not found`
      });
    }

    // Check if user has permission to view this node based on its channel
    const [filteredNode] = await filterNodesByChannelPermission([node], user, sourceId);
    if (!filteredNode) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'No permission to view this node',
        required: { resource: `channel_${node.channel ?? 0}`, action: 'read' }
      });
    }

    // Strip location fields if the position came from an inaccessible channel
    const [locationMaskedNode] = await maskNodeLocationByChannel([filteredNode], user, sourceId);

    // Enrich with uptime data from telemetry
    const [enrichedNode] = await enrichNodesWithUptime([locationMaskedNode]);

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
