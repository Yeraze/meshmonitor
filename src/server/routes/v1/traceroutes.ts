/**
 * v1 API - Traceroutes Endpoint
 *
 * Provides read-only access to traceroute data showing network paths
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/traceroutes
 * Get all traceroute records
 *
 * Query parameters:
 * - fromNodeId: string - Filter by source node
 * - toNodeId: string - Filter by destination node
 * - limit: number - Max number of records to return (default: 100)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const { fromNodeId, toNodeId, limit } = req.query;
    const maxLimit = parseInt(limit as string) || 100;

    let traceroutes = databaseService.getAllTraceroutes();

    // Apply filters
    if (fromNodeId) {
      traceroutes = traceroutes.filter(t => t.fromNodeId === fromNodeId);
    }
    if (toNodeId) {
      traceroutes = traceroutes.filter(t => t.toNodeId === toNodeId);
    }

    // Apply limit
    traceroutes = traceroutes.slice(0, maxLimit);

    res.json({
      success: true,
      count: traceroutes.length,
      data: traceroutes
    });
  } catch (error) {
    logger.error('Error getting traceroutes:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve traceroutes'
    });
  }
});

/**
 * GET /api/v1/traceroutes/:fromNodeId/:toNodeId
 * Get traceroute between two specific nodes
 */
router.get('/:fromNodeId/:toNodeId', (req: Request, res: Response) => {
  try {
    const { fromNodeId, toNodeId } = req.params;
    const allTraceroutes = databaseService.getAllTraceroutes(100);
    const traceroute = allTraceroutes.find(t => t.fromNodeId === fromNodeId && t.toNodeId === toNodeId);

    if (!traceroute) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `No traceroute found from ${fromNodeId} to ${toNodeId}`
      });
    }

    res.json({
      success: true,
      data: traceroute
    });
  } catch (error) {
    logger.error('Error getting traceroute:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve traceroute'
    });
  }
});

export default router;
