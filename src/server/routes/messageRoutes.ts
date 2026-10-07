import express, { Request, Response } from 'express';
import databaseService, { DbMessage } from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';
import { fallbackManager } from '../meshtasticManager.js';
import { resolveSourceManager, resolveOwnMeshtasticManager } from '../utils/resolveSourceManager.js';
import { refuseNonMeshtasticSource, isNonMeshtasticSource } from '../utils/requireMeshtasticDeviceSource.js';
import {
  requireSourcePermission,
  getSourceTarget,
  listPermittedSourceIds,
  readNewestAcrossSources,
  readRequestSourceId,
  loadSourcePermissions,
} from '../utils/sourceScopedAccess.js';
import type { SourcePermissions } from '../utils/sourceScopedAccess.js';
import type { ResourceType } from '../../types/permission.js';
import { optionalAuth, hasPermission } from '../auth/authMiddleware.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannelNumber,
  isVirtualChannelNumber,
  virtualChannelDbId,
  hasAnyReadableVirtualChannel,
} from '../utils/virtualChannelPermissions.js';
import { resolveMessageReadAccess } from '../utils/messageReadAccess.js';
import { parseDestinationNum } from '../utils/parseDestination.js';
import { transformDbMessageToMeshMessage } from '../utils/transformDbMessage.js';
import { filterNodesByChannelPermission, loadNodeViewAccess } from '../utils/nodeEnhancer.js';
import type { NodeViewAccess } from '../utils/nodeEnhancer.js';
import { ok, fail } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';
import { PortNum } from '../constants/meshtastic.js';
import { parseMessageSearchQuery, searchReadableMessages } from '../utils/messageSearch.js';
import messageExportRoutes from './messageExportRoutes.js';
import { getUserNotificationPreferencesAsync } from '../utils/notificationFiltering.js';

const router = express.Router();

/**
 * Source types whose direct messages are rows in the Meshtastic `messages`
 * table, and so are countable by `getBatchUnreadDMCountsAsync` (#5124).
 *
 * MeshCore (`meshcore`, `meshcore_mqtt`) and Reticulum keep their messages
 * elsewhere; they are omitted deliberately rather than reported as zero.
 */
const DM_BEARING_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'meshtastic_tcp',
  'mqtt_broker',
  'mqtt_bridge',
]);

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
 * Search messages across channels and DMs.
 *
 * Every query is scoped in SQL to the sources and channels the caller may
 * read (#5517). Before, the Meshtastic query ran unscoped and the route
 * trimmed by source after paging (short pages, wrong totals), virtual
 * channels were never searchable for non-admins, and MeshCore search scanned
 * only the in-memory ring of connected managers.
 *
 * `startDate` / `endDate` are epoch milliseconds.
 *
 * Results are Meshtastic matches (newest first) followed by MeshCore matches;
 * `offset` pages through that concatenated list.
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { sourceId } = req.query;
    const sourceIdStr = typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : undefined;

    const parsed = parseMessageSearchQuery(req.query);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: parsed.message
      });
    }

    const { results, total } = await searchReadableMessages(user, sourceIdStr, parsed.params);

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

