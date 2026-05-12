import express, { Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { meshcoreManagerRegistry } from '../meshcoreRegistry.js';
import meshtasticManagerDefault from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';
import { ResourceType } from '../../types/permission.js';

const router = express.Router();

/**
 * Permission middleware - require messages:write for DM / node-scoped deletions.
 * Scoped to a source: caller must supply sourceId via body or query.
 */
const requireMessagesWrite: RequestHandler = async (req, res, next) => {
  const user = (req as any).user;
  const userId = user?.id ?? null;
  const isAdmin = user?.isAdmin ?? false;

  // Resolve sourceId from body or query — required for messages:write
  const rawSourceId = (req.body && req.body.sourceId) ?? (req.query && req.query.sourceId);
  if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '') {
    return res.status(400).json({
      error: 'Bad request',
      message: 'sourceId is required'
    });
  }
  if (typeof rawSourceId !== 'string') {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Invalid sourceId'
    });
  }
  const sourceId: string = rawSourceId;
  (req as any).scopedSourceId = sourceId;

  if (isAdmin) {
    return next();
  }

  // Check messages:write permission scoped to source
  const hasMessagesWrite = userId !== null
    ? await databaseService.checkPermissionAsync(userId, 'messages', 'write', sourceId)
    : false;

  if (!hasMessagesWrite) {
    logger.warn(`❌ Permission denied for message deletion - messages:write source=${sourceId}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: `You need messages:write permission for source ${sourceId} to delete messages`
    });
  }

  next();
};

/**
 * Permission middleware - require specific channel write permission for channel message deletions
 */
const requireChannelsWrite: RequestHandler = async (req, res, next) => {
  const user = (req as any).user;
  const userId = user?.id ?? null;
  const channelId = parseInt(req.params.channelId, 10);

  // Resolve sourceId from body or query — required for channel-write routes
  const rawSourceId = (req.body && req.body.sourceId) ?? (req.query && req.query.sourceId);
  if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '') {
    return res.status(400).json({
      error: 'Bad request',
      message: 'sourceId is required for channel write operations'
    });
  }
  if (typeof rawSourceId !== 'string') {
    return res.status(400).json({
      error: 'Bad request',
      message: 'Invalid sourceId'
    });
  }
  const sourceId: string = rawSourceId;
  (req as any).scopedSourceId = sourceId;

  // Check if user is admin
  const isAdmin = user?.isAdmin ?? false;

  if (isAdmin) {
    return next();
  }

  // Check specific channel write permission scoped to source
  const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
  const hasChannelWrite = userId !== null
    ? await databaseService.checkPermissionAsync(userId, channelResource, 'write', sourceId)
    : false;

  if (!hasChannelWrite) {
    logger.warn(`❌ Permission denied for channel message deletion - ${channelResource}:write source=${sourceId}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: `You need ${channelResource}:write permission for source ${sourceId} to delete messages from this channel`
    });
  }

  next();
};

