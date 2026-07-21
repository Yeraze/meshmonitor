import express, { Request, Response } from 'express';
import databaseService, { DbMessage } from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { isMeshCoreManager, isMeshtasticManager } from '../sourceManagerTypes.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';
import { ResourceType } from '../../types/permission.js';
import meshtasticManager from '../meshtasticManager.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { optionalAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannelNumber,
  isVirtualChannelNumber,
  virtualChannelDbId,
  hasAnyReadableVirtualChannel,
} from '../utils/virtualChannelPermissions.js';
import { parseDestinationNum } from '../utils/parseDestination.js';
import { transformDbMessageToMeshMessage } from '../utils/transformDbMessage.js';
import { filterNodesByChannelPermission } from '../utils/nodeEnhancer.js';

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
    const meshcoreManagers = sourceManagerRegistry.getAllManagers().filter((m): m is MeshCoreManager => isMeshCoreManager(m) && m.isConnected());
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
    const _purgeBase = purgeSourceId ? sourceManagerRegistry.getManager(purgeSourceId) : null;
    const meshtasticManager = (_purgeBase && isMeshtasticManager(_purgeBase))
      ? _purgeBase
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

    // Get node name for logging (async for multi-database support).
    // Use purgeSourceId if available; fall back to ALL_SOURCES for the name lookup (log-only, low stakes).
    const nameScope = (typeof purgeSourceId === 'string' && purgeSourceId.length > 0) ? purgeSourceId : ALL_SOURCES;
    const nodes = await databaseService.nodes.getAllNodes(nameScope);
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

/**
 * GET /api/messages
 * List recent messages, filtered by channel/DM permissions.
 * Extracted verbatim from server.ts (was `apiRouter.get('/messages', ...)`, L2273).
 */