// GET /api/messages/export — filtered CSV export (#5517).
router.use(messageExportRoutes);

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

    const deletedTelemetryCount = await databaseService.telemetry.purgePositionHistory(nodeNum, sourceId);
    // The global position estimate (issue #3271) lives outside per-source telemetry —
    // a node with zero real telemetry can still carry a stale estimate, which the
    // purge above would otherwise silently leave behind (#4450).
    const deletedEstimateCount = await databaseService.deleteEstimatedPositionsByNodeNumsAsync([nodeNum]);
    const deletedCount = deletedTelemetryCount + deletedEstimateCount;

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

    // The source requireMessagesWrite checked `messages:write` on. The admin
    // packet goes to THAT source's own radio. This used to read the body only
    // and fall back to the primary, so a sourceId sent in the query, or one
    // naming a source with no radio (MQTT, MeshCore), had its permission
    // checked on one source and the node removed from the primary's NodeDB.
    const purgeSourceId: string = (req as any).scopedSourceId;
    if (await refuseNonMeshtasticSource(res, purgeSourceId, 'device NodeDB purges')) return;
    const meshtasticManager = resolveOwnMeshtasticManager(purgeSourceId);
    if (!meshtasticManager) {
      return fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${purgeSourceId}" was not found.`);
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
    const nodes = await databaseService.nodes.getAllNodes(purgeSourceId);
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
    // Resolved before the gates, which are scoped to it.
    //
    // Un-scoped, these checks authorized the caller-named `?sourceId=`: holding
    // `messages:read` on ANY one source returned the DM BODIES of a source the
    // caller held nothing on. Confirmed against a live install — an account with
    // grants on three MQTT sources read a DM's text off a Meshtastic TCP source
    // it had no `messages` grant for. Same class as #5225, which fixed the
    // count-shaped siblings (`/unread-counts`, `/first-unread`); this one
    // returns the message text.
    //
    // It survived that pass because a 50-message sample from a busy source is
    // all channel traffic — the DMs only appear at a higher `?limit=`.
    //
    // With `sourceId` omitted the query spans every source and an un-scoped
    // check keeps its original union-across-sources meaning.
    const messagesSourceId = req.query.sourceId as string | undefined;

    // Resolved once, shared with GET /api/messages/counts so the two cannot
    // drift apart (#5101). See messageReadAccess.ts for the per-check
    // comments carried over from this handler's pre-extraction form.
    const access = await resolveMessageReadAccess(req.user, messagesSourceId);

    if (!access.canReadAny) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' },
      });
    }

    const limit = parseInt(req.query.limit as string) || 100;
    const defaultMgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;

    // No sourceId and not an admin: the union check above only says the caller
    // may read something somewhere. Read each source on its own and filter it
    // with that source's grants, so a grant on source A never shows source B's
    // messages. Admins keep the single query over every source.
    if (!messagesSourceId && !access.isAdmin) {
      const perSource: Awaited<ReturnType<typeof defaultMgr.getRecentMessages>> = [];
      for (const source of await databaseService.sources.getAllSources()) {
        const sourceAccess = await resolveMessageReadAccess(req.user, source.id);
        if (!sourceAccess.canReadAny) continue;
        const rows = await defaultMgr.getRecentMessages(limit, source.id);
        perSource.push(...rows.filter(msg => sourceAccess.canReadChannel(msg.channel)));
      }
      perSource.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      res.json(perSource.slice(0, limit));
      return;
    }

    let messages = await defaultMgr.getRecentMessages(limit, messagesSourceId);

    messages = messages.filter(msg => access.canReadChannel(msg.channel));

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
      // Scoped to the requested source, same as `GET /` above: un-scoped, a
      // `channel_N:read` grant on ANY source authorized reading channel N's
      // messages on EVERY source, just by naming one in `?sourceId=`.
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'read', sourceIdParam) : false)) {
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
    //
    // No sourceId, a physical channel and not an admin: the check above passed
    // on a `channel_N:read` grant for SOME source. Read only the sources the
    // caller holds it on. (A virtual channel's grant is global by design.)
    let dbMessages: DbMessage[];
    if (sourceIdParam) {
      dbMessages = (await databaseService.messages.getMessagesByChannel(messageChannel, limit + 1, offset, sourceIdParam)) as DbMessage[];
    } else if (req.user?.isAdmin || isVirtualChannelNumber(messageChannel)) {
      dbMessages = await databaseService.getMessagesByChannelAsync(messageChannel, limit + 1, offset);
    } else {
      const readable = await listPermittedSourceIds(req.user, `channel_${messageChannel}` as import('../../types/permission.js').ResourceType, 'read');
      dbMessages = await readNewestAcrossSources(
        readable as string[],
        async (id, pageLimit) => (await databaseService.messages.getMessagesByChannel(messageChannel, pageLimit, 0, id)) as DbMessage[],
        (row) => Number(row.createdAt ?? 0),
        limit + 1,
        offset,
      );
    }
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
router.get('/direct/:nodeId1/:nodeId2', requireSourcePermission('messages', 'read', { whenOmitted: 'permitted' }), async (req, res) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    // Validate and clamp limit (1-500) and offset (0-50000) to prevent abuse
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500));
    const offset = Math.max(0, Math.min(parseInt(req.query.offset as string) || 0, 50000));
    // DM threads are per-source (each source has its own view of a node
    // pair). `messages:read` is the DM gate on every message route, checked
    // per source. With a sourceId: that source. With none: every source for
    // an admin, and for anyone else only the sources they hold
    // `messages:read` on; another source's DMs are never returned.
    const { sourceIds } = getSourceTarget(req);
    // Fetch limit+1 to accurately detect if more messages exist
    const dbMessages = sourceIds === 'all'
      ? await databaseService.messages.getDirectMessages(nodeId1, nodeId2, limit + 1, offset, ALL_SOURCES) as DbMessage[] // intentional cross-source: admin, no sourceId
      : await readNewestAcrossSources(
          sourceIds,
          async (id, pageLimit) => (await databaseService.messages.getDirectMessages(nodeId1, nodeId2, pageLimit, 0, id)) as DbMessage[],
          (row) => Number(row.createdAt ?? 0),
          limit + 1,
          offset,
        );
    const hasMore = dbMessages.length > limit;
    // Return only the requested limit
    const messages = dbMessages.slice(0, limit).map(transformDbMessageToMeshMessage);
    res.json({ messages, hasMore });
  } catch (error) {
    logger.error('Error fetching direct messages:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch direct messages');
  }
});

