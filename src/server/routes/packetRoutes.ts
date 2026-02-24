import express from 'express';
import packetLogService from '../services/packetLogService.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';

const router = express.Router();

/**
 * Permission middleware - require BOTH channels:read AND messages:read
 */
const requirePacketPermissions: RequestHandler = async (req, res, next) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;

    // Get user permissions (works for both authenticated and anonymous users)
    const permissions = userId !== null
      ? await databaseService.getUserPermissionSetAsync(userId)
      : {};

    // Check if user is admin (admins have all permissions)
    const isAdmin = user?.isAdmin ?? false;

    if (isAdmin) {
      // Admins have all permissions
      return next();
    }

    // Check both channel_0:read and messages:read (minimum required)
    const hasChannelsRead = permissions.channel_0?.read === true;
    const hasMessagesRead = permissions.messages?.read === true;

    if (!hasChannelsRead || !hasMessagesRead) {
      logger.warn(`❌ Permission denied for packet access - channel_0:read=${hasChannelsRead}, messages:read=${hasMessagesRead}`);
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You need both channel_0:read and messages:read permissions to access packet logs'
      });
    }

    next();
  } catch (error) {
    logger.error('Error checking packet permissions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /api/packets
 * Get packet logs with optional filtering
 */
router.get('/', requirePacketPermissions, async (req, res) => {
  try {
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    let limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    // Enforce maximum limit to prevent unbounded queries
    // Use the configured max count from settings (defaults to 1000)
    const MAX_LIMIT = packetLogService.getMaxCount();
    if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }
    if (limit < 1) {
      return res.status(400).json({ error: 'Limit must be at least 1' });
    }
    if (offset < 0) {
      return res.status(400).json({ error: 'Offset must be non-negative' });
    }
    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const to_node = req.query.to_node ? parseInt(req.query.to_node as string, 10) : undefined;
    const channel = req.query.channel ? parseInt(req.query.channel as string, 10) : undefined;
    const encrypted = req.query.encrypted === 'true' ? true : req.query.encrypted === 'false' ? false : undefined;
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;

    const packets = await packetLogService.getPacketsAsync({
      offset,
      limit,
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since
    });

    const total = await packetLogService.getPacketCountAsync({
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since
    });

    res.json({
      packets,
      total,
      offset,
      limit,
      maxCount: packetLogService.getMaxCount(),
      maxAgeHours: packetLogService.getMaxAgeHours()
    });
  } catch (error) {
    logger.error('❌ Error fetching packet logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/packets/stats
 * Get packet statistics
 */
router.get('/stats', requirePacketPermissions, async (_req, res) => {
  try {
    const total = await packetLogService.getPacketCountAsync();
    const encrypted = await packetLogService.getPacketCountAsync({ encrypted: true });
    const decoded = await packetLogService.getPacketCountAsync({ encrypted: false });

    res.json({
      total,
      encrypted,
      decoded,
      maxCount: packetLogService.getMaxCount(),
      maxAgeHours: packetLogService.getMaxAgeHours(),
      enabled: packetLogService.isEnabled()
    });
  } catch (error) {
    logger.error('❌ Error fetching packet stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/packets/stats/distribution
 * Get packet distribution by device and by type
 * Query params:
 *   - since: Unix timestamp (seconds) to filter packets from
 */
router.get('/stats/distribution', requirePacketPermissions, async (req, res) => {
  try {
    const enabled = packetLogService.isEnabled();

    // If not enabled, return empty data
    if (!enabled) {
      return res.json({
        byDevice: [],
        byType: [],
        total: 0,
        enabled: false
      });
    }

    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;

    // Fetch distribution data - limit to top 10 devices
    const [byDevice, byType, total] = await Promise.all([
      packetLogService.getPacketCountsByNodeAsync({ since, limit: 10, portnum }),
      packetLogService.getPacketCountsByPortnumAsync({ since, from_node }),
      packetLogService.getPacketCountAsync({ since, from_node, portnum })
    ]);

    res.json({
      byDevice,
      byType,
      total,
      enabled: true
    });
  } catch (error) {
    logger.error('❌ Error fetching packet distribution:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/packets/stats/node-distribution
 * Get packet type distribution for a specific node by querying actual data tables
 * (telemetry, messages, traceroutes) instead of the capped packet_log.
 * Query params:
 *   - node_id: The node's string ID (e.g. !b2a7be34) for telemetry lookups
 *   - node_num: The node's numeric ID for message/traceroute lookups
 *   - since: Unix timestamp (seconds) to filter from
 */
router.get('/stats/node-distribution', requirePacketPermissions, async (req, res) => {
  try {
    const nodeId = req.query.node_id as string | undefined;
    const nodeNum = req.query.node_num ? parseInt(req.query.node_num as string, 10) : undefined;
    const sinceParam = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
    // Convert since from seconds to milliseconds for data table queries
    // (telemetry, messages, traceroutes all store timestamps in milliseconds)
    const sinceMs = sinceParam !== undefined ? sinceParam * 1000 : undefined;

    if (!nodeId && nodeNum === undefined) {
      return res.status(400).json({ error: 'node_id or node_num is required' });
    }

    const byType: Array<{ portnum: number; portnum_name: string; count: number }> = [];
    let total = 0;

    // Query actual data tables in parallel
    const [positionCount, telemetryCount, messageCount, tracerouteCount, nodeInfoFromLog] = await Promise.all([
      // Position packets from telemetry table (uses milliseconds)
      nodeId ? databaseService.getPositionPacketCountByNodeAsync(nodeId, sinceMs) : Promise.resolve(0),
      // Non-position telemetry from telemetry table (uses milliseconds)
      nodeId ? databaseService.getNonPositionTelemetryPacketCountByNodeAsync(nodeId, sinceMs) : Promise.resolve(0),
      // Text messages from messages table (uses milliseconds)
      nodeNum !== undefined ? databaseService.getMessageCountByNodeAsync(nodeNum, sinceMs) : Promise.resolve(0),
      // Traceroutes from traceroutes table (uses milliseconds)
      nodeNum !== undefined ? databaseService.getTracerouteCountByNodeAsync(nodeNum, sinceMs) : Promise.resolve(0),
      // NodeInfo from packet_log (uses seconds - packet_log stores timestamps in seconds)
      nodeNum !== undefined
        ? packetLogService.getPacketCountsByPortnumAsync({ since: sinceParam, from_node: nodeNum })
        : Promise.resolve([]),
    ]);

    if (positionCount > 0) {
      byType.push({ portnum: 3, portnum_name: 'POSITION_APP', count: positionCount });
      total += positionCount;
    }
    if (telemetryCount > 0) {
      byType.push({ portnum: 67, portnum_name: 'TELEMETRY_APP', count: telemetryCount });
      total += telemetryCount;
    }
    if (messageCount > 0) {
      byType.push({ portnum: 1, portnum_name: 'TEXT_MESSAGE_APP', count: messageCount });
      total += messageCount;
    }
    if (tracerouteCount > 0) {
      byType.push({ portnum: 70, portnum_name: 'TRACEROUTE_APP', count: tracerouteCount });
      total += tracerouteCount;
    }

    // Add NodeInfo count from packet_log (nodeinfo updates nodes table in-place, no separate storage)
    const nodeInfoEntry = nodeInfoFromLog.find(e => e.portnum === 4);
    if (nodeInfoEntry && nodeInfoEntry.count > 0) {
      byType.push({ portnum: 4, portnum_name: 'NODEINFO_APP', count: nodeInfoEntry.count });
      total += nodeInfoEntry.count;
    }

    // Sort by count descending
    byType.sort((a, b) => b.count - a.count);

    res.json({
      byType,
      byDevice: [],
      total,
      enabled: true,
    });
  } catch (error) {
    logger.error('❌ Error fetching node packet distribution:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/packets/export
 * Export packet logs as JSONL with optional filtering
 * IMPORTANT: Must be registered before /:id route to avoid route matching conflicts
 */
router.get('/export', requirePacketPermissions, (req, res) => {
  try {
    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const to_node = req.query.to_node ? parseInt(req.query.to_node as string, 10) : undefined;
    const channel = req.query.channel ? parseInt(req.query.channel as string, 10) : undefined;
    const encrypted = req.query.encrypted === 'true' ? true : req.query.encrypted === 'false' ? false : undefined;
    const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;

    // Fetch all matching packets (up to configured max)
    const maxCount = packetLogService.getMaxCount();
    const packets = packetLogService.getPackets({
      offset: 0,
      limit: maxCount,
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since
    });

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const hasActiveFilters = portnum !== undefined ||
                            from_node !== undefined ||
                            to_node !== undefined ||
                            channel !== undefined ||
                            encrypted !== undefined ||
                            since !== undefined;
    const filterInfo = hasActiveFilters ? '-filtered' : '';
    const filename = `packet-monitor${filterInfo}-${timestamp}.jsonl`;

    // Set headers for file download
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream packets as JSONL
    for (const packet of packets) {
      res.write(JSON.stringify(packet) + '\n');
    }

    res.end();
    logger.debug(`📥 Exported ${packets.length} packets to ${filename}`);
  } catch (error) {
    logger.error('❌ Error exporting packets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/packets/:id
 * Get single packet by ID
 * IMPORTANT: Must be registered after more specific routes like /stats and /export
 */
router.get('/:id', requirePacketPermissions, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid packet ID' });
    }

    const packet = packetLogService.getPacketById(id);
    if (!packet) {
      return res.status(404).json({ error: 'Packet not found' });
    }

    res.json(packet);
  } catch (error) {
    logger.error('❌ Error fetching packet:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/packets
 * Clear all packet logs (admin only)
 */
router.delete('/', requirePacketPermissions, async (req, res) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    if (!isAdmin) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Only administrators can clear packet logs'
      });
    }

    const deletedCount = await packetLogService.clearPacketsAsync();
    logger.info(`🧹 Admin ${user.username} cleared ${deletedCount} packet logs`);

    // Log to audit log
    databaseService.auditLog(
      user.id,
      'packets_cleared',
      'packets',
      `Cleared ${deletedCount} packet log entries`,
      req.ip || null
    );

    res.json({
      message: 'Packet logs cleared successfully',
      deletedCount
    });
  } catch (error) {
    logger.error('❌ Error clearing packet logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
