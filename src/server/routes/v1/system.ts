/**
 * API v1 - System Routes
 *
 * Read-only endpoints for system health and status
 */

import express, { Request, Response } from 'express';
import meshtasticManager from '../../meshtasticManager.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Health check
 *     description: Returns system health status
 *     responses:
 *       200:
 *         description: System is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: 'ok' }
 *                 timestamp: { type: number }
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: Date.now()
  });
});

/**
 * @openapi
 * /status:
 *   get:
 *     tags: [System]
 *     summary: Get system status
 *     description: Returns detailed system status including connection status
 *     responses:
 *       200:
 *         description: System status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 connected: { type: boolean }
 *                 nodeConnected: { type: boolean }
 *                 timestamp: { type: number }
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const status = meshtasticManager.getConnectionStatus();
    res.json({
      ...status,
      timestamp: Date.now()
    });
  } catch (error) {
    logger.error('Error fetching status:', error);
    res.status(500).json({
      error: 'Failed to fetch status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