/**
 * POST /api/messages/mark-read
 * Extracted verbatim from server.ts (was L2466).
 */
router.post('/mark-read', optionalAuth(), async (req, res) => {
  try {
    const { messageIds, channelId, nodeId, beforeTimestamp, allDMs, sourceId: markReadSourceId } = req.body;
    // The local node is THIS source's own node. A non-Meshtastic source has
    // none; falling back to the primary would mark the primary's DMs (#5375).
    const markReadManager = resolveOwnMeshtasticManager(markReadSourceId);
    // The source the permission checks below are tied to. Read state is the
    // caller's own, so with no sourceId the checks keep their any-source
    // meaning; with one, they are checked on it.
    const markReadScope = typeof markReadSourceId === 'string' && markReadSourceId.length > 0 ? markReadSourceId : undefined;

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
        // Scoped to the named source. Unscoped, a `channel_N:read` grant on
        // one source marked (and counted) channel N on any source named here.
        if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'read', markReadScope) : false)) {
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
      const hasMessagesRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read', markReadScope) : false);
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
      const localNodeInfo = markReadManager?.getLocalNodeInfo() ?? null;
      if (!localNodeInfo) {
        // No local node on an MQTT/other non-Meshtastic source: there are no
        // DMs to or from "us", so there is nothing to mark.
        if (isNonMeshtasticSource(markReadSourceId)) return res.json({ marked: 0 });
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = await databaseService.markAllDMMessagesAsReadAsync(localNodeInfo.nodeId, userId);
    } else if (channelId !== undefined) {
      // Mark all messages in a channel as read (specific channel permission already checked above)
      markedCount = await databaseService.markChannelMessagesAsReadAsync(channelId, userId, beforeTimestamp, markReadSourceId);
    } else if (nodeId) {
      // Mark all DMs with a node as read (permission already checked above)
      const localNodeInfo = markReadManager?.getLocalNodeInfo() ?? null;
      if (!localNodeInfo) {
        // No local node on an MQTT/other non-Meshtastic source: there are no
        // DMs to or from "us", so there is nothing to mark.
        if (isNonMeshtasticSource(markReadSourceId)) return res.json({ marked: 0 });
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
 * GET /api/messages/counts
 * Total message count for one source, split RF/UDP/MQTT, for the Info tab's
 * Total Messages breakdown (#5101). Shares its permission gate with
 * `GET /api/messages` via `resolveMessageReadAccess` so the total can never
 * drift from what the list endpoint would actually show the same caller.
 *
 * Excludes TRACEROUTE_APP, matching the poll's message-count window
 * (`pollRoutes.ts` ~156) — traceroute rows aren't "messages" in the UI sense.
 * `total === rf + udp + mqtt` always.
 */
router.get('/counts', optionalAuth(), async (req, res) => {
  try {
    const sourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    if (!sourceId) {
      return fail(res, 400, 'MISSING_SOURCE_ID', 'sourceId is required');
    }

    const access = await resolveMessageReadAccess(req.user, sourceId);
    if (!access.canReadAny) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions', {
        required: { resource: 'channel_0 or messages', action: 'read' },
      });
    }

    const rows = await databaseService.getMessageCountsByChannelAndTransportAsync(sourceId, [PortNum.TRACEROUTE_APP]);

    const byTransport = { rf: 0, udp: 0, mqtt: 0 };
    for (const row of rows) {
      if (!access.canReadChannel(row.channel)) continue;
      byTransport[row.transportClass] += row.count;
    }

    return ok(res, { sourceId, total: byTransport.rf + byTransport.udp + byTransport.mqtt, byTransport });
  } catch (error) {
    logger.error('Error fetching message counts:', error);
    return fail(res, 500, 'MESSAGE_COUNTS_FAILED', 'Failed to fetch message counts');
  }
});

/**
 * GET /api/messages/unread-counts
 * Extracted verbatim from server.ts (was L2545).
 */
router.get('/unread-counts', optionalAuth(), async (req, res) => {
  try {
    const unreadSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    const excludeMqtt = req.query.excludeMqtt === 'true';
    const viewer = await loadUnreadViewer(req.user);

    // One source when named, and for an admin with none named (who reads every
    // source in one query, as before). Every permission check in
    // `unreadCountsFor` is made on that source: `messages:read` on any one
    // source used to return every source's DM counts, one `?sourceId=` at a time.
    if (unreadSourceId || viewer.isAdmin) {
      const result = await unreadCountsFor(viewer, unreadSourceId, excludeMqtt);
      if (!result) return refuseUnread(res);
      res.json(result);
      return;
    }

    // No source named, not an admin: the sum over the sources the caller may
    // read, each counted under that source's own grants. This used to be one
    // query over every source, filtered by grants merged across sources, so a
    // grant on source A counted source B's messages.
    const perSource = await Promise.all(
      (await unreadCandidateSources(viewer)).map((id) => unreadCountsFor(viewer, id, excludeMqtt)),
    );
    const readable = perSource.filter((entry): entry is UnreadCounts => entry !== null);
    if (readable.length === 0 && !viewer.hasVirtualRead) return refuseUnread(res);

    const result: UnreadCounts = {};
    if (viewer.hasVirtualRead) result.channels = {};
    for (const entry of readable) {
      if (entry.channels) {
        const channels = (result.channels ??= {});
        for (const [id, count] of Object.entries(entry.channels)) {
          channels[Number(id)] = (channels[Number(id)] ?? 0) + count;
        }
      }
      if (entry.directMessages) {
        const dms = (result.directMessages ??= {});
        for (const [nodeId, count] of Object.entries(entry.directMessages)) {
          dms[nodeId] = (dms[nodeId] ?? 0) + count;
        }
      }
    }
    res.json(result);
  } catch (error) {
    logger.error('Error fetching unread counts:', error);
    res.status(500).json({ error: 'Failed to fetch unread counts' });
  }
});

interface UnreadCounts {
  channels?: { [channelId: number]: number };
  directMessages?: { [nodeId: string]: number };
}

/** Who is asking for unread state, with every grant loaded once. */
interface UnreadViewer {
  user: Express.Request['user'];
  userId: number | null;
  isAdmin: boolean;
  permissions: SourcePermissions;
  nodes: NodeViewAccess;
  /** Virtual (Channel Database) channels are gated by per-entry `canRead`
   *  grants, global by design. */
  readableVirtual: Awaited<ReturnType<typeof getUserReadableVirtualChannelIds>>;
  hasVirtualRead: boolean;
}

async function loadUnreadViewer(user: Express.Request['user']): Promise<UnreadViewer> {
  const isAdmin = user?.isAdmin === true;
  const [permissions, nodes, readableVirtual] = await Promise.all([
    loadSourcePermissions(user),
    loadNodeViewAccess(user),
    getUserReadableVirtualChannelIds(user, isAdmin),
  ]);
  return {
    user,
    userId: user?.id ?? null,
    isAdmin,
    permissions,
    nodes,
    readableVirtual,
    hasVirtualRead: hasAnyReadableVirtualChannel(readableVirtual),
  };
}

function refuseUnread(res: Response): void {
  res.status(403).json({
    error: 'Insufficient permissions',
    code: 'FORBIDDEN',
    required: { resource: 'channel_0 or messages', action: 'read' },
  });
}

/**
 * The sources an unread read with no `sourceId` covers for a caller who is not
 * an admin: those where they hold `channel_0:read` or `messages:read` (the two
 * gates below). A virtual-channel reader may have messages on any source, so
 * they get every source; the per-channel check still decides each count.
 */
async function unreadCandidateSources(viewer: UnreadViewer): Promise<string[]> {
  if (viewer.hasVirtualRead) {
    return (await databaseService.sources.getAllSources()).map((source) => source.id);
  }
  return viewer.permissions.sourcesWhere(
    (grants) => grants.channel_0?.read === true || grants.messages?.read === true,
  );
}

/** May the viewer read this channel's unread state on this source? */
function canReadUnreadChannel(viewer: UnreadViewer, channelId: number, sourceId: string | undefined, hasChannelsRead: boolean): boolean {
  if (isVirtualChannelNumber(channelId)) {
    return viewer.isAdmin || canReadVirtualChannelNumber(channelId, viewer.readableVirtual);
  }
  // MM-SEC-3: the bare `channel_0:read` gate lets a viewer reach the handler,
  // but they must not learn about channels they cannot read.
  if (!hasChannelsRead) return false;
  if (viewer.isAdmin) return true;
  return !!sourceId && viewer.permissions.can(`channel_${channelId}` as ResourceType, 'read', sourceId);
}

/** Node ids of the DM senders the viewer may see on this source. */
async function visibleDmSenders(viewer: UnreadViewer, sourceId: string | undefined): Promise<Set<string>> {
  const allNodes = await resolveSourceManager(sourceId).getAllNodesAsync(sourceId);
  const visible = viewer.isAdmin
    ? allNodes
    : allNodes.filter((node) => viewer.nodes.canViewNode(sourceId, (node as { channel?: number }).channel));
  return new Set(visible.map((n) => n.user?.id).filter((id): id is string => typeof id === 'string'));
}

/**
 * Unread counts for ONE source, under the viewer's grants on that source.
 * `sourceId` undefined is the admin's every-source read. Null when the viewer
 * holds nothing that reaches unread state there.
 */
async function unreadCountsFor(viewer: UnreadViewer, sourceId: string | undefined, excludeMqtt: boolean): Promise<UnreadCounts | null> {
  const holds = (resource: ResourceType): boolean =>
    viewer.isAdmin || (!!sourceId && viewer.permissions.can(resource, 'read', sourceId));
  // Only an admin reads every source in one query. Anyone else is counted one
  // source at a time, so "no source" can never reach the queries below.
  if (!sourceId && !viewer.isAdmin) return null;
  const hasChannelsRead = holds('channel_0');
  const hasMessagesRead = holds('messages');
  if (!hasChannelsRead && !hasMessagesRead && !viewer.hasVirtualRead) return null;

  // DMs count against THIS source's own node. A non-Meshtastic source has no
  // local node, so DM-to-local counting is skipped rather than counting the
  // primary TCP node's DMs (#5375).
  const localNodeInfo = resolveOwnMeshtasticManager(sourceId)?.getLocalNodeInfo() ?? null;
  const result: UnreadCounts = {};

  // Mutes from the SAME per-source row push/Apprise filtering reads (#5487).
  const { channels: mutedChannelIds, dms: mutedDMNodeIds } = await loadActiveMutes(viewer.userId, sourceId);

  // Only count incoming messages (exclude messages sent by our node).
  if (hasChannelsRead || viewer.hasVirtualRead) {
    const rawCounts = await databaseService.getUnreadCountsByChannelAsync(viewer.userId, localNodeInfo?.nodeId, sourceId ?? ALL_SOURCES, excludeMqtt); // cross-source only for an admin with no sourceId
    const channels: { [channelId: number]: number } = {};
    for (const [channelIdStr, count] of Object.entries(rawCounts)) {
      const channelId = Number(channelIdStr);
      if (mutedChannelIds.has(channelId)) continue;
      if (!canReadUnreadChannel(viewer, channelId, sourceId, hasChannelsRead)) continue;
      channels[channelId] = count as number;
    }
    result.channels = channels;
  }

  if (hasMessagesRead && localNodeInfo) {
    const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, viewer.userId, sourceId ?? ALL_SOURCES); // cross-source only for an admin with no sourceId
    const visibleNodeIds = await visibleDmSenders(viewer, sourceId);
    const directMessages: { [nodeId: string]: number } = {};
    for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
      if (visibleNodeIds.has(nodeId) && count > 0 && !mutedDMNodeIds.has(nodeId)) {
        directMessages[nodeId] = count;
      }
    }
    result.directMessages = directMessages;
  }

  return result;
}

