import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.use(requireAdmin());

router.post('/messages', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const cleanupSourceId = req.body.sourceId as string | undefined;
    const deletedCount = await databaseService.cleanupOldMessagesAsync(days, cleanupSourceId);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up messages:', error);
    res.status(500).json({ error: 'Failed to cleanup messages' });
  }
});

router.post('/nodes', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const cleanupSourceId = req.body.sourceId as string | undefined;
    const deletedCount = await databaseService.cleanupInactiveNodesAsync(days, cleanupSourceId);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up nodes:', error);
    res.status(500).json({ error: 'Failed to cleanup nodes' });
  }
});

router.post('/channels', async (req: Request, res: Response) => {
  try {
    const cleanupSourceId = req.body?.sourceId as string | undefined;
    const deletedCount = await databaseService.cleanupInvalidChannelsAsync(cleanupSourceId);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up channels:', error);
    res.status(500).json({ error: 'Failed to cleanup channels' });
  }
});

export default router;
