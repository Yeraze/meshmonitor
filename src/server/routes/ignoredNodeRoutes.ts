import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireSourcePermission, getSourceTarget } from '../utils/sourceScopedAccess.js';
import { fail } from '../utils/apiResponse.js';

const router = Router();

// Both routes serve every source type (the ignore list is rows, not a radio).
// The permission is checked on the source the list belongs to: the named one,
// else the first enabled source the caller holds it on. `resolveRequestSourceId`
// used to accept a named id here without checking the permission on it.

router.get('/', requireSourcePermission('nodes', 'read', { whenOmitted: 'first-permitted' }), async (req: Request, res: Response) => {
  try {
    const listSourceId = getSourceTarget(req).sourceId as string;
    const ignoredNodes = await databaseService.ignoredNodes.getIgnoredNodesAsync(listSourceId);
    res.json(ignoredNodes);
  } catch (error) {
    logger.error('Error fetching ignored nodes:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch ignored nodes', {
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

router.delete('/:nodeId', requireSourcePermission('nodes', 'write', { whenOmitted: 'first-permitted' }), async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;

    const nodeNumStr = nodeId.replace('!', '');

    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      fail(res, 400, 'INVALID_NODE_ID', 'Invalid nodeId format', {
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      });
      return;
    }

    const deleteSourceId = getSourceTarget(req).sourceId as string;
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
