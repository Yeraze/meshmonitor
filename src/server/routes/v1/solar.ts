/**
 * v1 API - per-node solar irradiance (#6523)
 *
 * Hourly Open-Meteo sunlight (W/m²) and cloud cover (%) at one node's grid
 * cell. Replaces the old single-location forecast.solar `wattHours` feed and
 * its `/range` route.
 */

import express, { Request, Response } from 'express';
import { getNodeIrradiance } from '../../utils/solarNodeCell.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/solar?sourceId=&nodeId=&start=&end=
 *
 * - sourceId, nodeId (required): `!hex` for Meshtastic, 64-hex public key for MeshCore
 * - start, end (optional, Unix seconds): default is the last 24 hours to 48 hours ahead
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : '';
    if (!sourceId) {
      return res.status(400).json({ success: false, error: 'Bad Request', message: 'sourceId is required' });
    }
    const now = Math.floor(Date.now() / 1000);
    const start = req.query.start !== undefined ? Number(req.query.start) : now - 86_400;
    const end = req.query.end !== undefined ? Number(req.query.end) : now + 2 * 86_400;
    const result = await getNodeIrradiance(
      req.user,
      sourceId,
      typeof req.query.nodeId === 'string' ? req.query.nodeId : '',
      start,
      end,
    );
    if (result.status !== 200) {
      return res.status(result.status).json({
        success: false,
        error: result.status === 403 ? 'Forbidden' : 'Bad Request',
        message: result.message,
      });
    }
    res.json({
      success: true,
      enabled: result.enabled,
      unit: { shortwaveRadiation: 'W/m²', cloudCover: '%' },
      count: result.points.length,
      data: result.points.map(p => ({ ...p, datetime: new Date(p.timestamp * 1000).toISOString() })),
    });
  } catch (error) {
    logger.error('Error getting solar irradiance:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Failed to retrieve solar irradiance' });
  }
});

export default router;
