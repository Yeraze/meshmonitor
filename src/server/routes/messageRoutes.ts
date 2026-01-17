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
 * Permission middleware - require specific channel write permission for channel message deletions
 */
const requireChannelsWrite: RequestHandler = (req, res, next) => {
  const user = (req as any).user;
  const userId = user?.id ?? null;
  const channelId = parseInt(req.params.channelId, 10);

  // Get user permissions
  const permissions = userId !== null
    ? databaseService.permissionModel.getUserPermissionSet(userId)
    : {};

  // Check if user is admin
  const isAdmin = user?.isAdmin ?? false;

  if (isAdmin) {
    return next();
  }

  // Check specific channel write permission
  const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
  const hasChannelWrite = permissions[channelResource]?.write === true;

  if (!hasChannelWrite) {
    logger.warn(`❌ Permission denied for channel message deletion - ${channelResource}:write=${hasChannelWrite}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: `You need ${channelResource}:write permission to delete messages from this channel`
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

    // Check if user has any write permission at all (messages or any channel)
    const hasMessagesWrite = permissions.messages?.write === true;
    const hasAnyChannelWrite = Object.keys(permissions).some(key =>
      key.startsWith('channel_') && permissions[key as keyof typeof permissions]?.write === true
    );
    const hasAnyWritePermission = isAdmin || hasMessagesWrite || hasAnyChannelWrite;

    if (!hasAnyWritePermission) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You need either messages:write or write permission for at least one channel to delete messages'
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
        const channelResource = `channel_${message.channel}` as import('../../types/permission.js').ResourceType;
        const hasChannelWrite = permissions[channelResource]?.write === true;
        if (!hasChannelWrite) {
          return res.status(403).json({
            error: 'Forbidden',
            message: `You need ${channelResource}:write permission to delete messages from this channel`
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
  } catch (error: any) {
    logger.error('❌ Error deleting message:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation - this may indicate orphaned message references');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to delete message due to database constraints. Please contact support.'
      });
    }

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
  } catch (error: any) {
    logger.error('❌ Error purging channel messages:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during channel purge');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to purge channel messages due to database constraints. Please contact support.'
      });
    }

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
  } catch (error: any) {
    logger.error('❌ Error purging direct messages:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during DM purge');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to purge direct messages due to database constraints. Please contact support.'
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/nodes/:nodeNum/traceroutes
 * Purge all traceroutes for a specific node
 */
router.delete('/nodes/:nodeNum/traceroutes', requireMessagesWrite, (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    const deletedCount = databaseService.purgeNodeTraceroutes(nodeNum);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} traceroutes for node ${nodeNum}`);

    // Log to audit log
    if (user?.id) {
      databaseService.auditLog(
        user.id,
        'node_traceroutes_purged',
        'traceroutes',
        `Purged ${deletedCount} traceroutes for node ${nodeNum}`,
        req.ip || null
      );
    }

    res.json({
      message: 'Node traceroutes purged successfully',
      nodeNum,
      deletedCount
    });
  } catch (error: any) {
    logger.error('❌ Error purging node traceroutes:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during traceroute purge');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to purge traceroutes due to database constraints. Please contact support.'
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/nodes/:nodeNum/telemetry
 * Purge all telemetry data for a specific node
 */
router.delete('/nodes/:nodeNum/telemetry', requireMessagesWrite, (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    const deletedCount = databaseService.purgeNodeTelemetry(nodeNum);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} telemetry records for node ${nodeNum}`);

    // Log to audit log
    if (user?.id) {
      databaseService.auditLog(
        user.id,
        'node_telemetry_purged',
        'telemetry',
        `Purged ${deletedCount} telemetry records for node ${nodeNum}`,
        req.ip || null
      );
    }

    res.json({
      message: 'Node telemetry purged successfully',
      nodeNum,
      deletedCount
    });
  } catch (error: any) {
    logger.error('❌ Error purging node telemetry:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during telemetry purge');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to purge telemetry due to database constraints. Please contact support.'
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/nodes/:nodeNum
 * Delete a node and all associated data from the local database
 */
router.delete('/nodes/:nodeNum', requireMessagesWrite, (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    // Get node name for logging
    const node = databaseService.getAllNodes().find((n: any) => n.nodeNum === nodeNum);
    const nodeName = node?.shortName || node?.longName || `Node ${nodeNum}`;

    const result = databaseService.deleteNode(nodeNum);

    if (!result.nodeDeleted) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Node not found'
      });
    }

    logger.info(`🗑️ User ${user?.username || 'anonymous'} deleted ${nodeName} (${nodeNum}) and all associated data`);

    // Log to audit log
    if (user?.id) {
      databaseService.auditLog(
        user.id,
        'node_deleted',
        'nodes',
        `Deleted ${nodeName} (${nodeNum}) - ${result.messagesDeleted} messages, ${result.traceroutesDeleted} traceroutes, ${result.telemetryDeleted} telemetry records`,
        req.ip || null
      );
    }

    res.json({
      message: 'Node deleted successfully',
      nodeNum,
      nodeName,
      messagesDeleted: result.messagesDeleted,
      traceroutesDeleted: result.traceroutesDeleted,
      telemetryDeleted: result.telemetryDeleted
    });
  } catch (error: any) {
    logger.error('❌ Error deleting node:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during node deletion');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to delete node due to database constraints. Please contact support.'
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/nodes/:nodeNum/purge-from-device
 * Purge a node from the connected Meshtastic device NodeDB AND from local database
 */
router.post('/nodes/:nodeNum/purge-from-device', requireMessagesWrite, async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    // Get the meshtasticManager instance
    const meshtasticManager = (global as any).meshtasticManager;
    if (!meshtasticManager) {
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Meshtastic manager not available'
      });
    }

    // Prevent purging the local node
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum;
    if (localNodeNum && nodeNum === localNodeNum) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Cannot purge the local node from itself'
      });
    }

    // Get node name for logging
    const node = databaseService.getAllNodes().find((n: any) => n.nodeNum === nodeNum);
    const nodeName = node?.shortName || node?.longName || `Node ${nodeNum}`;

    try {
      // Send admin message to remove node from device
      await meshtasticManager.sendRemoveNode(nodeNum);
      logger.info(`✅ Sent remove_by_nodenum admin command for ${nodeName} (${nodeNum})`);
    } catch (adminError: any) {
      logger.error('❌ Failed to send remove node admin command:', adminError);
      return res.status(500).json({
        error: 'Device communication error',
        message: `Failed to remove node from device: ${adminError.message || 'Unknown error'}`
      });
    }

    // Also delete from local database
    const result = databaseService.deleteNode(nodeNum);

    if (!result.nodeDeleted) {
      logger.warn(`⚠️ Node ${nodeNum} was removed from device but not found in local database`);
    }

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${nodeName} (${nodeNum}) from device and local database`);

    // Log to audit log
    if (user?.id) {
      databaseService.auditLog(
        user.id,
        'node_purged_from_device',
        'nodes',
        `Purged ${nodeName} (${nodeNum}) from device NodeDB and local database - ${result.messagesDeleted} messages, ${result.traceroutesDeleted} traceroutes, ${result.telemetryDeleted} telemetry records`,
        req.ip || null
      );
    }

    res.json({
      message: 'Node purged from device and local database successfully',
      nodeNum,
      nodeName,
      messagesDeleted: result.messagesDeleted,
      traceroutesDeleted: result.traceroutesDeleted,
      telemetryDeleted: result.telemetryDeleted
    });
  } catch (error: any) {
    logger.error('❌ Error purging node from device:', error);

    // Check for foreign key constraint errors
    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during node purge from device');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to purge node due to database constraints. Please contact support.'
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
