/**
 * Node rename history for Node Details (#5862).
 *
 *   GET /api/nodes/:nodeId/name-history
 *
 * `:nodeId` is a Meshtastic id (`!aabbccdd` or a decimal nodeNum) or a MeshCore
 * public key (64 hex). The answer merges the node's renames from every source
 * the caller may see the node on, so no source the caller cannot read is
 * revealed:
 *  - Meshtastic: the sources holding the node on a channel the caller has
 *    `viewOnMap` on there (the same rule as the node list).
 *  - MeshCore: the sources the caller holds `nodes:read` on (the MeshCore node
 *    list's gate).
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { isValidNodeNum } from '../constants/meshtastic.js';
import { loadNodeViewAccess } from '../utils/nodeEnhancer.js';
import { listPermittedSourceIds } from '../utils/sourceScopedAccess.js';
import { mergeNameHistory } from '../services/nodeNameHistoryMerge.js';
import type { NodeNameProtocol } from '../../db/repositories/nodeNameHistory.js';

const router = Router();

const PUBLIC_KEY_RE = /^[0-9a-fA-F]{64}$/;

function parseMeshtasticNodeNum(nodeId: string): number | null {
  const num = nodeId.startsWith('!') ? parseInt(nodeId.slice(1), 16) : Number(nodeId);
  return Number.isInteger(num) && isValidNodeNum(num) ? num : null;
}

router.get('/nodes/:nodeId/name-history', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const rawId = String(req.params.nodeId);
    let protocol: NodeNameProtocol;
    let nodeKey: string;
    let sourceIds: string[];

    if (PUBLIC_KEY_RE.test(rawId)) {
      protocol = 'meshcore';
      nodeKey = rawId.toLowerCase();
      const permitted = await listPermittedSourceIds(req.user, 'nodes', 'read');
      sourceIds = permitted === 'all'
        ? (await databaseService.sources.getAllSources()).map(s => s.id)
        : permitted;
    } else {
      const nodeNum = parseMeshtasticNodeNum(rawId);
      if (nodeNum === null) {
        return fail(res, 400, 'INVALID_NODE_ID', 'Invalid node id');
      }
      protocol = 'meshtastic';
      nodeKey = String(nodeNum);
      const [access, rows] = await Promise.all([
        loadNodeViewAccess(req.user),
        databaseService.nodes.getNodeVisibilityAcrossSources(nodeNum),
      ]);
      sourceIds = rows.filter(r => access.canViewNode(r.sourceId, r.channel)).map(r => r.sourceId);
    }

    const rows = await databaseService.nodeNameHistory.listForNode(protocol, nodeKey, sourceIds);
    ok(res, { entries: mergeNameHistory(rows) });
  } catch (error) {
    logger.error('Error fetching node name history:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch name history');
  }
});

export default router;
