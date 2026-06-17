import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.get('/recent', async (req: Request, res: Response) => {
  try {
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    let limit: number;
    if (req.query.limit) {
      limit = parseInt(req.query.limit as string);
    } else {
      const tracerouteIntervalMinutes = parseInt(await databaseService.settings.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);
    }

    const recentSourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    const allTraceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, recentSourceId);

    const recentTraceroutes = allTraceroutes.filter(tr => tr.timestamp >= cutoffTime);

    const traceroutesWithHops = recentTraceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
        }
      } catch (e) {
        hopCount = 999;
      }
      return { ...tr, hopCount };
    });

    res.json(traceroutesWithHops);
  } catch (error) {
    logger.error('Error fetching recent traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch recent traceroutes' });
  }
});

router.get('/history/:fromNodeNum/:toNodeNum', requirePermission('traceroute', 'read', { sourceIdFrom: 'query' }), async (req: Request, res: Response) => {
  try {
    const fromNodeNum = parseInt(req.params.fromNodeNum);
    const toNodeNum = parseInt(req.params.toNodeNum);
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const historySourceId = req.query.sourceId as string | undefined;

    if (isNaN(fromNodeNum) || isNaN(toNodeNum)) {
      res.status(400).json({ error: 'Invalid node numbers provided' });
      return;
    }

    if (fromNodeNum < 0 || fromNodeNum > 0xffffffff || toNodeNum < 0 || toNodeNum > 0xffffffff) {
      res.status(400).json({ error: 'Node numbers must be between 0 and 4294967295' });
      return;
    }

    if (isNaN(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: 'Limit must be between 1 and 1000' });
      return;
    }

    const traceroutes = await databaseService.traceroutes.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit, historySourceId);

    const traceroutesWithHops = traceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
        }
      } catch (e) {
        hopCount = 999;
      }
      return { ...tr, hopCount };
    });

    res.json(traceroutesWithHops);
  } catch (error) {
    logger.error('Error fetching traceroute history:', error);
    res.status(500).json({ error: 'Failed to fetch traceroute history' });
  }
});

export default router;
