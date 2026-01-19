/**
 * v1 API - Messages Endpoint
 *
 * Provides access to mesh network messages, including sending new messages
 * Respects user permissions - only returns messages from channels the user has read access to
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import meshtasticManager from '../../meshtasticManager.js';
import { hasPermission } from '../../auth/authMiddleware.js';
import { ResourceType } from '../../../types/permission.js';
import { messageLimiter } from '../../middleware/rateLimiters.js';
import { logger } from '../../../utils/logger.js';

/**
 * Get set of channel IDs the user has read access to
 */
async function getAccessibleChannels(userId: number | null, isAdmin: boolean): Promise<Set<number> | null> {
  // Admins can access all channels
  if (isAdmin) {
    return null; // null means all channels
  }

  // Get user permissions
  const permissions = userId !== null
    ? await databaseService.getUserPermissionSetAsync(userId)
    : {};

  // Build set of accessible channel IDs
  const accessibleChannels = new Set<number>();
  for (let i = 0; i <= 7; i++) {
    const channelResource = `channel_${i}` as ResourceType;
    if (permissions[channelResource]?.read === true) {
      accessibleChannels.add(i);
    }
  }

  // Also check if user has messages:read permission (for DMs)
  const hasMessagesRead = permissions.messages?.read === true;
  if (hasMessagesRead) {
    accessibleChannels.add(-1); // -1 represents DMs
  }

  return accessibleChannels;
}

const router = express.Router();

/**
 * GET /api/v1/messages
 * Get messages from the mesh network
 * Only returns messages from channels the user has read permission for
 *
 * Query parameters:
 * - channel: number - Filter by channel number
 * - fromNodeId: string - Filter by sender node
 * - toNodeId: string - Filter by recipient node
 * - since: number - Unix timestamp to filter messages after this time
 * - limit: number - Max number of records to return (default: 100)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    const { channel, fromNodeId, toNodeId, since, limit } = req.query;

    const maxLimit = parseInt(limit as string) || 100;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const channelNum = channel ? parseInt(channel as string) : undefined;

    // Get accessible channels for this user
    const accessibleChannels = await getAccessibleChannels(userId, isAdmin);

    // If requesting a specific channel, check permission first
    if (channelNum !== undefined && accessibleChannels !== null) {
      if (!accessibleChannels.has(channelNum)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource: `channel_${channelNum}`, action: 'read' }
        });
      }
    }

    let messages;

    if (channelNum !== undefined) {
      messages = databaseService.getMessagesByChannel(channelNum, maxLimit);
    } else if (sinceTimestamp) {
      messages = databaseService.getMessagesAfterTimestamp(sinceTimestamp);
      messages = messages.slice(0, maxLimit);
    } else {
      messages = databaseService.getMessages(maxLimit);
    }

    // Filter messages by accessible channels (unless admin)
    if (accessibleChannels !== null) {
      messages = messages.filter(m => {
        const msgChannel = m.channel ?? -1; // DMs have channel -1 or undefined
        return accessibleChannels.has(msgChannel);
      });
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
 * Requires read permission for the message's channel
 */
router.get('/:messageId', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

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

    // Check permission for the message's channel (unless admin)
    if (!isAdmin) {
      const accessibleChannels = await getAccessibleChannels(userId, isAdmin);
      const msgChannel = message.channel ?? -1; // DMs have channel -1 or undefined

      if (accessibleChannels !== null && !accessibleChannels.has(msgChannel)) {
        const resource = msgChannel === -1 ? 'messages' : `channel_${msgChannel}`;
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource, action: 'read' }
        });
      }
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
