import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveRequestSourceId } from '../utils/sourceResolver.js';

interface ApiErrorResponse {
  error: string;
  code: string;
  details?: string;
}

const router = Router();

router.get('/', requirePermission('nodes', 'read'), async (req: Request, res: Response) => {
  try {
    const listSourceId = await resolveRequestSourceId(req, 'nodes', 'read');
    if (!listSourceId) {
      const errorResponse: ApiErrorResponse = {
        error: 'No permitted source',
        code: 'MISSING_SOURCE_ID',
        details: 'Provide ?sourceId=, or ensure your account has nodes:read on at least one enabled source',
      };
      res.status(400).json(errorResponse);
      return;
    }
    const ignoredNodes = await databaseService.ignoredNodes.getIgnoredNodesAsync(listSourceId);
    res.json(ignoredNodes);
  } catch (error) {
    logger.error('Error fetching ignored nodes:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to fetch ignored nodes',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

router.delete('/:nodeId', requirePermission('nodes', 'write'), async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;

    const nodeNumStr = nodeId.replace('!', '');

    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const deleteSourceId = await resolveRequestSourceId(req, 'nodes', 'write');
    if (!deleteSourceId) {
      const errorResponse: ApiErrorResponse = {
        error: 'No permitted source',
        code: 'MISSING_SOURCE_ID',
        details: 'Provide ?sourceId=, or ensure your account has nodes:write on at least one enabled source',
      };
      res.status(400).json(errorResponse);
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
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to remove ignored node',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

export default router;
