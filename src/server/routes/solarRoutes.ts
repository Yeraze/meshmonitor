/**
 * Solar Monitoring Routes
 *
 * Open-Meteo per-node sunlight (#6523): irradiance read, call-usage estimate
 * and manual refresh.
 */

import { Router, Request, Response } from 'express';
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
