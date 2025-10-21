/**
 * API v1 - Channels Routes
 *
 * Read-only endpoints for channel information
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { requirePermission } from '../../auth/authMiddleware.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * @openapi
 * /channels:
 *   get:
 *     tags: [Channels]
 *     summary: Get all channels
 *     description: Returns a list of all configured channels
 *     responses:
 *       200:
 *         description: List of channels
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Channel'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/', requirePermission('channels', 'read'), (_req: Request, res: Response) => {
  try {
    const channels = databaseService.getAllChannels();

    // Don't expose PSK in API responses
    const sanitizedChannels = channels.map((channel: any) => ({
      id: channel.id,
      name: channel.name,
      uplinkEnabled: channel.uplinkEnabled,
      downlinkEnabled: channel.downlinkEnabled
    }));

    res.json(sanitizedChannels);
  } catch (error) {
    logger.error('Error fetching channels:', error);
    res.status(500).json({
      error: 'Failed to fetch channels',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
