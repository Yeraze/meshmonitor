/**
 * Solar Monitoring Routes
 *
 * Routes for accessing solar production estimates from forecast.solar
 */

import { Router, Request, Response } from 'express';
import { solarMonitoringService } from '../services/solarMonitoringService.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * GET /api/solar/estimates
 * Get recent solar production estimates
 * Query params:
 *   - limit: number of estimates to return (default 100, max 1000)
 */
router.get('/estimates', async (_req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(_req.query.limit as string) || 100, 1000);
    const estimates = await solarMonitoringService.getRecentEstimates(limit);

    return res.json({
      count: estimates.length,
      estimates: estimates.map(est => ({
        timestamp: est.timestamp,
        datetime: new Date(est.timestamp * 1000).toISOString(),
        wattHours: est.watt_hours,
        fetchedAt: est.fetched_at,
        fetchedAtDatetime: new Date(est.fetched_at * 1000).toISOString()
      }))
    });
  } catch (error) {
    logger.error('Error getting solar estimates:', error);
    return res.status(500).json({ error: 'Failed to get solar estimates' });
  }
});

/**
 * GET /api/solar/estimates/range
 * Get solar production estimates for a specific time range
 * Query params:
 *   - start: start timestamp (unix seconds)
 *   - end: end timestamp (unix seconds)
 */
router.get('/estimates/range', async (_req: Request, res: Response) => {
  try {
    const start = parseInt(_req.query.start as string);
    const end = parseInt(_req.query.end as string);

    if (isNaN(start) || isNaN(end)) {
      return res.status(400).json({ error: 'Invalid start or end timestamp' });
    }

    if (start > end) {
      return res.status(400).json({ error: 'Start timestamp must be before end timestamp' });
    }

    const estimates = await solarMonitoringService.getEstimatesInRange(start, end);

    return res.json({
      count: estimates.length,
      start: start,
      end: end,
      estimates: estimates.map(est => ({
        timestamp: est.timestamp,
        datetime: new Date(est.timestamp * 1000).toISOString(),
        wattHours: est.watt_hours,
        fetchedAt: est.fetched_at,
        fetchedAtDatetime: new Date(est.fetched_at * 1000).toISOString()
      }))
    });
  } catch (error) {
    logger.error('Error getting solar estimates in range:', error);
    return res.status(500).json({ error: 'Failed to get solar estimates' });
  }
});

/**
 * POST /api/solar/trigger
 * Manually trigger a solar estimate fetch (for testing/debugging)
 */
router.post('/trigger', async (_req: Request, res: Response) => {
  try {
    await solarMonitoringService.triggerFetch();

    return res.json({
      success: true,
      message: 'Solar estimate fetch triggered'
    });
  } catch (error) {
    logger.error('Error triggering solar estimate fetch:', error);
    return res.status(500).json({ error: 'Failed to trigger solar estimate fetch' });
  }
});

export default router;
