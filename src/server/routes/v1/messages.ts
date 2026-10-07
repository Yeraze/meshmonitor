/**
 * v1 API - Messages Endpoint
 *
 * Provides access to mesh network messages, including sending new messages
 * Respects user permissions - only returns messages from channels the user has read access to
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import { resolveSourceManager } from '../../utils/resolveSourceManager.js';
import { refuseNonMeshtasticSource } from '../../utils/requireMeshtasticDeviceSource.js';
import { parseMessageSearchQuery, searchReadableMessages } from '../../utils/messageSearch.js';
import { hasPermission } from '../../auth/authMiddleware.js';
import { ResourceType } from '../../../types/permission.js';
import { messageLimiter } from '../../middleware/rateLimiters.js';
import { logger } from '../../../utils/logger.js';
import { MAX_MESSAGE_BYTES, PortNum } from '../../constants/meshtastic.js';
import { loadV1Access, requireScopedSourceId } from './sourceParam.js';
import type { NodeViewAccess } from '../../utils/nodeEnhancer.js';
import { isTxDisabledError } from '../../errors/txDisabledError.js';

/** Maximum number of message parts allowed when splitting long messages */
const MAX_MESSAGE_PARTS = 3;

/**
 * The channel ids the token user may read ON THIS SOURCE, from grants already
 * loaded for the request. `null` means every channel (admin); -1 stands for
 * direct messages (`messages:read`).
 */
function getAccessibleChannels(access: NodeViewAccess, sourceId: string): Set<number> | null {
  if (access.isAdmin) return null;
  const accessibleChannels = new Set<number>();
  for (let i = 0; i <= 7; i++) {
    if (access.permissions.can(`channel_${i}` as ResourceType, 'read', sourceId)) {
      accessibleChannels.add(i);
    }
  }
  if (access.permissions.can('messages', 'read', sourceId)) {
    accessibleChannels.add(-1);
  }
  return accessibleChannels;
}

