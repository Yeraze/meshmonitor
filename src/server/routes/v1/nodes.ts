/**
 * v1 API - Nodes Endpoint
 *
 * Provides read-only access to mesh network node information
 * Respects user permissions - requires nodes:read permission
 */

import express, { Request, Response } from 'express';
import databaseService, { DbNode } from '../../../services/database.js';
import { ALL_SOURCES } from '../../../db/repositories/index.js';
import { logger } from '../../../utils/logger.js';
import { filterNodesByChannelPermission, maskNodeLocationByChannel } from '../../utils/nodeEnhancer.js';
import {
  findCopyCandidates, copyNodeInfo, isNodeInfoField, NODE_INFO_FIELDS,
  type NodeInfoField,
} from '../../services/nodeInfoCopyService.js';
import { resolvedSourceIdFromPath } from './sourceParam.js';
import { handleEnrichmentAnalysis, handleEnrichmentApply } from '../shared/enrichmentHandlers.js';

// mergeParams so this router picks up :sourceId when mounted under
// /sources/:sourceId (new shape). At the root /nodes mount it's undefined
// and the handlers fall back to ?sourceId= for backward compat.
const router = express.Router({ mergeParams: true });

/**
 * Resolve the effective source scope for a request. Path param wins over
 * query param; both undefined means "no scope" (legacy cross-source view).
 */
function getScopedSourceId(req: Request): string | undefined {
  const fromPath = resolvedSourceIdFromPath(req);
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
    // intentional cross-source: omitting sourceId on this route returns nodes from all sources
    const nodes = active
      ? (await databaseService.nodes.getActiveNodes(sinceDays, sourceId ?? ALL_SOURCES)) as unknown as DbNode[]
      : (await databaseService.nodes.getAllNodes(sourceId ?? ALL_SOURCES)) as unknown as DbNode[];

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
 * GET /api/v1/nodes/enrichment/analysis
 * POST /api/v1/nodes/enrichment/apply
 *
 * NodeInfo enrichment (cross-source fill-blanks-only). Registered above the
 * bare `/:nodeId` route below — `/:nodeId` is single-segment and would
 * otherwise capture `/enrichment` as a node id. The `/enrichment/analysis`
 * and `/enrichment/apply` paths are 2-segment, so they would not actually be
 * shadowed either way, but registering first removes all doubt.
 *
 * No `optionalAuth()` wrapper: this router sits behind the v1 router's
 * global `requireAPIToken()` (routes/v1/index.ts), which hard-401s without a
 * valid bearer token and always populates `req.user` with a real, active
 * user — there is no anonymous fallthrough under v1 the way there is under
 * `nodesRoutes.ts`'s `optionalAuth()`. Layering `optionalAuth()` on top would
 * re-run the session/cookie lookup and could clobber `req.user` with the
 * anonymous user for token-only clients, so it is intentionally omitted here
 * (same reasoning as every other handler in this file).
 *
 * The `:sourceId` path param present when mounted under
 * `/sources/:sourceId/nodes` is ignored — these are cross-source handlers
 * that compute their own source universe from permissions, not from the
 * mount's sourceId.
 */
router.get('/enrichment/analysis', handleEnrichmentAnalysis);
router.post('/enrichment/apply', handleEnrichmentApply);

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
    // intentional cross-source: omitting sourceId on this route returns nodes from all sources
    const sourceNodes = (await databaseService.nodes.getAllNodes(sourceId ?? ALL_SOURCES)) as unknown as DbNode[];
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

/**
 * GET /api/v1/nodes/:nodeNum/copy-candidates
 * List other sources that have NodeInfo for this node.
 * Requires nodes:read permission on the target source.
 */
router.get('/:nodeNum/copy-candidates', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    const sourceId = getScopedSourceId(req);
    if (!sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'sourceId is required',
      });
    }

    if (!await hasNodesReadPermission(userId, isAdmin, sourceId)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: { resource: 'nodes', action: 'read' },
      });
    }

    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'nodeNum must be a number',
      });
    }

    const candidates = await findCopyCandidates(nodeNum, sourceId);
    res.json({ success: true, data: candidates });
  } catch (error) {
    logger.error('Error getting copy candidates:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve copy candidates',
    });
  }
});

/**
 * POST /api/v1/nodes/:nodeNum/copy-nodeinfo
 * Copy NodeInfo fields from one source to another.
 * Requires nodes:read on fromSourceId and nodes:write on toSourceId.
 *
 * Body: { fromSourceId: string, toSourceId: string, pushToNodeDb?: boolean }
 */
router.post('/:nodeNum/copy-nodeinfo', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'nodeNum must be a number',
      });
    }

    const { fromSourceId, toSourceId, pushToNodeDb, fields } = req.body ?? {};
    if (!fromSourceId || !toSourceId) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'fromSourceId and toSourceId are required',
      });
    }

    // #4244: optional per-field selection; reject unknown names loudly.
    let selectedFields: NodeInfoField[] | undefined;
    if (fields !== undefined) {
      if (!Array.isArray(fields) || !fields.every(isNodeInfoField)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `fields must be an array of: ${NODE_INFO_FIELDS.join(', ')}`,
        });
      }
      selectedFields = fields;
    }

    if (!await hasNodesReadPermission(userId, isAdmin, fromSourceId)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient read permission on source',
      });
    }

    const hasWritePermission = isAdmin || (userId !== null &&
      await databaseService.checkPermissionAsync(userId, 'nodes', 'write', toSourceId));
    if (!hasWritePermission) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Insufficient write permission on target source',
      });
    }

    const result = await copyNodeInfo(
      nodeNum, fromSourceId, toSourceId, !!pushToNodeDb, selectedFields,
    );
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('Error copying node info:', error);
    const status = error.message?.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: status === 404 ? 'Not Found' : 'Internal Server Error',
      message: error.message || 'Failed to copy node info',
    });
  }
});

export default router;
