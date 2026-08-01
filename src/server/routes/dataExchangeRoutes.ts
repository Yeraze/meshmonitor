import { Router, Request, Response } from 'express';
import { requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';

const router: Router = Router();

router.get('/stats', requirePermission('dashboard', 'read'), async (req: Request, res: Response) => {
  try {
    const statsSourceId = req.query.sourceId as string | undefined;
    // intentional cross-source: stats totals span all sources when no sourceId is specified.
    // Resolved once — the bug this replaced was one of four copies of this
    // expression drifting from the other three.
    const statsScope = statsSourceId ?? ALL_SOURCES;
    const messageCount = await databaseService.messages.getMessageCount(statsScope);
    const nodeCount = await databaseService.nodes.getNodeCount(statsScope);
    const channelCount = await databaseService.channels.getChannelCount(statsScope);
    const messagesByDay = await databaseService.getMessagesByDayAsync(7, statsScope);

    res.json({
      messageCount,
      nodeCount,
      channelCount,
      messagesByDay,
    });
  } catch (error) {
    logger.error('Error fetching stats:', error);
    fail(res, 500, 'STATS_FAILED', 'Failed to fetch stats');
  }
});

router.post('/export', requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const data = await databaseService.exportDataAsync();
    res.json(data);
  } catch (error) {
    logger.error('Error exporting data:', error);
    fail(res, 500, 'EXPORT_FAILED', 'Failed to export data');
  }
});

router.post('/import', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const data = req.body;
    await databaseService.importDataAsync(data);
    ok(res);
  } catch (error) {
    logger.error('Error importing data:', error);
    fail(res, 500, 'IMPORT_FAILED', 'Failed to import data');
  }
});

export default router;
