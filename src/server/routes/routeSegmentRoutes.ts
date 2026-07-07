import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.get('/longest-active', requirePermission('info', 'read'), async (req: Request, res: Response) => {
  try {
    const segSourceId = req.query.sourceId as string | undefined;
    const segment = await databaseService.traceroutes.getLongestActiveRouteSegment(segSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted
    if (!segment) {
      res.json(null);
      return;
    }

    const fromNode = await databaseService.nodes.getNode(segment.fromNodeNum, segSourceId);
    const toNode = await databaseService.nodes.getNode(segment.toNodeNum, segSourceId);

    res.json({
      ...segment,
      fromNodeName: fromNode?.longName || segment.fromNodeId,
      toNodeName: toNode?.longName || segment.toNodeId,
    });
  } catch (error) {
    logger.error('Error fetching longest active route segment:', error);
    res.status(500).json({ error: 'Failed to fetch longest active route segment' });
  }
});

router.get('/record-holder', requirePermission('info', 'read'), async (req: Request, res: Response) => {
  try {
    const segSourceId = req.query.sourceId as string | undefined;
    const segment = await databaseService.traceroutes.getRecordHolderRouteSegment(segSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted
    if (!segment) {
      res.json(null);
      return;
    }

    const fromNode = await databaseService.nodes.getNode(segment.fromNodeNum, segSourceId);
    const toNode = await databaseService.nodes.getNode(segment.toNodeNum, segSourceId);

    res.json({
      ...segment,
      fromNodeName: fromNode?.longName || segment.fromNodeId,
      toNodeName: toNode?.longName || segment.toNodeId,
    });
  } catch (error) {
    logger.error('Error fetching record holder route segment:', error);
    res.status(500).json({ error: 'Failed to fetch record holder route segment' });
  }
});

router.delete('/record-holder', requirePermission('info', 'write'), async (req: Request, res: Response) => {
  try {
    const segSourceId = req.query.sourceId as string | undefined;
    await databaseService.clearRecordHolderSegmentAsync(segSourceId);
    res.json({ success: true, message: 'Record holder cleared' });
  } catch (error) {
    logger.error('Error clearing record holder:', error);
    res.status(500).json({ error: 'Failed to clear record holder' });
  }
});

export default router;
