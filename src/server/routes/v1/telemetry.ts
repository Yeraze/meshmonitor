/**
 * v1 API - Telemetry Endpoint
 *
 * Provides read-only access to telemetry data from mesh nodes
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/telemetry
 * Get telemetry data for all nodes
 *
 * Query parameters:
 * - nodeId: string - Filter by specific node
 * - type: string - Filter by telemetry type (battery_level, temperature, etc.)
 * - since: number - Unix timestamp to filter data after this time
 * - limit: number - Max number of records to return (default: 1000)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const { nodeId, type, since, limit } = req.query;

    const maxLimit = parseInt(limit as string) || 1000;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;

    let telemetry;

    if (nodeId) {
      telemetry = databaseService.getTelemetryByNode(nodeId as string, maxLimit, sinceTimestamp);
      // Filter by type if provided
      if (type) {
        telemetry = telemetry.filter(t => t.telemetryType === type);
      }
    } else if (type) {
      telemetry = databaseService.getTelemetryByType(type as string, maxLimit);
      // Filter by since if provided
      if (sinceTimestamp) {
        telemetry = telemetry.filter(t => t.timestamp >= sinceTimestamp);
      }
    } else {
      // Get all telemetry by getting all nodes and their telemetry
      const nodes = databaseService.getAllNodes();
      telemetry = [];
      for (const node of nodes.slice(0, 10)) { // Limit to first 10 nodes to avoid huge response
        const nodeTelemetry = databaseService.getTelemetryByNode(node.nodeId, Math.floor(maxLimit / 10), sinceTimestamp);
        telemetry.push(...nodeTelemetry);
      }
    }

    res.json({
      success: true,
      count: telemetry.length,
      data: telemetry
    });
  } catch (error) {
    logger.error('Error getting telemetry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve telemetry data'
    });
  }
});

/**
 * GET /api/v1/telemetry/count
 * Get total count of telemetry records
 */
router.get('/count', (_req: Request, res: Response) => {
  try {
    const count = databaseService.getTelemetryCount();

    res.json({
      success: true,
      count
    });
  } catch (error) {
    logger.error('Error getting telemetry count:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve telemetry count'
    });
  }
});

/**
 * GET /api/v1/telemetry/:nodeId
 * Get all telemetry for a specific node
 */
router.get('/:nodeId', (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const { type, since, limit } = req.query;

    const maxLimit = parseInt(limit as string) || 1000;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;

    let telemetry = databaseService.getTelemetryByNode(nodeId, maxLimit, sinceTimestamp);

    // Filter by type if provided
    if (type) {
      telemetry = telemetry.filter(t => t.telemetryType === type);
    }

    res.json({
      success: true,
      count: telemetry.length,
      data: telemetry
    });
  } catch (error) {
    logger.error('Error getting node telemetry:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve node telemetry'
    });
  }
});

export default router;
