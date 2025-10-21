/**
 * API v1 - Stats Routes
 *
 * Read-only endpoints for network statistics
 */

import express, { Request, Response } from 'express';
import meshtasticManager from '../../meshtasticManager.js';
import { requirePermission } from '../../auth/authMiddleware.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * @openapi
 * /:
 *   get:
 *     tags: [Stats]
 *     summary: Get network statistics
 *     description: Returns overall network statistics including node and message counts
 *     responses:
 *       200:
 *         description: Network statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stats'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/', requirePermission('dashboard', 'read'), (_req: Request, res: Response) => {
  try {
    const allNodes = meshtasticManager.getAllNodes();
    const cutoff24h = Date.now() - (24 * 60 * 60 * 1000);

    const nodesSeenLast24h = allNodes.filter(node => {
      const lastHeard = node.lastHeard ? node.lastHeard * 1000 : 0;
      return lastHeard >= cutoff24h;
    }).length;

    // Get message count (approximate based on recent messages)
    const recentMessages = meshtasticManager.getRecentMessages(1000);
    const messagesLast24h = recentMessages.filter(msg => {
      const msgTime = msg.timestamp.getTime();
      return msgTime >= cutoff24h;
    }).length;

    const stats = {
      totalNodes: allNodes.length,
      nodesSeenLast24h,
      messagesLast24h,
      timestamp: Date.now()
    };

    res.json(stats);
  } catch (error) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
