/**
 * v1 API - Solar Estimates Endpoint
 *
 * Provides read-only access to solar production estimates from forecast.solar
 */

import express, { Request, Response } from 'express';
import { solarMonitoringService } from '../../services/solarMonitoringService.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/solar
 * Get recent solar production estimates
 *
 * Query parameters:
 * - limit: number - Max number of records to return (default: 100, max: 1000)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const estimates = await solarMonitoringService.getRecentEstimates(limit);

    res.json({
      success: true,
      count: estimates.length,
      data: estimates.map(est => ({
        timestamp: est.timestamp,
        datetime: new Date(est.timestamp * 1000).toISOString(),
        wattHours: est.watt_hours,
        fetchedAt: est.fetched_at
      }))
    });
  } catch (error) {
    logger.error('Error getting solar estimates:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve solar estimates'
    });
  }
});

/**
 * GET /api/v1/solar/range
 * Get solar production estimates for a specific time range
 *
 * Query parameters:
 * - start: number - Start timestamp (unix seconds)
 * - end: number - End timestamp (unix seconds)
 */
router.get('/range', async (req: Request, res: Response) => {
  try {
    const start = parseInt(req.query.start as string);
    const end = parseInt(req.query.end as string);

    if (isNaN(start) || isNaN(end)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid start or end timestamp'
      });
    }

    if (start > end) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Start timestamp must be before end timestamp'
      });
    }

    const estimates = await solarMonitoringService.getEstimatesInRange(start, end);

    res.json({
      success: true,
      count: estimates.length,
      start,
      end,
      data: estimates.map(est => ({
        timestamp: est.timestamp,
        datetime: new Date(est.timestamp * 1000).toISOString(),
        wattHours: est.watt_hours,
        fetchedAt: est.fetched_at
      }))
    });
  } catch (error) {
    logger.error('Error getting solar estimates in range:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve solar estimates'
    });
  }
});

export default router;