/**
 * The channel and DM mutes currently in force for a user on one source.
 *
 * Reads the same preferences as push/Apprise filtering
 * (`shouldFilterNotificationAsync` → `getUserNotificationPreferencesAsync(userId,
 * sourceId)`), so a badge and a push agree about whether a channel is muted:
 * the row saved for this source, else the built-in defaults plus — on a
 * Meshtastic source — the active mutes on the user's legacy '' row (#5487).
 * Never another source's row. `sourceId` undefined (a cross-source view) reads
 * the '' row.
 */
async function loadActiveMutes(
  userId: number | null,
  sourceId: string | undefined,
): Promise<{ channels: Set<number>; dms: Set<string> }> {
  const channels = new Set<number>();
  const dms = new Set<string>();
  if (!userId) return { channels, dms };
  const prefs = await getUserNotificationPreferencesAsync(userId, sourceId);
  const now = Date.now();
  for (const rule of (prefs?.mutedChannels ?? [])) {
    if (rule.muteUntil === null || rule.muteUntil > now) channels.add(rule.channelId);
  }
  for (const rule of (prefs?.mutedDMs ?? [])) {
    if (rule.muteUntil === null || rule.muteUntil > now) dms.add(rule.nodeUuid);
  }
  return { channels, dms };
}

/**
 * GET /api/messages/unread-by-source
 *
 * Unread DM count for EVERY source the caller may read, in one request —
 * the per-source badge on the Sources list (#5124).
 *
 * ## Why one endpoint rather than N calls to /unread-counts
 *
 * `/unread-counts?sourceId=X` already answers this for a single source, but
 * the sidebar shows every source and refetches on a timer. On the reporter's
 * 5+ source install that is 5+ requests every 10 seconds, each doing its own
 * node fetch and permission filtering.
 *
 * ## Permissions
 *
 * Every gate is evaluated PER SOURCE, and that is the whole point of this
 * handler rather than a loop around the existing one.
 *
 * `/unread-counts` checks `hasPermission(user, 'messages', 'read')` with no
 * `sourceId` and then queries one source. That is bounded there — the caller
 * names the source and sees only that source. Reused verbatim across every
 * source it would be a leak: a user granted `messages:read` on source A but
 * not source B would be told how many unread DMs B is holding. That is the
 * cross-source shape of #3745, so:
 *
 *   - `messages:read` is re-checked for each source id (admins short-circuit).
 *   - DM identity is `toNodeId = that source's OWN local node`, so a source
 *     whose manager has no local node yet contributes nothing rather than
 *     falling back to another source's node.
 *   - Senders are filtered through `filterNodesByChannelPermission` per
 *     source, so a DM from a node the caller cannot see never lights a badge.
 *   - Muted DMs are dropped, matching `/unread-counts`.
 *
 * A source the caller cannot read is OMITTED rather than reported as 0. The
 * source list itself is public metadata (`GET /api/sources` is `optionalAuth`),
 * so absence discloses nothing that listing did not already.
 *
 * Anonymous callers get an empty map: unread state is per-user
 * (`read_messages.userId`), so there is nothing meaningful to count.
 */