const router = express.Router({ mergeParams: true });

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
    const { channel, fromNodeId, toNodeId, since, limit } = req.query;
    const sourceIdStr = requireScopedSourceId(req, res);
    if (!sourceIdStr) return;
    const access = await loadV1Access(req);

    const maxLimit = parseInt(limit as string) || 100;
    const sinceTimestamp = since ? parseInt(since as string) : undefined;
    const channelNum = channel ? parseInt(channel as string) : undefined;

    // Get accessible channels for this user (scoped to source if provided)
    const accessibleChannels = getAccessibleChannels(access, sourceIdStr);

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
      messages = await databaseService.messages.getMessagesByChannel(channelNum, maxLimit, 0, sourceIdStr);
    } else if (sinceTimestamp) {
      messages = await databaseService.messages.getMessagesAfterTimestamp(sinceTimestamp, sourceIdStr);
      messages = messages.slice(0, maxLimit);
    } else {
      messages = await databaseService.messages.getMessages(maxLimit, 0, sourceIdStr, [PortNum.TRACEROUTE_APP]);
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
 * GET /api/v1/messages/search
 * Search messages across channels and DMs
 *
 * Query parameters:
 * - q: string (required) - Search query text
 * - caseSensitive: boolean - Whether search is case-sensitive (default: false)
 * - scope: string - Search scope: 'all', 'channels', 'dms', or 'meshcore' (default: 'all')
 * - channels: string - Comma-separated channel numbers to filter by
 * - fromNodeId: string - Filter by sender node ID
 * - startDate: number - Epoch milliseconds for range start
 * - endDate: number - Epoch milliseconds for range end
 * - limit: number - Max results to return (default: 50, max: 100)
 * - offset: number - Offset for pagination (default: 0)
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const searchSourceId = requireScopedSourceId(req, res);
    if (!searchSourceId) return;

    const parsed = parseMessageSearchQuery(req.query);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: parsed.message
      });
    }

    // `attachSource` already enforced `messages:read` on this source; the
    // shared search narrows further to readable channels / DMs in SQL, and
    // reads MeshCore history from the database whether or not the source is
    // connected.
    const { results, total } = await searchReadableMessages(user, searchSourceId, parsed.params);

    res.json({
      success: true,
      count: results.length,
      total,
      data: results
    });
  } catch (error) {
    logger.error('Error searching messages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to search messages'
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
    const { messageId } = req.params;
    const msgLookupSourceId = requireScopedSourceId(req, res);
    if (!msgLookupSourceId) return;
    const access = await loadV1Access(req);
    const allMessages = await databaseService.messages.getMessages(10000, 0, msgLookupSourceId);
    const message = allMessages.find(m => m.id === messageId);

    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Message ${messageId} not found`
      });
    }

    // Check permission for the message's channel (unless admin)
    if (!access.isAdmin) {
      const accessibleChannels = getAccessibleChannels(access, msgLookupSourceId);
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
 * - Long messages (>200 bytes) are automatically split and queued for delivery
 *   with 30-second intervals between parts
 *
 * Response:
 * - messageId: string - Unique message ID for tracking (format: nodeNum_requestId)
 * - requestId: number - Request ID for matching delivery acknowledgments (first message if split)
 * - deliveryState: string - Initial delivery state ("pending" or "queued")
 * - messageCount: number - Number of messages (>1 if the message was split)
 * - queueIds: string[] - Queue IDs for tracking split messages (only if split)
 */
router.post('/', messageLimiter, async (req: Request, res: Response) => {
  try {
    const { text, channel, toNodeId, replyId } = req.body;
    // Scope priority: path (:sourceId) → query → body.sourceId.
    const msgSourceId = requireScopedSourceId(req, res);
    if (!msgSourceId) return;
    const activeManager = resolveSourceManager(msgSourceId);

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
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, 'messages', 'write', msgSourceId) : false)) {
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
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'write', msgSourceId) : false)) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Insufficient permissions',
          required: { resource: channelResource, action: 'write' }
        });
      }
    }

    // An MQTT broker/bridge source has no radio of its own; resolveSourceManager()
    // would send through the PRIMARY TCP radio instead (#5375).
    if (await refuseNonMeshtasticSource(res, msgSourceId, 'message sends')) return;

    const meshChannel = channel !== undefined ? parseInt(channel) : 0;
    const trimmedText = text.trim();

    // Check if message needs to be split (exceeds Meshtastic's byte limit)
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(trimmedText);

    if (messageBytes.length > MAX_MESSAGE_BYTES) {
      // Split the message into chunks
      const messageParts = activeManager.splitMessageForMeshtastic(trimmedText, MAX_MESSAGE_BYTES);

      // Reject messages that would split into too many parts
      if (messageParts.length > MAX_MESSAGE_PARTS) {
        const maxBytes = MAX_MESSAGE_BYTES * MAX_MESSAGE_PARTS;
        logger.warn(`❌ v1 API: Message too long (${messageBytes.length} bytes, ${messageParts.length} parts) - max ${MAX_MESSAGE_PARTS} parts (~${maxBytes} bytes)`);
        return res.status(413).json({
          success: false,
          error: 'Payload Too Large',
          message: `Message too long. Would require ${messageParts.length} parts but maximum is ${MAX_MESSAGE_PARTS} parts (~${maxBytes} bytes)`
        });
      }

      logger.debug(`📝 v1 API: Splitting long message (${messageBytes.length} bytes) into ${messageParts.length} parts`);

      // Queue all parts through messageQueueService
      const queueIds: string[] = [];

      messageParts.forEach((part, index) => {
        const isFirstMessage = index === 0;

        const queueId = activeManager.messageQueue.enqueue(
          part,
          destinationNum || 0, // 0 for channel messages (broadcast)
          isFirstMessage ? replyId : undefined, // Only first message gets replyId
          () => {
            logger.debug(`✅ API message part ${index + 1}/${messageParts.length} delivered`);
          },
          (reason: string) => {
            logger.warn(`❌ API message part ${index + 1}/${messageParts.length} failed: ${reason}`);
          },
          destinationNum ? undefined : meshChannel // Channel for broadcast messages
        );

        queueIds.push(queueId);
      });

      logger.debug(`📤 v1 API: Queued ${messageParts.length} message parts (user: ${req.user?.username}, queueIds: ${queueIds.join(', ')})`);

      res.status(202).json({
        success: true,
        data: {
          deliveryState: 'queued',
          messageCount: messageParts.length,
          queueIds,
          text: trimmedText,
          channel: destinationNum ? -1 : meshChannel,
          toNodeId: toNodeId || 'broadcast',
          note: `Message split into ${messageParts.length} parts, queued for delivery with 30-second intervals`
        }
      });
    } else {
      // Message fits in one packet - send directly
      const requestId = await activeManager.sendTextMessage(
        trimmedText,
        meshChannel,
        destinationNum,
        replyId,
        undefined, // emoji
        req.user?.id
      );

      // Get local node info to construct messageId
      const localNodeNum = await databaseService.settings.getLocalNodeNumForSource(activeManager.sourceId);
      const messageId = localNodeNum ? `${localNodeNum}_${requestId}` : requestId.toString();

      logger.debug(`📤 v1 API: Sent message via API token (user: ${req.user?.username}, requestId: ${requestId})`);

      res.status(201).json({
        success: true,
        data: {
          messageId,
          requestId,
          deliveryState: 'pending',
          messageCount: 1,
          text: trimmedText,
          channel: destinationNum ? -1 : meshChannel,
          toNodeId: toNodeId || 'broadcast'
        }
      });
    }
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return res.status(409).json({ success: false, error: 'Transmit is disabled on this source', code: 'TX_DISABLED' });
    }
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
