/**
 * API v1 - Nodes Routes
 *
 * Read-only endpoints for mesh node information
 */

import express, { Request, Response } from 'express';
import meshtasticManager from '../../meshtasticManager.js';
import databaseService from '../../../services/database.js';
import { requirePermission } from '../../auth/authMiddleware.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * @openapi
 * /nodes:
 *   get:
 *     tags: [Nodes]
 *     summary: Get all nodes
 *     description: Returns a list of all mesh nodes with their current status and position
 *     responses:
 *       200:
 *         description: List of nodes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Node'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/', requirePermission('nodes', 'read'), (_req: Request, res: Response) => {
  try {
    const nodes = meshtasticManager.getAllNodes();
    res.json(nodes);
  } catch (error) {
    logger.error('Error fetching nodes:', error);
    res.status(500).json({
      error: 'Failed to fetch nodes',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @openapi
 * /nodes/active:
 *   get:
 *     tags: [Nodes]
 *     summary: Get active nodes
 *     description: Returns nodes that have been heard from in the last 24 hours
 *     responses:
 *       200:
 *         description: List of active nodes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Node'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/active', requirePermission('nodes', 'read'), (req: Request, res: Response) => {
  try {
    const hoursParam = req.query.hours;
    const hours = hoursParam ? parseInt(hoursParam as string) : 24;

    const allNodes = meshtasticManager.getAllNodes();
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

    const activeNodes = allNodes.filter(node => {
      const lastHeard = node.lastHeard ? node.lastHeard * 1000 : 0;
      return lastHeard >= cutoffTime;
    });

    res.json(activeNodes);
  } catch (error) {
    logger.error('Error fetching active nodes:', error);
    res.status(500).json({
      error: 'Failed to fetch active nodes',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @openapi
 * /nodes/{nodeId}/position-history:
 *   get:
 *     tags: [Nodes]
 *     summary: Get node position history
 *     description: Returns historical position data for a specific node
 *     parameters:
 *       - name: nodeId
 *         in: path
 *         required: true
 *         description: Node ID (hex format, e.g., !a1b2c3d4)
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         description: Maximum number of position records to return
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 1000
 *     responses:
 *       200:
 *         description: Position history
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   latitude: { type: number }
 *                   longitude: { type: number }
 *                   altitude: { type: number }
 *                   timestamp: { type: number }
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       404:
 *         $ref: '#/components/responses/NotFoundError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/:nodeId/position-history', requirePermission('nodes', 'read'), (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const limitParam = req.query.limit;
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 1000) : 100;

    const telemetry = databaseService.getTelemetryByNode(nodeId, limit * 3); // Get more to ensure we have enough lat/lon pairs

    const positions: Array<{ latitude: number; longitude: number; altitude?: number; timestamp: number }> = [];
    const seenTimestamps = new Set<number>();

    for (const t of telemetry) {
      if (t.telemetryType === 'latitude' && !seenTimestamps.has(t.timestamp)) {
        const lon = telemetry.find(x =>
          x.telemetryType === 'longitude' &&
          x.timestamp === t.timestamp
        );
        const alt = telemetry.find(x =>
          x.telemetryType === 'altitude' &&
          x.timestamp === t.timestamp
        );

        if (lon) {
          positions.push({
            latitude: t.value,
            longitude: lon.value,
            altitude: alt?.value,
            timestamp: t.timestamp
          });
          seenTimestamps.add(t.timestamp);
        }

        if (positions.length >= limit) break;
      }
    }

    res.json(positions);
  } catch (error) {
    logger.error('Error fetching position history:', error);
    res.status(500).json({
      error: 'Failed to fetch position history',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