/**
 * The unread DMs a caller is actually allowed to see, grouped by source.
 *
 * Extracted so `/unread-by-source` (which counts them) and
 * `/mark-all-dms-read` (which clears them) can never disagree about the set
 * (#5197). If the badge counted a DM the bulk clear skipped, the badge would
 * survive a "mark all read"; if the clear covered DMs the badge never counted,
 * it would silently mark conversations the caller is not allowed to see. One
 * traversal, used by both, is what keeps those two in step.
 *
 * Every gate here is PER SOURCE — see the handler docs below for why that is
 * the whole point rather than an optimisation.
 */
async function collectVisibleUnreadDms(
  user: Express.Request['user'],
  userId: number | null,
): Promise<Array<{ sourceId: string; localNodeId: string; senders: Record<string, number> }>> {
  const isAdmin = user?.isAdmin === true;
  const out: Array<{ sourceId: string; localNodeId: string; senders: Record<string, number> }> = [];
  if (!user) return out;

  const sources = await databaseService.sources.getAllSources();

  for (const source of sources) {
    // Per-source gate. Without the sourceId argument this loop would hand
    // every source's count to anyone holding a grant on any one source.
    const allowed = isAdmin || await hasPermission(user, 'messages', 'read', source.id);
    if (!allowed) continue;

    // Which source types can hold a Meshtastic DM at all. Gating on
    // `isMeshtasticManager` alone would have been wrong in the direction
    // that produces "rows in the DB, empty badge": MQTT bridge/broker
    // sources ingest into the very same `messages` table and can absolutely
    // carry a DM addressed to their local node.
    //
    // MeshCore and Reticulum are excluded on purpose, not overlooked — their
    // DMs live in their own tables and need a different query. A badge for
    // them is follow-up work, not something to fake here.
    if (!DM_BEARING_SOURCE_TYPES.has(source.type)) continue;

    const manager = sourceManagerRegistry.getManager(source.id);
    if (!manager) continue;

    // A DM is addressed to THIS source's local node. No local node yet
    // (still connecting, never connected) means nothing can be addressed to
    // it — deliberately not falling back to the primary source's node.
    const localNodeId = manager.getLocalNodeInfo()?.nodeId;
    if (!localNodeId) continue;

    const perSender = await databaseService.getBatchUnreadDMCountsAsync(localNodeId, userId, source.id);
    if (Object.keys(perSender).length === 0) continue;

    // No node list means no way to check sender visibility. Count nothing
    // rather than everything — the filter is a permission gate, so failing
    // open here would be the leak this handler exists to avoid.
    if (typeof manager.getAllNodesAsync !== 'function') continue;
    const nodes = await manager.getAllNodesAsync(source.id);
    const visible = await filterNodesByChannelPermission(nodes, user, source.id);
    const visibleNodeIds = new Set(
      visible.map((n) => n.user?.id).filter((id): id is string => typeof id === 'string'),
    );

    // Muted DMs must not light a badge, same rule as /unread-counts — and so
    // must not be swept up by a bulk clear either. Mutes are per source
    // (#5487), so each source reads its own preferences row.
    const { dms: mutedDMNodeIds } = await loadActiveMutes(userId, source.id);

    const senders: Record<string, number> = {};
    for (const [nodeId, count] of Object.entries(perSender)) {
      if (!visibleNodeIds.has(nodeId)) continue;
      if (mutedDMNodeIds.has(nodeId)) continue;
      const n = Number(count) || 0;
      if (n > 0) senders[nodeId] = n;
    }

    if (Object.keys(senders).length > 0) out.push({ sourceId: source.id, localNodeId, senders });
  }

  return out;
}

