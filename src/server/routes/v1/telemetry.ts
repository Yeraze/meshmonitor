/**
 * v1 API - Telemetry Endpoint
 *
 * Provides read-only access to telemetry data from mesh nodes
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { checkNodeChannelAccess, maskTelemetryByChannel } from '../../utils/nodeEnhancer.js';

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
    const { nodeId, type, since, before, limit, offset, sourceId } = req.query;
    const sourceIdStr = typeof sourceId === 'string' ? sourceId : undefined;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    let telemetry;
    let total: number | undefined;

    if (nodeId) {
      // Check channel-based access for this node
      if (!await checkNodeChannelAccess(nodeId as string, (req as any).user, sourceIdStr)) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const typeStr = type ? type as string : undefined;
      telemetry = await databaseService.telemetry.getTelemetryByNode(nodeId as string, maxLimit, sinceTimestamp, beforeTimestamp, offsetNum, typeStr);
      total = await databaseService.telemetry.getTelemetryCountByNode(nodeId as string, sinceTimestamp, beforeTimestamp, typeStr);
    } else if (type) {
      telemetry = await databaseService.telemetry.getTelemetryByType(type as string, maxLimit);
      // Filter by since/before if provided
      if (sinceTimestamp) {
        telemetry = telemetry.filter(t => t.timestamp >= sinceTimestamp);
      }
      if (beforeTimestamp) {
        telemetry = telemetry.filter(t => t.timestamp < beforeTimestamp);
      }
      // Mask records from channels the user cannot access
      telemetry = await maskTelemetryByChannel(telemetry, (req as any).user, sourceIdStr);
    } else {
      // Get all telemetry by getting all nodes and their telemetry
      const nodes = await databaseService.nodes.getAllNodes();
      telemetry = [];
      const perNodeLimit = Math.max(1, Math.floor(maxLimit / 10));
      for (const node of nodes.slice(0, 10)) { // Limit to first 10 nodes to avoid huge response
        const nodeTelemetry = await databaseService.telemetry.getTelemetryByNode(node.nodeId, perNodeLimit, sinceTimestamp, beforeTimestamp);
        telemetry.push(...nodeTelemetry);
      }
      // Mask records from channels the user cannot access
      telemetry = await maskTelemetryByChannel(telemetry, (req as any).user, sourceIdStr);
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
router.get('/count', async (_req: Request, res: Response) => {
  try {
    const count = await databaseService.telemetry.getTelemetryCount();

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
    const sourceIdParam = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, (req as any).user, sourceIdParam)) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Insufficient permissions' });
    }

    const { type, since, before, limit, offset } = req.query;

    const maxLimit = Math.min(parseInt(limit as string) || 1000, 10000);
    const offsetNum = parseInt(offset as string) || 0;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const beforeTimestamp = before ? parseInt(before as string) : undefined;

    const typeStr = type ? type as string : undefined;
    const telemetry = await databaseService.telemetry.getTelemetryByNode(nodeId, maxLimit, sinceTimestamp, beforeTimestamp, offsetNum, typeStr);
    const total = await databaseService.telemetry.getTelemetryCountByNode(nodeId, sinceTimestamp, beforeTimestamp, typeStr);

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
