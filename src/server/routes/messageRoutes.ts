import express from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';

const router = express.Router();

/**
 * Permission middleware - require messages:write for DM deletions
 */
const requireMessagesWrite: RequestHandler = (req, res, next) => {
  const user = (req as any).user;
  const userId = user?.id ?? null;

  // Get user permissions
  const permissions = userId !== null
    ? databaseService.permissionModel.getUserPermissionSet(userId)
    : {};

  // Check if user is admin
  const isAdmin = user?.isAdmin ?? false;

  if (isAdmin) {
    return next();
  }

  // Check messages:write permission
  const hasMessagesWrite = permissions.messages?.write === true;

  if (!hasMessagesWrite) {
    logger.warn(`❌ Permission denied for message deletion - messages:write=${hasMessagesWrite}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You need messages:write permission to delete messages'
    });
  }

  next();
};

/**
 * Permission middleware - require channel_0:write for channel message deletions
 */
const requireChannelsWrite: RequestHandler = (req, res, next) => {
  const user = (req as any).user;
  const userId = user?.id ?? null;

  // Get user permissions
  const permissions = userId !== null
    ? databaseService.permissionModel.getUserPermissionSet(userId)
    : {};

  // Check if user is admin
  const isAdmin = user?.isAdmin ?? false;

  if (isAdmin) {
    return next();
  }

  // Check channel_0:write permission (minimum channel permission)
  const hasChannelsWrite = permissions.channel_0?.write === true;

  if (!hasChannelsWrite) {
    logger.warn(`❌ Permission denied for channel message deletion - channel_0:write=${hasChannelsWrite}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You need channel_0:write permission to delete channel messages'
    });
  }

  next();
};

/**
 * DELETE /api/messages/:id
 * Delete a single message by ID
 * Note: Permission check is done inside the handler based on message type
 */
router.delete('/:id', (req, res) => {
  try {
    const messageId = req.params.id;
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    // Get permissions first (before checking message existence for security)
    const permissions = userId !== null
      ? databaseService.permissionModel.getUserPermissionSet(userId)
      : {};

    // Check if user has any write permission at all
    const hasAnyWritePermission = isAdmin ||
      permissions.messages?.write === true ||
      permissions.channel_0?.write === true;

    if (!hasAnyWritePermission) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You need either messages:write or channels:write permission to delete messages'
      });
    }

    // Now check if message exists
    const message = databaseService.getMessage(messageId);
    if (!message) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Message not found'
      });
    }

    // Determine if this is a channel or DM message
    const isChannelMessage = message.channel !== 0;

    // Check specific permission for this message type
    if (!isAdmin) {
      if (isChannelMessage) {
        const hasChannelsWrite = permissions.channel_0?.write === true;
        if (!hasChannelsWrite) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'You need channel_0:write permission to delete channel messages'
          });
        }
      } else {
        const hasMessagesWrite = permissions.messages?.write === true;
        if (!hasMessagesWrite) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'You need messages:write permission to delete direct messages'
          });
        }
      }
    }

    const deleted = databaseService.deleteMessage(messageId);

    if (!deleted) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Message not found or already deleted'
      });
    }

    logger.info(`🗑️ User ${user?.username || 'anonymous'} deleted message ${messageId} (channel: ${message.channel})`);

    // Log to audit log
    if (userId) {
      databaseService.auditLog(
        userId,
        'message_deleted',
        'messages',
        `Deleted message ${messageId} from ${isChannelMessage ? 'channel ' + message.channel : 'direct messages'}`,
        req.ip || null
      );
    }

    res.json({
      message: 'Message deleted successfully',
      id: messageId
    });
  } catch (error) {
    logger.error('❌ Error deleting message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/channels/:channelId/messages
 * Purge all messages from a specific channel
 */
router.delete('/channels/:channelId', requireChannelsWrite, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId, 10);
    const user = (req as any).user;

    if (isNaN(channelId)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid channel ID'
      });
    }

    const deletedCount = databaseService.purgeChannelMessages(channelId);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} messages from channel ${channelId}`);

    // Log to audit log
    if (user?.id) {
      databaseService.auditLog(
        user.id,
        'channel_messages_purged',
        'messages',
        `Purged ${deletedCount} messages from channel ${channelId}`,
        req.ip || null
      );
    }

    res.json({
      message: 'Channel messages purged successfully',
      channelId,
      deletedCount
    });
  } catch (error) {
    logger.error('❌ Error purging channel messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/direct-messages/:nodeNum/messages
 * Purge all direct messages with a specific node
 */
router.delete('/direct-messages/:nodeNum', requireMessagesWrite, (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    const deletedCount = databaseService.purgeDirectMessages(nodeNum);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} direct messages with node ${nodeNum}`);

    // Log to audit log
    if (user?.id) {
      databaseService.auditLog(
        user.id,
        'dm_messages_purged',
        'messages',
        `Purged ${deletedCount} direct messages with node ${nodeNum}`,
        req.ip || null
      );
    }

    res.json({
      message: 'Direct messages purged successfully',
      nodeNum,
      deletedCount
    });
  } catch (error) {
    logger.error('❌ Error purging direct messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
