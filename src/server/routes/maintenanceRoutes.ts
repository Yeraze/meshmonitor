import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import { databaseMaintenanceService } from '../services/databaseMaintenanceService.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.get('/status', requirePermission('configuration', 'read'), async (_req: Request, res: Response) => {
  try {
    const status = await databaseMaintenanceService.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('❌ Error getting maintenance status:', error);
    res.status(500).json({
      error: 'Failed to get maintenance status',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/size', requirePermission('configuration', 'read'), async (_req: Request, res: Response) => {
  try {
    const size = await databaseMaintenanceService.getDatabaseSizeAsync();
    res.json({
      size,
      formatted: databaseMaintenanceService.formatBytes(size),
    });
  } catch (error) {
    logger.error('❌ Error getting database size:', error);
    res.status(500).json({
      error: 'Failed to get database size',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/run', requirePermission('configuration', 'write'), async (_req: Request, res: Response) => {
  try {
    logger.debug('🔧 Manual database maintenance requested...');
    const stats = await databaseMaintenanceService.runMaintenance();
    res.json({
      success: true,
      stats,
      message: `Maintenance complete: deleted ${stats.messagesDeleted + stats.traceroutesDeleted + stats.routeSegmentsDeleted + stats.neighborInfoDeleted} records, saved ${databaseMaintenanceService.formatBytes(stats.sizeBefore - stats.sizeAfter)}`,
    });
  } catch (error) {
    logger.error('❌ Error running maintenance:', error);
    res.status(500).json({
      error: 'Failed to run maintenance',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