router.get('/', optionalAuth(), async (req, res) => {
  try {
    // Check if user has either any channel permission or messages permission
    const isAdmin = req.user?.isAdmin === true;
    const hasChannelsRead = isAdmin || (req.user ? await hasPermission(req.user, 'channel_0', 'read') : false);
    const hasMessagesRead = isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read') : false);
    // Virtual (Channel Database) channels are gated by per-entry `canRead`
    // grants, not the channel_0..7 RBAC resources. Load them so virtual-channel
    // readers — including MQTT-bridge and anonymous users — can see their
    // messages instead of getting a blanket 403 / empty list.
    const readableVirtual = await getUserReadableVirtualChannelIds(req.user, isAdmin);

    if (!hasChannelsRead && !hasMessagesRead && !hasAnyReadableVirtualChannel(readableVirtual)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' },
      });
    }

    const limit = parseInt(req.query.limit as string) || 100;
    const messagesSourceId = req.query.sourceId as string | undefined;
    let messages = await meshtasticManager.getRecentMessages(limit, messagesSourceId);

    // MM-SEC-3: pre-compute the channels this caller may read so we can
    // strip messages from hidden channels even when the caller has the
    // generic `channel_0:read` permission.
    const authorizedChannelIds = new Set<number>();
    if (isAdmin) {
      for (let id = 0; id <= 7; id++) authorizedChannelIds.add(id);
    } else if (req.user) {
      for (let id = 0; id <= 7; id++) {
        const channelResource = `channel_${id}` as import('../../types/permission.js').ResourceType;
        if (await hasPermission(req.user, channelResource, 'read')) authorizedChannelIds.add(id);
      }
    }

    // Filter messages based on permissions.
    // - DMs (channel -1) require `messages:read`.
    // - Virtual (Channel Database) channels require a per-entry `canRead`
    //   grant — the channel_0..7 gate can never authorize a >= CHANNEL_DB_OFFSET
    //   slot.
    // - Physical channel messages require BOTH the legacy `channel_0:read` gate
    //   above AND a per-channel `channel_${id}:read` for the message's actual
    //   channel.
    messages = messages.filter(msg => {
      if (msg.channel === -1) return hasMessagesRead;
      if (isVirtualChannelNumber(msg.channel)) {
        // readableVirtual resolves to 'all' for admins, so this already grants
        // them every virtual channel — no separate isAdmin short-circuit needed.
        return canReadVirtualChannelNumber(msg.channel, readableVirtual);
      }
      return hasChannelsRead && (isAdmin || authorizedChannelIds.has(msg.channel));
    });

    res.json(messages);
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * GET /api/messages/channel/:channel
 * Extracted verbatim from server.ts (was L2380).
 */
router.get('/channel/:channel', optionalAuth(), async (req, res) => {
  try {
    const requestedChannel = parseInt(req.params.channel);
    // Validate and clamp limit (1-500) and offset (0-50000) to prevent abuse
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500));
    const offset = Math.max(0, Math.min(parseInt(req.query.offset as string) || 0, 50000));
    // Optional source scope — when provided, messages are filtered to that
    // source. Without it, the legacy unscoped behavior is preserved so older
    // clients still work.
    const sourceIdParam = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;

    // Check if this is a Primary channel request and map to channel 0 messages
    let messageChannel = requestedChannel;
    // In Meshtastic, channel 0 is always the Primary channel
    // If the requested channel is 0, use it directly
    if (requestedChannel === 0) {
      messageChannel = 0;
    }

    // Check per-channel read permission. Virtual (Channel Database) channels
    // live at >= CHANNEL_DB_OFFSET and are gated by per-entry `canRead` grants
    // rather than a `channel_${n}` RBAC resource (which is only defined for
    // slots 0..7).
    if (isVirtualChannelNumber(messageChannel)) {
      const isAdmin = req.user?.isAdmin === true;
      const readableVirtual = await getUserReadableVirtualChannelIds(req.user, isAdmin);
      if (!isAdmin && !canReadVirtualChannelNumber(messageChannel, readableVirtual)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: `channel_database:${virtualChannelDbId(messageChannel)}`, action: 'read' },
        });
      }
    } else {
      const channelResource = `channel_${messageChannel}` as import('../../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'read') : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'read' },
        });
      }
    }

    // Fetch limit+1 to accurately detect if more messages exist. When a sourceId
    // is provided, bypass the sync facade (which doesn't accept sourceId) and
    // go directly through the repository so the query is source-scoped.
    const dbMessages = sourceIdParam
      ? (await databaseService.messages.getMessagesByChannel(messageChannel, limit + 1, offset, sourceIdParam)) as DbMessage[]
      : await databaseService.getMessagesByChannelAsync(messageChannel, limit + 1, offset);
    const hasMore = dbMessages.length > limit;
    // Return only the requested limit
    const messages = dbMessages.slice(0, limit).map(transformDbMessageToMeshMessage);
    res.json({ messages, hasMore });
  } catch (error) {
    logger.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

/**
 * GET /api/messages/direct/:nodeId1/:nodeId2
 * Extracted verbatim from server.ts (was L2442).
 */
router.get('/direct/:nodeId1/:nodeId2', requirePermission('messages', 'read'), async (req, res) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    // Validate and clamp limit (1-500) and offset (0-50000) to prevent abuse
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500));
    const offset = Math.max(0, Math.min(parseInt(req.query.offset as string) || 0, 50000));
    // Optional source scope — DM threads are per-source (each source has its
    // own view of a node pair). When omitted, returns DMs across every source.
    const sourceIdParam = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    // Fetch limit+1 to accurately detect if more messages exist
    const dbMessages = await databaseService.messages.getDirectMessages(nodeId1, nodeId2, limit + 1, offset, sourceIdParam ?? ALL_SOURCES) as DbMessage[]; // intentional cross-source when sourceId omitted
    const hasMore = dbMessages.length > limit;
    // Return only the requested limit
    const messages = dbMessages.slice(0, limit).map(transformDbMessageToMeshMessage);
    res.json({ messages, hasMore });
  } catch (error) {
    logger.error('Error fetching direct messages:', error);
    res.status(500).json({ error: 'Failed to fetch direct messages' });
  }
});

