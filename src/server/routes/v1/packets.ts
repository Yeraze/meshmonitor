/**
 * v1 API - Packets Endpoint
 *
 * Provides access to raw packet log data from the mesh network
 */

import express from 'express';
import packetLogService from '../../services/packetLogService.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/packets
 * Get packet logs with optional filtering
 */
router.get('/', async (req, res) => {
  try {
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    let limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    // Enforce maximum limit to prevent unbounded queries
    const MAX_LIMIT = packetLogService.getMaxCount();
    if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }
    if (limit < 1) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Limit must be at least 1'
      });
    }
    if (offset < 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Offset must be non-negative'
      });
    }

    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const to_node = req.query.to_node ? parseInt(req.query.to_node as string, 10) : undefined;
    const channel = req.query.channel ? parseInt(req.query.channel as string, 10) : undefined;
    const encrypted = req.query.encrypted === 'true' ? true : req.query.encrypted === 'false' ? false : undefined;
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;

    const filterOptions = { portnum, from_node, to_node, channel, encrypted, since };

    const [packets, total] = await Promise.all([
      packetLogService.getPacketsAsync({
        offset,
        limit,
        ...filterOptions
      }),
      packetLogService.getPacketCountAsync(filterOptions)
    ]);

    res.json({
      success: true,
      count: packets.length,
      total,
      offset,
      limit,
      data: packets
    });
  } catch (error) {
    logger.error('❌ Error fetching packet logs:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve packet logs'
    });
  }
});

/**
 * GET /api/v1/packets/:id
 * Get single packet by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid packet ID'
      });
    }

    const packet = await packetLogService.getPacketByIdAsync(id);
    if (!packet) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Packet not found'
      });
    }

    res.json({
      success: true,
      data: packet
    });
  } catch (error) {
    logger.error('❌ Error fetching packet:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve packet'
    });
  }
});

export default router;