/**
 * GET /api/messages/search
 * Search messages across channels and DMs
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    const { q, caseSensitive, scope, channels, fromNodeId, startDate, endDate, limit, offset, sourceId } = req.query;
    const sourceIdStr = typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : undefined;

    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Search query parameter "q" is required'
      });
    }

    const searchQuery = q.trim();
    const isCaseSensitive = caseSensitive === 'true';
    const searchScope = (scope as string) || 'all';
    const maxLimit = Math.min(parseInt(limit as string) || 50, 100);
    const searchOffset = parseInt(offset as string) || 0;

    let channelFilter: number[] | undefined;
    if (channels && typeof channels === 'string') {
      channelFilter = channels.split(',').map(c => parseInt(c.trim())).filter(c => !isNaN(c));
    }

    const startDateNum = startDate ? parseInt(startDate as string) : undefined;
    const endDateNum = endDate ? parseInt(endDate as string) : undefined;

    // Get accessible channels for permission filtering. When sourceId is given,
    // scope strictly to that source (no cross-source leak). When absent, union
    // across sources — caller then sees whatever the union allows. Results are
    // further filtered to sourceIdStr below when provided.
    let accessibleChannels: Set<number> | null = null;
    if (!isAdmin) {
      const permissions = userId !== null
        ? await databaseService.getUserPermissionSetAsync(userId, sourceIdStr)
        : {};

      accessibleChannels = new Set<number>();
      for (let i = 0; i <= 7; i++) {
        const channelResource = `channel_${i}` as ResourceType;
        if (permissions[channelResource]?.read === true) {
          accessibleChannels.add(i);
        }
      }
      if (permissions.messages?.read === true) {
        accessibleChannels.add(-1);
      }
    }

    const results: any[] = [];
    let total = 0;

    // Search standard messages (unless scope is meshcore-only)
    if (searchScope !== 'meshcore') {
      let effectiveChannelFilter = channelFilter;

      if (accessibleChannels !== null) {
        const accessibleArray = Array.from(accessibleChannels);
        if (effectiveChannelFilter) {
          effectiveChannelFilter = effectiveChannelFilter.filter(c => accessibleChannels!.has(c));
        } else {
          effectiveChannelFilter = accessibleArray;
        }
      }

      // Security: if a non-admin user has no accessible channels, the empty
      // filter array would be ignored by the repository layer and ALL messages
      // would be returned. Short-circuit to an empty result set instead.
      // See FINDING-2 (Phase 0.2 remediation).
      if (!isAdmin && effectiveChannelFilter !== undefined && effectiveChannelFilter.length === 0) {
        return res.json({ success: true, count: 0, total: 0, data: [] });
      }

      const searchResult = await databaseService.searchMessagesAsync({
        query: searchQuery,
        caseSensitive: isCaseSensitive,
        scope: searchScope === 'meshcore' ? 'all' : (searchScope as 'all' | 'channels' | 'dms'),
        channels: effectiveChannelFilter,
        fromNodeId: fromNodeId as string | undefined,
        startDate: startDateNum,
        endDate: endDateNum,
        limit: maxLimit,
        offset: searchOffset
      });

      // When sourceId is specified, restrict results to that source.
      const filtered = sourceIdStr
        ? searchResult.messages.filter((m: any) => m.sourceId === sourceIdStr)
        : searchResult.messages;

      results.push(...filtered.map(m => ({ ...m, source: 'standard' })));
      total += sourceIdStr ? filtered.length : searchResult.total;
    }

    // Search MeshCore messages (in-memory filter, across every registered source)
    const meshcoreManagers = meshcoreManagerRegistry.list().filter(m => m.isConnected());
    if ((searchScope === 'all' || searchScope === 'meshcore') && meshcoreManagers.length > 0) {
      const hasMeshcoreAccess = isAdmin || (accessibleChannels !== null && accessibleChannels.has(-1));

      if (hasMeshcoreAccess) {
        const allMeshcoreMessages = meshcoreManagers.flatMap(m => m.getRecentMessages(1000));
        const filtered = allMeshcoreMessages.filter(m => {
          if (!m.text) return false;
          const textMatch = isCaseSensitive
            ? m.text.includes(searchQuery)
            : m.text.toLowerCase().includes(searchQuery.toLowerCase());
          if (!textMatch) return false;
          if (startDateNum && m.timestamp < startDateNum) return false;
          if (endDateNum && m.timestamp > endDateNum) return false;
          if (fromNodeId && m.fromPublicKey !== fromNodeId) return false;
          return true;
        });

        total += filtered.length;
        const meshcoreSlice = filtered.slice(0, Math.max(0, maxLimit - results.length));
        results.push(...meshcoreSlice.map(m => ({ ...m, source: 'meshcore' })));
      }
    }

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
 * DELETE /api/messages/:id
 * Delete a single message by ID
 * Note: Permission check is done inside the handler based on message type
 */
