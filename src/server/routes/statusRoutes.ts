import { Router, Request, Response } from 'express';
import { requireAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

const router = Router();

router.get('/virtual-node/status', requireAuth(), (_req: Request, res: Response) => {
  try {
    const managers = sourceManagerRegistry.getAllManagers() as any[];
    const sources = managers.map((mgr) => {
      const vn = mgr.virtualNodeServer;
      const status = mgr.getStatus?.();
      const sourceId = status?.sourceId ?? mgr.sourceId;
      const sourceName = status?.sourceName ?? sourceId;
      if (!vn) {
        return {
          sourceId,
          sourceName,
          enabled: false,
          isRunning: false,
          allowAdminCommands: false,
          clientCount: 0,
          clients: [],
        };
      }
      return {
        sourceId,
        sourceName,
        enabled: true,
        isRunning: vn.isRunning(),
        allowAdminCommands: vn.isAdminCommandsAllowed(),
        clientCount: vn.getClientCount(),
        clients: vn.getClientDetails(),
      };
    });

    res.json({ sources });
  } catch (error) {
    logger.error('Error getting virtual node status:', error);
    res.status(500).json({ error: 'Failed to get virtual node status' });
  }
});

router.get('/automation/airtime-status', requirePermission('automation', 'read'), async (req: Request, res: Response) => {
  try {
    const airtimeSourceId = (req.query.sourceId as string) || null;
    const mgr = resolveSourceManager(airtimeSourceId);
    res.json(await mgr.getAirtimeCutoffStatus());
  } catch (error) {
    logger.error('Error fetching airtime cutoff status:', error);
    res.status(500).json({ error: 'Failed to fetch airtime cutoff status' });
  }
});

export default router;