/**
 * POST /api/messages/mark-read
 * Extracted verbatim from server.ts (was L2466).
 */
router.post('/mark-read', optionalAuth(), async (req, res) => {
  try {
    const { messageIds, channelId, nodeId, beforeTimestamp, allDMs, sourceId: markReadSourceId } = req.body;
    const markReadManager = resolveSourceManager(markReadSourceId);

    // If marking by channelId, check per-channel read permission. Virtual
    // (Channel Database) channels use per-entry `canRead` grants rather than a
    // `channel_${n}` RBAC resource.
    if (channelId !== undefined && channelId !== null && channelId !== -1) {
      if (isVirtualChannelNumber(channelId)) {
        const isAdmin = req.user?.isAdmin === true;
        const readableVirtual = await getUserReadableVirtualChannelIds(req.user, isAdmin);
        if (!isAdmin && !canReadVirtualChannelNumber(channelId, readableVirtual)) {
          return res.status(403).json({
            error: 'Insufficient permissions',
            code: 'FORBIDDEN',
            required: { resource: `channel_database:${virtualChannelDbId(channelId)}`, action: 'read' },
          });
        }
      } else {
        const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
        if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'read') : false)) {
          return res.status(403).json({
            error: 'Insufficient permissions',
            code: 'FORBIDDEN',
            required: { resource: channelResource, action: 'read' },
          });
        }
      }
    }

    // If marking by nodeId (DMs) or allDMs, check messages permission
    if ((nodeId && channelId === -1) || allDMs) {
      const hasMessagesRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read') : false);
      if (!hasMessagesRead) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'read' },
        });
      }
    }

    const userId = req.user?.id ?? null;
    let markedCount = 0;

    if (messageIds && Array.isArray(messageIds)) {
      // Mark specific messages as read
      await databaseService.markMessagesAsReadAsync(messageIds, userId);
      markedCount = messageIds.length;
    } else if (allDMs) {
      // Mark ALL DMs as read
      const localNodeInfo = markReadManager.getLocalNodeInfo();
      if (!localNodeInfo) {
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = await databaseService.markAllDMMessagesAsReadAsync(localNodeInfo.nodeId, userId);
    } else if (channelId !== undefined) {
      // Mark all messages in a channel as read (specific channel permission already checked above)
      markedCount = await databaseService.markChannelMessagesAsReadAsync(channelId, userId, beforeTimestamp, markReadSourceId);
    } else if (nodeId) {
      // Mark all DMs with a node as read (permission already checked above)
      const localNodeInfo = markReadManager.getLocalNodeInfo();
      if (!localNodeInfo) {
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = await databaseService.markDMMessagesAsReadAsync(localNodeInfo.nodeId, nodeId, userId, beforeTimestamp);
    } else {
      return res.status(400).json({ error: 'Must provide messageIds, channelId, nodeId, or allDMs' });
    }

    res.json({ marked: markedCount });
  } catch (error) {
    logger.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

/**
 * GET /api/messages/unread-counts
 * Extracted verbatim from server.ts (was L2545).
 */
router.get('/unread-counts', optionalAuth(), async (req, res) => {
  try {
    // Check if user has either any channel permission or messages permission
    const isAdmin = req.user?.isAdmin === true;
    const hasChannelsRead = isAdmin || (req.user ? await hasPermission(req.user, 'channel_0', 'read') : false);
    const hasMessagesRead = isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read') : false);
    // Virtual (Channel Database) channels are gated by per-entry `canRead`
    // grants; a virtual-channel-only reader still needs to reach the unread
    // counts for those channels.
    const readableVirtual = await getUserReadableVirtualChannelIds(req.user, isAdmin);
    const hasVirtualRead = hasAnyReadableVirtualChannel(readableVirtual);

    if (!hasChannelsRead && !hasMessagesRead && !hasVirtualRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' },
      });
    }

    const userId = req.user?.id ?? null;
    // Optional sourceId scoping — multi-source views must only see unread
    // counts for messages their own source ingested. Without this an inactive
    // source can keep a badge lit for messages that aren't visible in the
    // current source's tab.
    const unreadSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    const excludeMqtt = req.query.excludeMqtt === 'true';
    const unreadManager = resolveSourceManager(unreadSourceId);
    const localNodeInfo = unreadManager.getLocalNodeInfo();

    const result: {
      channels?: { [channelId: number]: number };
      directMessages?: { [nodeId: string]: number };
    } = {};

    // Load mute preferences for the current user (if authenticated)
    const mutedChannelIds: Set<number> = new Set();
    const mutedDMNodeIds: Set<string> = new Set();
    if (userId) {
      const { getUserNotificationPreferencesAsync } = await import('../utils/notificationFiltering.js');
      const prefs = await getUserNotificationPreferencesAsync(userId);
      if (prefs) {
        const now = Date.now();
        for (const rule of (prefs.mutedChannels ?? [])) {
          if (rule.muteUntil === null || rule.muteUntil > now) {
            mutedChannelIds.add(rule.channelId);
          }
        }
        for (const rule of (prefs.mutedDMs ?? [])) {
          if (rule.muteUntil === null || rule.muteUntil > now) {
            mutedDMNodeIds.add(rule.nodeUuid);
          }
        }
      }
    }

    // Get channel unread counts if user can read any channel (physical or
    // virtual). Only count incoming messages (exclude messages sent by our node).
    if (hasChannelsRead || hasVirtualRead) {
      const rawCounts = await databaseService.getUnreadCountsByChannelAsync(userId, localNodeInfo?.nodeId, unreadSourceId ?? ALL_SOURCES, excludeMqtt); // intentional cross-source when sourceId omitted

      // MM-SEC-3: filter by per-channel read permission as well as mute prefs.
      // The bare `channel_0:read` gate above lets a viewer reach this handler
      // but they must not learn unread counts for channels they cannot read.
      // Virtual (Channel Database) channels use per-entry `canRead` grants.
      const channels: { [channelId: number]: number } = {};
      for (const [channelIdStr, count] of Object.entries(rawCounts)) {
        const channelId = Number(channelIdStr);
        if (mutedChannelIds.has(channelId)) continue;
        if (isVirtualChannelNumber(channelId)) {
          if (!isAdmin && !canReadVirtualChannelNumber(channelId, readableVirtual)) continue;
        } else if (!hasChannelsRead) {
          continue;
        } else if (!isAdmin && req.user) {
          const channelResource = `channel_${channelId}` as import('../../types/permission.js').ResourceType;
          if (!(await hasPermission(req.user, channelResource, 'read'))) continue;
        } else if (!req.user && !isAdmin) {
          continue;
        }
        channels[channelId] = count as number;
      }
      result.channels = channels;
    }

    // Get DM unread counts if user has messages permission (batch query)
    if (hasMessagesRead && localNodeInfo) {
      const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, userId, unreadSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted
      const allNodes = await unreadManager.getAllNodesAsync(unreadSourceId);
      const visibleNodes = await filterNodesByChannelPermission(allNodes, req.user, unreadSourceId);
      const visibleNodeIds = new Set(visibleNodes.map(n => n.user?.id).filter(Boolean));
      const directMessages: { [nodeId: string]: number } = {};
      for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
        // Filter out muted DMs
        if (visibleNodeIds.has(nodeId) && count > 0 && !mutedDMNodeIds.has(nodeId)) {
          directMessages[nodeId] = count;
        }
      }
      result.directMessages = directMessages;
    }

    res.json(result);
  } catch (error) {
    logger.error('Error fetching unread counts:', error);
    res.status(500).json({ error: 'Failed to fetch unread counts' });
  }
});

