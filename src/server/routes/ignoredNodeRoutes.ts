import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveRequestSourceId } from '../utils/sourceResolver.js';
import { fail } from '../utils/apiResponse.js';

const router = Router();

router.get('/', requirePermission('nodes', 'read'), async (req: Request, res: Response) => {
  try {
    const listSourceId = await resolveRequestSourceId(req, 'nodes', 'read');
    if (!listSourceId) {
      fail(res, 400, 'MISSING_SOURCE_ID', 'No permitted source', {
        details: 'Provide ?sourceId=, or ensure your account has nodes:read on at least one enabled source',
      });
      return;
    }
    const ignoredNodes = await databaseService.ignoredNodes.getIgnoredNodesAsync(listSourceId);
    res.json(ignoredNodes);
  } catch (error) {
    logger.error('Error fetching ignored nodes:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch ignored nodes', {
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

router.delete('/:nodeId', requirePermission('nodes', 'write'), async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;

    const nodeNumStr = nodeId.replace('!', '');

    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      fail(res, 400, 'INVALID_NODE_ID', 'Invalid nodeId format', {
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      });
      return;
    }

    const deleteSourceId = await resolveRequestSourceId(req, 'nodes', 'write');
    if (!deleteSourceId) {
      fail(res, 400, 'MISSING_SOURCE_ID', 'No permitted source', {
        details: 'Provide ?sourceId=, or ensure your account has nodes:write on at least one enabled source',
      });
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    await databaseService.ignoredNodes.removeIgnoredNodeAsync(nodeNum, deleteSourceId);
    try {
      await databaseService.setNodeIgnoredAsync(nodeNum, false, deleteSourceId);
    } catch {
      // Node may not exist in nodes table for this source — OK, table-level removal already succeeded.
    }

    res.json({ success: true, nodeNum, sourceId: deleteSourceId });
  } catch (error) {
    logger.error('Error removing ignored node:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to remove ignored node', {
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

export default router;
