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
 * - since: number - Unix timestamp (ms) to filter data after this time
 * - before: number - Unix timestamp (ms) to filter data before this time
 * - limit: number - Max number of records to return (default: 1000)
 * - offset: number - Number of records to skip for pagination (default: 0)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { nodeId, type, since, before, limit, offset } = req.query;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    let telemetry;
    let total: number | undefined;

    if (nodeId) {
      const typeStr = type ? type as string : undefined;
      telemetry = await databaseService.getTelemetryByNodeAsync(nodeId as string, maxLimit, sinceTimestamp, beforeTimestamp, offsetNum, typeStr);
      total = await databaseService.getTelemetryCountByNodeAsync(nodeId as string, sinceTimestamp, beforeTimestamp, typeStr);
    } else if (type) {
      telemetry = await databaseService.getTelemetryByTypeAsync(type as string, maxLimit);
      // Filter by since/before if provided
      if (sinceTimestamp) {
        telemetry = telemetry.filter(t => t.timestamp >= sinceTimestamp);
      }
      if (beforeTimestamp) {
        telemetry = telemetry.filter(t => t.timestamp < beforeTimestamp);
      }
    } else {
      // Get all telemetry by getting all nodes and their telemetry
      const nodes = await databaseService.getAllNodesAsync();
      telemetry = [];
      const perNodeLimit = Math.max(1, Math.floor(maxLimit / 10));
      for (const node of nodes.slice(0, 10)) { // Limit to first 10 nodes to avoid huge response
        const nodeTelemetry = await databaseService.getTelemetryByNodeAsync(node.nodeId, perNodeLimit, sinceTimestamp, beforeTimestamp);
        telemetry.push(...nodeTelemetry);
      }
    }

    res.json({
      success: true,
      count: telemetry.length,
      total,
      offset: offsetNum,
      limit: maxLimit,
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
 *
 * Query parameters:
 * - type: string - Filter by telemetry type
 * - since: number - Unix timestamp (ms) to filter data after this time
 * - before: number - Unix timestamp (ms) to filter data before this time
 * - limit: number - Max number of records to return (default: 1000, max: 10000)
 * - offset: number - Number of records to skip for pagination (default: 0)
 */
router.get('/:nodeId', async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const { type, since, before, limit, offset } = req.query;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    const typeStr = type ? type as string : undefined;
    const telemetry = await databaseService.getTelemetryByNodeAsync(nodeId, maxLimit, sinceTimestamp, beforeTimestamp, offsetNum, typeStr);
    const total = await databaseService.getTelemetryCountByNodeAsync(nodeId, sinceTimestamp, beforeTimestamp, typeStr);

    res.json({
      success: true,
      count: telemetry.length,
      total,
      offset: offsetNum,
      limit: maxLimit,
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
