/**
 * v1 API - Messages Endpoint
 *
 * Provides read-only access to mesh network messages
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/v1/messages
 * Get messages from the mesh network
 *
 * Query parameters:
 * - channel: number - Filter by channel number
 * - fromNodeId: string - Filter by sender node
 * - toNodeId: string - Filter by recipient node
 * - since: number - Unix timestamp to filter messages after this time
 * - limit: number - Max number of records to return (default: 100)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const { channel, fromNodeId, toNodeId, since, limit } = req.query;

    const maxLimit = parseInt(limit as string) || 100;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const channelNum = channel ? parseInt(channel as string) : undefined;

    let messages;

    if (channelNum !== undefined) {
      messages = databaseService.getMessagesByChannel(channelNum, maxLimit);
    } else if (sinceTimestamp) {
      messages = databaseService.getMessagesAfterTimestamp(sinceTimestamp);
      messages = messages.slice(0, maxLimit);
    } else {
      messages = databaseService.getMessages(maxLimit);
    }

    // Apply additional filters
    if (fromNodeId) {
      messages = messages.filter(m => m.fromNodeId === fromNodeId);
    }
    if (toNodeId) {
      messages = messages.filter(m => m.toNodeId === toNodeId);
    }

    res.json({
      success: true,
      count: messages.length,
      data: messages
    });
  } catch (error) {
    logger.error('Error getting messages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve messages'
    });
  }
});

/**
 * GET /api/v1/messages/:messageId
 * Get a specific message by ID
 */
router.get('/:messageId', (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const allMessages = databaseService.getMessages(10000); // Get recent messages
    const message = allMessages.find(m => m.id === messageId);

    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Message ${messageId} not found`
      });
    }

    res.json({
      success: true,
      data: message
    });
  } catch (error) {
    logger.error('Error getting message:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve message'
    });
  }
});

export default router;
