/**
 * Solar Monitoring Routes
 *
 * Routes for accessing solar production estimates from forecast.solar
 */

import { Router, Request, Response } from 'express';
import { solarMonitoringService } from '../services/solarMonitoringService.js';
import { logger } from '../../utils/logger.js';
import { requireAdmin } from '../auth/authMiddleware.js';
import { requireSourceId } from '../utils/requireSourceId.js';
import { getNodeIrradiance } from '../utils/solarNodeCell.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  openMeteoSolarService,
  collectActivePositions,
  distinctCells,
  SOLAR_GRID_SIZES,
  FREE_DAILY_BUDGET,
} from '../services/openMeteoSolarService.js';

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
// Legacy forecast.solar trigger, removed with forecast.solar in the #6523
// follow-up. Admin-only meanwhile: it makes an outbound call.
router.post('/trigger', requireAdmin(), async (_req: Request, res: Response) => {
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

/**
 * GET /api/solar/irradiance?sourceId=&nodeId=&start=&end=  (#6523)
 * Hourly Open-Meteo sunlight (W/m²) and cloud cover (%) at one node's grid
 * cell. Same read gate as the node's telemetry graphs, plus the map's position
 * visibility gate: a viewer who can't see the node's position gets no points.
 */
router.get('/irradiance', requireSourceId('query'), async (req: Request, res: Response) => {
  try {
    const result = await getNodeIrradiance(
      req.user,
      req.query.sourceId as string,
      typeof req.query.nodeId === 'string' ? req.query.nodeId : '',
      Number(req.query.start),
      Number(req.query.end),
    );
    if (result.status !== 200) {
      return fail(res, result.status, result.status === 403 ? 'FORBIDDEN' : 'INVALID_REQUEST', result.message);
    }
    return ok(res, { enabled: result.enabled, points: result.points });
  } catch (error) {
    logger.error('Error getting solar irradiance:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to get solar irradiance');
  }
});

/**
 * GET /api/solar/usage  (admin, #6523)
 * Active node count and distinct cells per grid size, so Settings can show
 * Open-Meteo calls/day for each grid + refresh choice.
 */
router.get('/usage', requireAdmin(), async (_req: Request, res: Response) => {
  try {
    const positions = await collectActivePositions();
    const cellsByGrid = Object.fromEntries(
      SOLAR_GRID_SIZES.map(g => [String(g), distinctCells(positions, g).length]),
    );
    return ok(res, { activeNodes: positions.length, freeDailyBudget: FREE_DAILY_BUDGET, cellsByGrid });
  } catch (error) {
    logger.error('Error computing solar usage:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to compute solar usage');
  }
});

/**
 * POST /api/solar/refresh  (admin, #6523)
 * Start one Open-Meteo pass and return at once (a pass sleeps between chunks,
 * so awaiting it could outlive the request socket and get re-sent). Cells
 * refreshed within the interval are skipped and the daily call counter
 * applies, so this cannot spend more than a scheduled pass would.
 */
router.post('/refresh', requireAdmin(), (_req: Request, res: Response) => {
  void openMeteoSolarService.refresh();
  return ok(res, { started: true });
});

export default router;