router.delete('/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const isAdmin = user?.isAdmin ?? false;

    // Gate by "has any write grant" without cross-source leak: fetch the split
    // permission set and check if the user has messages:write or any channel_N:write
    // on ANY source. This preserves the pre-existing timing-safe "don't reveal
    // message existence" behavior; the specific per-source permission check happens
    // after we load the message and know its sourceId.
    const sets = userId !== null
      ? await databaseService.getUserPermissionSetsBySourceAsync(userId)
      : { global: {}, bySource: {} };

    const sourceMaps = Object.values(sets.bySource);
    const hasAnyWritePermission = isAdmin
      || sourceMaps.some(m => m.messages?.write === true)
      || sourceMaps.some(m => Object.keys(m).some(k => k.startsWith('channel_') && m[k as keyof typeof m]?.write === true));

    if (!hasAnyWritePermission) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You need either messages:write or write permission for at least one channel to delete messages'
      });
    }

    // Now check if message exists (async for multi-database support)
    const message = await databaseService.getMessageAsync(messageId);
    if (!message) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Message not found'
      });
    }

    // Determine if this is a channel or DM message
    const isChannelMessage = message.channel !== 0;
    const messageSourceId = (message as any).sourceId as string | undefined;

    // Check specific permission for this message type, scoped to the message's source
    if (!isAdmin) {
      if (!messageSourceId) {
        // Legacy message without sourceId — deny for per-source callers
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Message has no source association; cannot be deleted by non-admin'
        });
      }
      if (isChannelMessage) {
        const channelResource = `channel_${message.channel}` as import('../../types/permission.js').ResourceType;
        const hasChannelWrite = userId !== null
          ? await databaseService.checkPermissionAsync(userId, channelResource, 'write', messageSourceId)
          : false;
        if (!hasChannelWrite) {
          return res.status(403).json({
            error: 'Forbidden',
            message: `You need ${channelResource}:write permission for source ${messageSourceId} to delete messages from this channel`
          });
        }
      } else {
        const hasMessagesWrite = userId !== null
          ? await databaseService.checkPermissionAsync(userId, 'messages', 'write', messageSourceId)
          : false;
        if (!hasMessagesWrite) {
          return res.status(403).json({
            error: 'Forbidden',
            message: `You need messages:write permission for source ${messageSourceId} to delete direct messages`
          });
        }
      }
    }

    const deleted = await databaseService.messages.deleteMessage(messageId);

    if (!deleted) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Message not found or already deleted'
      });
    }

    logger.info(`🗑️ User ${user?.username || 'anonymous'} deleted message ${messageId} (channel: ${message.channel})`);

    // Log to audit log (async for multi-database support)
    if (userId) {
      await databaseService.auditLogAsync(
        userId,
        'message_deleted',
        'messages',
        `Deleted message ${messageId} from ${isChannelMessage ? 'channel ' + message.channel : 'direct messages'}`,
        req.ip || ''
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
router.delete('/channels/:channelId', requireChannelsWrite, async (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId, 10);
    const user = (req as any).user;
    // requireChannelsWrite already validated sourceId exists and stashed it on the request
    const sourceId: string = (req as any).scopedSourceId;

    if (isNaN(channelId)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid channel ID'
      });
    }

    const deletedCount = await databaseService.messages.purgeChannelMessages(channelId, sourceId);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} messages from channel ${channelId} (source=${sourceId})`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'channel_messages_purged',
        'messages',
        `Purged ${deletedCount} messages from channel ${channelId} (source=${sourceId})`,
        req.ip || ''
      );
    }

    res.json({
      message: 'Channel messages purged successfully',
      channelId,
      sourceId,
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
router.delete('/direct-messages/:nodeNum', requireMessagesWrite, async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    // sourceId is required so the purge is scoped to a single source.
    const rawSourceId = (req.body && req.body.sourceId) ?? (req.query && req.query.sourceId);
    if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '' || typeof rawSourceId !== 'string') {
      return res.status(400).json({
        error: 'Bad request',
        message: 'sourceId is required'
      });
    }
    const sourceId: string = rawSourceId;

    const deletedCount = await databaseService.messages.purgeDirectMessages(nodeNum, sourceId);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} direct messages with node ${nodeNum} (source=${sourceId})`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'dm_messages_purged',
        'messages',
        `Purged ${deletedCount} direct messages with node ${nodeNum} (source=${sourceId})`,
        req.ip || ''
      );
    }

    res.json({
      message: 'Direct messages purged successfully',
      nodeNum,
      sourceId,
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
router.delete('/nodes/:nodeNum/traceroutes', requireMessagesWrite, async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    const sourceId = (req.body?.sourceId || req.query?.sourceId) as string | undefined;
    if (!sourceId) {
      return res.status(400).json({ error: 'Bad request', message: 'sourceId is required' });
    }

    const deletedCount = await databaseService.traceroutes.deleteTraceroutesForNode(nodeNum, sourceId);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} traceroutes for node ${nodeNum} (source=${sourceId})`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'node_traceroutes_purged',
        'traceroute',
        `Purged ${deletedCount} traceroutes for node ${nodeNum} (source=${sourceId})`,
        req.ip || ''
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
router.delete('/nodes/:nodeNum/telemetry', requireMessagesWrite, async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    const sourceId = (req.body?.sourceId || req.query?.sourceId) as string | undefined;
    if (!sourceId) {
      return res.status(400).json({ error: 'Bad request', message: 'sourceId is required' });
    }

    const deletedCount = await databaseService.telemetry.purgeNodeTelemetry(nodeNum, sourceId);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} telemetry records for node ${nodeNum} (source=${sourceId})`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'node_telemetry_purged',
        'telemetry',
        `Purged ${deletedCount} telemetry records for node ${nodeNum} (source=${sourceId})`,
        req.ip || ''
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
 * DELETE /api/nodes/:nodeNum/position-history
 * Purge position history for a specific node
 */
router.delete('/nodes/:nodeNum/position-history', requireMessagesWrite, async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    const sourceId = (req.body?.sourceId || req.query?.sourceId) as string | undefined;
    if (!sourceId) {
      return res.status(400).json({ error: 'Bad request', message: 'sourceId is required' });
    }

    const deletedCount = await databaseService.telemetry.purgePositionHistory(nodeNum, sourceId);

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${deletedCount} position history records for node ${nodeNum} (source=${sourceId})`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'node_position_history_purged',
        'telemetry',
        `Purged ${deletedCount} position history records for node ${nodeNum} (source=${sourceId})`,
        req.ip || ''
      );
    }

    res.json({
      message: 'Node position history purged successfully',
      nodeNum,
      deletedCount
    });
  } catch (error: any) {
    logger.error('❌ Error purging node position history:', error);

    if (error?.message?.includes('FOREIGN KEY constraint failed')) {
      logger.error('Foreign key constraint violation during position history purge');
      return res.status(500).json({
        error: 'Database constraint error',
        message: 'Unable to purge position history due to database constraints. Please contact support.'
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/nodes/:nodeNum
 * Delete a node and all associated data from the local database
 */
router.delete('/nodes/:nodeNum', requireMessagesWrite, async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    const user = (req as any).user;

    if (isNaN(nodeNum)) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid node number'
      });
    }

    // Phase 3C2: require sourceId in body (query fallback for DELETE) to scope the delete
    const delSourceId = (req.body && typeof req.body.sourceId === 'string' && req.body.sourceId.length > 0
      ? req.body.sourceId
      : (typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0 ? req.query.sourceId as string : null));
    if (!delSourceId) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'sourceId is required (body or query)'
      });
    }

    // Get node name for logging (async for multi-database support)
    const nodes = await databaseService.nodes.getAllNodes(delSourceId);
    const node = nodes.find((n: any) => Number(n.nodeNum) === nodeNum);
    const nodeName = node?.shortName || node?.longName || `Node ${nodeNum}`;

    const result = await databaseService.deleteNodeAsync(nodeNum, delSourceId);

    if (!result.nodeDeleted) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Node not found'
      });
    }

    logger.info(`🗑️ User ${user?.username || 'anonymous'} deleted ${nodeName} (${nodeNum}) and all associated data`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'node_deleted',
        'nodes',
        `Deleted ${nodeName} (${nodeNum}) - ${result.messagesDeleted} messages, ${result.traceroutesDeleted} traceroutes, ${result.telemetryDeleted} telemetry records`,
        req.ip || ''
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

    // Get the meshtasticManager instance (source-aware)
    const { sourceId: purgeSourceId } = req.body || {};
    const meshtasticManager = purgeSourceId
      ? (sourceManagerRegistry.getManager(purgeSourceId) as typeof meshtasticManagerDefault ?? (global as any).meshtasticManager)
      : (global as any).meshtasticManager;
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

    // Get node name for logging (async for multi-database support)
    const nodes = await databaseService.nodes.getAllNodes();
    const node = nodes.find((n: any) => Number(n.nodeNum) === nodeNum);
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

    // Also delete from local database (async for multi-database support)
    if (!purgeSourceId) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'sourceId is required in body'
      });
    }
    const result = await databaseService.deleteNodeAsync(nodeNum, purgeSourceId);

    if (!result.nodeDeleted) {
      logger.warn(`⚠️ Node ${nodeNum} was removed from device but not found in local database`);
    }

    logger.info(`🗑️ User ${user?.username || 'anonymous'} purged ${nodeName} (${nodeNum}) from device and local database`);

    // Log to audit log (async for multi-database support)
    if (user?.id) {
      await databaseService.auditLogAsync(
        user.id,
        'node_purged_from_device',
        'nodes',
        `Purged ${nodeName} (${nodeNum}) from device NodeDB and local database - ${result.messagesDeleted} messages, ${result.traceroutesDeleted} traceroutes, ${result.telemetryDeleted} telemetry records`,
        req.ip || ''
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
