/**
 * API v1 - Telemetry Routes
 *
 * Read-only endpoints for node telemetry data
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { requirePermission } from '../../auth/authMiddleware.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * @openapi
 * /{nodeId}:
 *   get:
 *     tags: [Telemetry]
 *     summary: Get telemetry for a node
 *     description: Returns telemetry data for a specific node
 *     parameters:
 *       - name: nodeId
 *         in: path
 *         required: true
 *         description: Node ID (hex format)
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         description: Maximum number of telemetry records to return
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 1000
 *     responses:
 *       200:
 *         description: Telemetry data
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   telemetryType: { type: string }
 *                   value: { type: number }
 *                   unit: { type: string }
 *                   timestamp: { type: number }
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/:nodeId', requirePermission('info', 'read'), (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const limitParam = req.query.limit;
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 1000) : 100;

    const telemetry = databaseService.getTelemetryByNode(nodeId, limit);

    res.json(telemetry);
  } catch (error) {
    logger.error('Error fetching telemetry:', error);
    res.status(500).json({
      error: 'Failed to fetch telemetry',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @openapi
 * /available/nodes:
 *   get:
 *     tags: [Telemetry]
 *     summary: Get nodes with telemetry data
 *     description: Returns a list of node IDs that have telemetry data available
 *     responses:
 *       200:
 *         description: List of node IDs with telemetry
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/available/nodes', requirePermission('info', 'read'), (_req: Request, res: Response) => {
  try {
    const nodes = databaseService.getAllNodes();
    const nodesWithTelemetry: string[] = [];

    // Efficient bulk query: get all telemetry types for all nodes at once
    const nodeTelemetryTypes = databaseService.getAllNodesTelemetryTypes();

    nodes.forEach(node => {
      const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
      if (telemetryTypes && telemetryTypes.length > 0) {
        nodesWithTelemetry.push(node.nodeId);
      }
    });

    res.json({ nodes: nodesWithTelemetry });
  } catch (error) {
    logger.error('Error fetching nodes with telemetry:', error);
    res.status(500).json({
      error: 'Failed to fetch nodes with telemetry',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