router.get('/unread-by-source', optionalAuth(), async (req, res) => {
  try {
    const userId = req.user?.id ?? null;
    const result: { [sourceId: string]: { directMessages: number } } = {};

    // No identity, no per-user read state to report on.
    if (!req.user) {
      return res.json({ sources: result });
    }

    for (const entry of await collectVisibleUnreadDms(req.user, userId)) {
      const total = Object.values(entry.senders).reduce((sum, n) => sum + n, 0);
      if (total > 0) result[entry.sourceId] = { directMessages: total };
    }

    res.json({ sources: result });
  } catch (error) {
    logger.error('Error fetching per-source unread counts:', error);
    // `fail()` per the response-envelope rule. Only the error path converts:
    // the success path returns a bare `{ sources }` body that the client reads
    // directly, and `ok()` would wrap it in `data` and break that consumer
    // (the gotcha called out in CLAUDE.md).
    fail(res, 500, 'UNREAD_BY_SOURCE_FAILED', 'Failed to fetch per-source unread counts');
  }
});

/**
 * POST /api/messages/mark-all-dms-read
 *
 * Clear the unread DM badge on EVERY source the caller may read, in one
 * request (#5197). The Sources sidebar shows a badge per source; without this
 * a user with 5+ active sources has to open each one to dismiss them.
 *
 * ## Why not `/mark-read` with `allDMs`
 *
 * That flag already exists, but it resolves ONE manager and marks every DM
 * to or from that single source's local node. Pointed at a multi-source
 * install it clears one badge and leaves the rest lit. It also 500s with
 * "Local node not connected" when that one manager has no local node, which
 * for a bulk action means one disconnected source fails the whole sweep.
 *
 * ## What it marks
 *
 * Exactly the DMs `/unread-by-source` counts — same traversal, via
 * `collectVisibleUnreadDms`. Per source, per visible sender, skipping mutes.
 * So the badge is guaranteed to reach zero, and a conversation the caller
 * cannot see is never touched.
 *
 * Marking is done per (localNodeId, senderNodeId) through the same repository
 * call that opening a conversation uses, so this introduces no new read-state
 * semantics — it is the manual "open each thread" loop the reporter is doing
 * today, executed server-side.
 *
 * Note that repository call keys on node ids rather than `sourceId`, so two
 * sources sharing one local node (the same physical node reached over both TCP
 * and MQTT) have their DMs marked together. That is pre-existing and applies
 * identically to opening a single conversation; it is not introduced here.
 */
