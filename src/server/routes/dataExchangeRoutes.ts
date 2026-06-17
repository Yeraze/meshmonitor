import { Router, Request, Response } from 'express';
import { requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router: Router = Router();

router.get('/stats', requirePermission('dashboard', 'read'), async (req: Request, res: Response) => {
  try {
    const statsSourceId = req.query.sourceId as string | undefined;
    const messageCount = await databaseService.messages.getMessageCount(statsSourceId);
    const nodeCount = await databaseService.nodes.getNodeCount(statsSourceId);
    const channelCount = await databaseService.channels.getChannelCount(statsSourceId);
    const messagesByDay = await databaseService.getMessagesByDayAsync(7, statsSourceId);

    res.json({
      messageCount,
      nodeCount,
      channelCount,
      messagesByDay,
    });
  } catch (error) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.post('/export', requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const data = await databaseService.exportDataAsync();
    res.json(data);
  } catch (error) {
    logger.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

router.post('/import', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const data = req.body;
    await databaseService.importDataAsync(data);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error importing data:', error);
    res.status(500).json({ error: 'Failed to import data' });
  }
});

export default router;
