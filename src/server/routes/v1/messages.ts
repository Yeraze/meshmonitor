/**
 * v1 API - Messages Endpoint
 *
 * Provides access to mesh network messages, including sending new messages
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import meshtasticManager from '../../meshtasticManager.js';
import { hasPermission } from '../../auth/authMiddleware.js';
import { ResourceType } from '../../../types/permission.js';
import { messageLimiter } from '../../middleware/rateLimiters.js';
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

/**
 * POST /api/v1/messages
 * Send a new message to a channel or directly to a node
 *
 * Request body:
 * - text: string (required) - The message text to send
 * - channel: number (optional) - Channel number (0-7) to send to
 * - toNodeId: string (optional) - Node ID (e.g., "!a1b2c3d4") for direct message
 * - replyId: number (optional) - Request ID of message being replied to
 *
 * Notes:
 * - Either channel OR toNodeId must be provided, not both
 * - Channel messages require channel_X:write permission
 * - Direct messages require messages:write permission
 *
 * Response:
 * - messageId: string - Unique message ID for tracking (format: nodeNum_requestId)
 * - requestId: number - Request ID for matching delivery acknowledgments
 * - deliveryState: string - Initial delivery state ("pending")
 */
router.post('/', messageLimiter, async (req: Request, res: Response) => {
  try {
    const { text, channel, toNodeId, replyId } = req.body;

    // Validate text is provided
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Message text is required'
      });
    }

    // Validate that either channel OR toNodeId is provided, not both
    if (channel !== undefined && toNodeId !== undefined) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Provide either channel OR toNodeId, not both'
      });
    }

    if (channel === undefined && toNodeId === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Either channel or toNodeId is required'
      });
    }

    // Validate channel number if provided
    if (channel !== undefined) {
      const channelNum = parseInt(channel);
      if (isNaN(channelNum) || channelNum < 0 || channelNum > 7) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Channel must be a number between 0 and 7'
        });
      }
    }

    // Validate toNodeId format if provided
    let destinationNum: number | undefined;
    if (toNodeId !== undefined) {
      if (typeof toNodeId !== 'string' || !toNodeId.startsWith('!')) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'toNodeId must be a hex string starting with ! (e.g., !a1b2c3d4)'
        });
      }
      // Parse node ID to number (remove leading !)
      destinationNum = parseInt(toNodeId.substring(1), 16);
      if (isNaN(destinationNum)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Invalid node ID format'
        });
      }
    }

    // Validate replyId if provided
    if (replyId !== undefined && typeof replyId !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'replyId must be a number'
      });
    }

    // Permission checks
    if (destinationNum) {
      // Direct message - check messages:write permission
      if (!req.user?.isAdmin && !await hasPermission(req.user!, 'messages', 'write')) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource: 'messages', action: 'write' }
        });
      }
    } else {
      // Channel message - check per-channel write permission
      const channelNum = parseInt(channel);
      const channelResource = `channel_${channelNum}` as ResourceType;
      if (!req.user?.isAdmin && !await hasPermission(req.user!, channelResource, 'write')) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource: channelResource, action: 'write' }
        });
      }
    }

    // Send the message
    const meshChannel = channel !== undefined ? parseInt(channel) : 0;
    const requestId = await meshtasticManager.sendTextMessage(
      text.trim(),
      meshChannel,
      destinationNum,
      replyId,
      undefined, // emoji
      req.user?.id
    );

    // Get local node info to construct messageId
    const localNodeNum = databaseService.getSetting('localNodeNum');
    const messageId = localNodeNum ? `${localNodeNum}_${requestId}` : requestId.toString();

    logger.info(`📤 v1 API: Sent message via API token (user: ${req.user?.username}, requestId: ${requestId})`);

    res.status(201).json({
      success: true,
      data: {
        messageId,
        requestId,
        deliveryState: 'pending',
        text: text.trim(),
        channel: destinationNum ? -1 : meshChannel,
        toNodeId: toNodeId || 'broadcast'
      }
    });
  } catch (error: any) {
    logger.error('Error sending message via v1 API:', error);

    // Check for specific error types
    if (error.message?.includes('Not connected')) {
      return res.status(503).json({
        success: false,
        error: 'Service Unavailable',
        message: 'Not connected to Meshtastic node'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to send message'
    });
  }
});

export default router;