router.post('/mark-all-dms-read', optionalAuth(), async (req, res) => {
  try {
    // Defensive only: `optionalAuth` normally attaches the seeded `anonymous`
    // user when there is no session, so a signed-out caller reaches the
    // permission gate below and gets a 403. This covers an install with no
    // anonymous row at all.
    if (!req.user) {
      return fail(res, 401, 'UNAUTHORIZED', 'Sign in to mark direct messages as read');
    }

    // Matches the `allDMs` gate on /mark-read. The per-source check inside
    // collectVisibleUnreadDms is what actually bounds the sweep.
    const hasMessagesRead = req.user.isAdmin || await hasPermission(req.user, 'messages', 'read');
    if (!hasMessagesRead) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }

    const userId = req.user.id ?? null;
    const entries = await collectVisibleUnreadDms(req.user, userId);

    let marked = 0;
    for (const entry of entries) {
      for (const senderNodeId of Object.keys(entry.senders)) {
        marked += await databaseService.markDMMessagesAsReadAsync(
          entry.localNodeId,
          senderNodeId,
          userId,
        );
      }
    }

    // Bare body, not `ok()`: mirrors /mark-read's `{ marked }` shape so the two
    // read the same way to a client. `sources` is the number of sources that
    // had anything to clear, which is what the UI reports back to the user.
    res.json({ marked, sources: entries.length });
  } catch (error) {
    logger.error('Error marking all DMs as read:', error);
    fail(res, 500, 'MARK_ALL_DMS_READ_FAILED', 'Failed to mark all direct messages as read');
  }
});

/**
 * GET /api/messages/first-unread
 *
 * Timestamp (ms) of the OLDEST still-unread message in each conversation, for
 * the unread divider and the jump-to-first-unread entry scroll (issue #4607).
 * Shaped and permission-filtered exactly like `/unread-counts` above — same
 * gates, same per-channel/per-node visibility filtering, same mute handling —
 * so the line can never appear in a conversation whose badge the caller is not
 * allowed to see.
 *
 * The client reads this ONCE per conversation entry and pins the value: the
 * views mark a conversation read the moment you open it, so a live value would
 * evaporate before it could be drawn.
 */