// MM-SEC-6: legacy `/api/channels/debug` removed.
// The route was a `SELECT *` pass-through gated on the unrelated
// `messages:read` permission, so any user with `messages:read` (granted to
// anonymous in the standard public-viewer config) received the raw `psk`
// column for every channel — bypassing the per-channel `channel_${id}:read`
// gate and `transformChannel` projection that MM-SEC-2 established as the
// pattern for read-class channel endpoints. The route had no UI consumers;
// `/api/channels` and `/api/channels/all` cover the legitimate use case.

/**
 * POST /api/messages/send
 * Extracted verbatim from server.ts (was L2664).
 */
router.post('/send', optionalAuth(), async (req, res) => {
  try {
    const { text, channel, destination, replyId, emoji, sourceId: reqSourceId } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Message text is required' });
    }

    // Validate replyId if provided
    if (replyId !== undefined && (typeof replyId !== 'number' || replyId < 0 || !Number.isInteger(replyId))) {
      return res.status(400).json({ error: 'Invalid replyId: must be a positive integer' });
    }

    // Validate emoji flag if provided (should be 0 or 1)
    if (emoji !== undefined && (typeof emoji !== 'number' || (emoji !== 0 && emoji !== 1))) {
      return res.status(400).json({ error: 'Invalid emoji flag: must be 0 or 1' });
    }

    // Convert destination nodeId to nodeNum if provided. Accepts an 8-hex
    // nodeId (`!ad8c9eff`) or a 64-hex publicKey; rejects anything else with
    // 400 so a long-string input can't overflow PG bigint (issue #3186).
    let destinationNum: number | undefined = undefined;
    if (destination) {
      const resolved = await parseDestinationNum(destination, reqSourceId, databaseService);
      if (resolved === null) {
        return res.status(400).json({ error: `Invalid destination: ${destination}` });
      }
      destinationNum = resolved;
    }

    // Map channel to mesh network
    // Channel must be 0-7 for Meshtastic. If undefined or invalid, default to 0 (Primary)
    let meshChannel = channel !== undefined && channel >= 0 && channel <= 7 ? channel : 0;

    // For DMs, use the channel we last heard the target node on (from NodeInfo).
    // Scope the lookup to the source that will actually send the message so the
    // channel reflects the correct mesh — a node may be on different channels
    // across sources.
    if (destinationNum) {
      const targetNode = await databaseService.nodes.getNode(destinationNum, reqSourceId);
      if (targetNode && targetNode.channel !== undefined && targetNode.channel !== null) {
        meshChannel = targetNode.channel;
        logger.debug(`📨 DM to ${destination} - Using target node's channel: ${meshChannel}`);
      } else {
        logger.debug(`📨 DM to ${destination} - Target node channel unknown, using default channel: ${meshChannel}`);
      }
    }

    logger.debug(
      `📨 Sending message - Received channel: ${channel}, Using meshChannel: ${meshChannel}, Text: "${text.substring(
        0,
        50
      )}${text.length > 50 ? '...' : ''}"`
    );

    // Check permissions based on whether this is a DM or channel message
    if (destinationNum) {
      // Direct message - check 'messages' write permission
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, 'messages', 'write') : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'write' },
        });
      }
    } else {
      // Channel message - check per-channel write permission
      const channelResource = `channel_${meshChannel}` as import('../../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'write') : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'write' },
        });
      }
    }

    // Route to the correct source manager when sourceId is provided
    const activeManager = (resolveSourceManager(reqSourceId));

    // Send the message to the mesh network (with optional destination for DMs, replyId, and emoji flag)
    // Note: sendTextMessage() now handles saving the message to the database
    // Pass userId so sent messages are automatically marked as read for the sender.
    // Attribution: req.ip honors X-Forwarded-For when 'trust proxy' is configured.
    await activeManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji, req.user?.id, {
      sourceIp: req.ip ?? null,
      sourcePath: 'http_api',
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