router.get('/first-unread', optionalAuth(), async (req, res) => {
  try {
    const scopedSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    const excludeMqtt = req.query.excludeMqtt === 'true';
    const viewer = await loadUnreadViewer(req.user);

    // Same shape as `/unread-counts`: one source when named (or for an admin),
    // checked on that source.
    if (scopedSourceId || viewer.isAdmin) {
      const result = await firstUnreadFor(viewer, scopedSourceId, excludeMqtt);
      if (!result) return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
      return ok(res, result);
    }

    // No source named, not an admin: the oldest across the sources the caller
    // may read, each read under that source's own grants.
    const perSource = await Promise.all(
      (await unreadCandidateSources(viewer)).map((id) => firstUnreadFor(viewer, id, excludeMqtt)),
    );
    const readable = perSource.filter((entry): entry is FirstUnread => entry !== null);
    if (readable.length === 0 && !viewer.hasVirtualRead) {
      return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
    }
    const result: FirstUnread = { channels: {}, directMessages: {} };
    for (const entry of readable) {
      for (const [id, ts] of Object.entries(entry.channels)) {
        const current = result.channels[Number(id)];
        result.channels[Number(id)] = current === undefined ? ts : Math.min(current, ts);
      }
      for (const [nodeId, ts] of Object.entries(entry.directMessages)) {
        const current = result.directMessages[nodeId];
        result.directMessages[nodeId] = current === undefined ? ts : Math.min(current, ts);
      }
    }
    return ok(res, result);
  } catch (error) {
    logger.error('Error fetching first-unread timestamps:', error);
    return fail(res, 500, 'FIRST_UNREAD_FAILED', 'Failed to fetch first-unread timestamps');
  }
});

interface FirstUnread {
  channels: { [channelId: number]: number };
  directMessages: { [nodeId: string]: number };
}

/**
 * Oldest-unread timestamps for ONE source, under the viewer's grants on that
 * source. `sourceId` undefined is the admin's every-source read. Null when the
 * viewer holds nothing that reaches unread state there. Same gates as
 * `unreadCountsFor`, so the divider never appears where the badge may not.
 */
async function firstUnreadFor(viewer: UnreadViewer, sourceId: string | undefined, excludeMqtt: boolean): Promise<FirstUnread | null> {
  const holds = (resource: ResourceType): boolean =>
    viewer.isAdmin || (!!sourceId && viewer.permissions.can(resource, 'read', sourceId));
  // Only an admin reads every source in one query. Anyone else is counted one
  // source at a time, so "no source" can never reach the queries below.
  if (!sourceId && !viewer.isAdmin) return null;
  const hasChannelsRead = holds('channel_0');
  const hasMessagesRead = holds('messages');
  if (!hasChannelsRead && !hasMessagesRead && !viewer.hasVirtualRead) return null;

  // THIS source's own node only; none on a non-Meshtastic source (#5375).
  const localNodeInfo = resolveOwnMeshtasticManager(sourceId)?.getLocalNodeInfo() ?? null;
  const raw = await databaseService.getFirstUnreadTimestampsAsync(
    viewer.userId,
    localNodeInfo?.nodeId,
    sourceId ?? ALL_SOURCES, // cross-source only for an admin with no sourceId
    excludeMqtt,
  );

  const result: FirstUnread = { channels: {}, directMessages: {} };
  if (hasChannelsRead || viewer.hasVirtualRead) {
    for (const [channelIdStr, ts] of Object.entries(raw.channels)) {
      const channelId = Number(channelIdStr);
      if (!canReadUnreadChannel(viewer, channelId, sourceId, hasChannelsRead)) continue;
      result.channels[channelId] = ts as number;
    }
  }
  if (hasMessagesRead && localNodeInfo) {
    const visibleNodeIds = await visibleDmSenders(viewer, sourceId);
    for (const [nodeId, ts] of Object.entries(raw.directMessages)) {
      if (visibleNodeIds.has(nodeId)) result.directMessages[nodeId] = ts as number;
    }
  }
  return result;
}

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
    const { text, channel, destination, replyId, emoji } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Message text is required' });
    }

    // The source this message is sent through, resolved ONCE: the named one,
    // else the primary. The permission checks, the node lookups and the send
    // below all use it. The checks used to be unscoped, so a write grant on
    // one source let its holder transmit through any source named here.
    const named = readRequestSourceId(req, res);
    if (!named.ok) return;
    const sendManager = resolveOwnMeshtasticManager(named.sourceId);
    const reqSourceId: string | undefined = named.sourceId ?? sendManager?.sourceId;

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
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, 'messages', 'write', reqSourceId) : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'write' },
        });
      }
    } else {
      // Channel message - check per-channel write permission
      const channelResource = `channel_${meshChannel}` as import('../../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'write', reqSourceId) : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'write' },
        });
      }
    }

    // An MQTT broker/bridge (or any non-Meshtastic) source has no radio of its
    // own; resolveSourceManager() would hand back the PRIMARY TCP manager and
    // transmit through a radio the user did not pick (#5375). Refuse instead.
    if (await refuseNonMeshtasticSource(res, reqSourceId, 'message sends')) return;

    // The resolved source's own manager. An id that names no source used to
    // fall back to the primary radio; it is a 404 now.
    if (!sendManager) {
      return fail(res, 404, 'SOURCE_NOT_FOUND', `Source "${reqSourceId}" was not found.`);
    }
    const activeManager = sendManager;

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
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
