import express from 'express';
import packetLogService from '../services/packetLogService.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';
import type { PermissionSet } from '../../types/permission.js';
import { PortNum } from '../constants/meshtastic.js';

const BROADCAST_NODE = 4294967295; // 0xFFFFFFFF

/** Normalize a `since` timestamp to milliseconds (auto-detect seconds vs ms) */
function normalizeSinceToMs(value: string): number {
  const n = parseInt(value, 10);
  return n < 10_000_000_000 ? n * 1000 : n;
}

const router = express.Router();

/**
 * Get the set of channel indices (0-7) that the user has read permission for.
 * Also includes channel database (virtual channel) IDs the user can read.
 */
function getAllowedChannels(permissions: PermissionSet): Set<number> {
  const allowed = new Set<number>();
  for (let i = 0; i < 8; i++) {
    const key = `channel_${i}` as keyof PermissionSet;
    if (permissions[key]?.read === true) {
      allowed.add(i);
    }
  }
  return allowed;
}

/**
 * Filter packets based on channel and message permissions.
 * - Encrypted packets always pass through (content is not readable anyway)
 * - TEXT_MESSAGE_APP DMs (to_node != broadcast) require messages:read permission
 * - Decrypted packets require read permission on the packet's channel
 */
function filterPacketsByPermissions<T extends { encrypted: boolean; channel?: number | null; portnum?: number | null; to_node?: number | null }>(
  packets: T[],
  allowedChannels: Set<number>,
  isAdmin: boolean,
  canReadMessages: boolean
): T[] {
  if (isAdmin) return packets;
  return packets.filter(packet => {
    // Encrypted packets always visible
    if (packet.encrypted) return true;
    // TEXT_MESSAGE_APP DMs require messages:read permission
    if (packet.portnum === PortNum.TEXT_MESSAGE_APP &&
        packet.to_node !== undefined && packet.to_node !== null &&
        packet.to_node !== BROADCAST_NODE) {
      return canReadMessages;
    }
    // Decrypted packets require channel read permission
    if (packet.channel !== undefined && packet.channel !== null) {
      return allowedChannels.has(packet.channel);
    }
    // Packets with no channel info - allow (e.g. internal packets)
    return true;
  });
}

/**
 * Permission middleware - require packetmonitor:read permission
 * Also attaches allowed channels and admin status to request for downstream filtering
 */
const requirePacketPermissions: RequestHandler = async (req, res, next) => {
  try {
    const user = (req as any).user;
    const userId = user?.id ?? null;
    const sourceIdQ = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    (req as any).scopedSourceId = sourceIdQ;

    // Get user permissions scoped to the requested source (null sourceId falls
    // back to the legacy merged map — callers without a source get the same
    // behavior as before).
    const permissions = userId !== null
      ? await databaseService.getUserPermissionSetAsync(userId, sourceIdQ)
      : {};

    // Check if user is admin (admins have all permissions)
    const isAdmin = user?.isAdmin ?? false;

    if (isAdmin) {
      (req as any).isAdmin = true;
      (req as any).allowedChannels = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7]);
      (req as any).canReadMessages = true;
      return next();
    }

    // Check packetmonitor:read permission (scoped to source if provided)
    const hasPacketMonitorRead = userId !== null
      ? await databaseService.checkPermissionAsync(userId, 'packetmonitor', 'read', sourceIdQ)
      : false;

    if (!hasPacketMonitorRead) {
      logger.warn(`❌ Permission denied for packet access - packetmonitor:read=${hasPacketMonitorRead}`);
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You need packetmonitor:read permission to access packet logs'
      });
    }

    // Attach allowed channels and message permissions for downstream filtering
    (req as any).isAdmin = false;
    (req as any).allowedChannels = getAllowedChannels(permissions);
    (req as any).canReadMessages = permissions.messages?.read === true;

    // Also check channel database permissions for virtual channels
    if (userId !== null) {
      const channelDbPerms = await databaseService.channelDatabase.getPermissionsForUserAsync(userId);
      const allowedDbChannels = channelDbPerms
        .filter((p: { canRead: boolean }) => p.canRead)
        .map((p: { channelDatabaseId: number }) => p.channelDatabaseId);
      (req as any).allowedChannelDbIds = new Set<number>(allowedDbChannels);
    } else {
      (req as any).allowedChannelDbIds = new Set<number>();
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
    const MAX_LIMIT = await packetLogService.getMaxCount();
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
    const since = req.query.since ? normalizeSinceToMs(req.query.since as string) : undefined;
    const relay_node = req.query.relay_node === 'unknown' ? 'unknown' as const : req.query.relay_node ? parseInt(req.query.relay_node as string, 10) : undefined;

    const isAdmin = (req as any).isAdmin;
    const allowedChannels = (req as any).allowedChannels as Set<number>;
    const canReadMessages = (req as any).canReadMessages as boolean;
    const sourceId = (req as any).scopedSourceId as string | undefined;

    const rawPackets = await packetLogService.getPacketsAsync({
      offset,
      limit,
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since,
      relay_node,
      sourceId
    });

    // Filter packets by channel and message permissions
    const packets = filterPacketsByPermissions(rawPackets, allowedChannels, isAdmin, canReadMessages);

    const total = await packetLogService.getPacketCountAsync({
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since,
      relay_node,
      sourceId
    });

    res.json({
      packets,
      total,
      offset,
      limit,
      maxCount: await packetLogService.getMaxCount(),
      maxAgeHours: await packetLogService.getMaxAgeHours()
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
router.get('/stats', requirePacketPermissions, async (req, res) => {
  try {
    const sourceId = (req as any).scopedSourceId as string | undefined;
    const total = await packetLogService.getPacketCountAsync({ sourceId });
    const encrypted = await packetLogService.getPacketCountAsync({ encrypted: true, sourceId });
    const decoded = await packetLogService.getPacketCountAsync({ encrypted: false, sourceId });

    res.json({
      total,
      encrypted,
      decoded,
      maxCount: await packetLogService.getMaxCount(),
      maxAgeHours: await packetLogService.getMaxAgeHours(),
      enabled: await packetLogService.isEnabled()
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
 *   - since: Unix timestamp (seconds or milliseconds, auto-detected) to filter packets from
 */
router.get('/stats/distribution', requirePacketPermissions, async (req, res) => {
  try {
    const enabled = await packetLogService.isEnabled();

    // If not enabled, return empty data
    if (!enabled) {
      return res.json({
        byDevice: [],
        byType: [],
        total: 0,
        enabled: false
      });
    }

    const since = req.query.since ? normalizeSinceToMs(req.query.since as string) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;
    const sourceId = (req as any).scopedSourceId as string | undefined;

    // Fetch distribution data - limit to top 10 devices
    const [byDevice, byType, total] = await Promise.all([
      packetLogService.getPacketCountsByNodeAsync({ since, limit: 10, portnum, sourceId }),
      packetLogService.getPacketCountsByPortnumAsync({ since, from_node, sourceId }),
      packetLogService.getPacketCountAsync({ since, from_node, portnum, sourceId })
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
 * GET /api/packets/relay-nodes
 * Get distinct relay nodes that appear in packet logs (for filter dropdowns)
 */
router.get('/relay-nodes', requirePacketPermissions, async (req, res) => {
  try {
    const sourceId = (req as any).scopedSourceId as string | undefined;
    const relayNodes = await packetLogService.getDistinctRelayNodesAsync(sourceId);
    res.json({ relayNodes });
  } catch (error) {
    logger.error('❌ Error fetching relay nodes:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/packets/export
 * Export packet logs as JSONL with optional filtering
 * IMPORTANT: Must be registered before /:id route to avoid route matching conflicts
 */
router.get('/export', requirePacketPermissions, async (req, res) => {
  try {
    const portnum = req.query.portnum ? parseInt(req.query.portnum as string, 10) : undefined;
    const from_node = req.query.from_node ? parseInt(req.query.from_node as string, 10) : undefined;
    const to_node = req.query.to_node ? parseInt(req.query.to_node as string, 10) : undefined;
    const channel = req.query.channel ? parseInt(req.query.channel as string, 10) : undefined;
    const encrypted = req.query.encrypted === 'true' ? true : req.query.encrypted === 'false' ? false : undefined;
    const since = req.query.since ? normalizeSinceToMs(req.query.since as string) : undefined;
    const relay_node = req.query.relay_node === 'unknown' ? 'unknown' as const : req.query.relay_node ? parseInt(req.query.relay_node as string, 10) : undefined;

    const isAdmin = (req as any).isAdmin;
    const allowedChannels = (req as any).allowedChannels as Set<number>;
    const canReadMessages = (req as any).canReadMessages as boolean;
    const sourceId = (req as any).scopedSourceId as string | undefined;

    // Fetch all matching packets (up to configured max)
    const maxCount = await packetLogService.getMaxCount();
    const rawPackets = await packetLogService.getPacketsAsync({
      offset: 0,
      limit: maxCount,
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since,
      relay_node,
      sourceId
    });

    // Filter packets by channel and message permissions
    const packets = filterPacketsByPermissions(rawPackets, allowedChannels, isAdmin, canReadMessages);

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
router.get('/:id', requirePacketPermissions, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid packet ID' });
    }

    const packet = await packetLogService.getPacketByIdAsync(id);
    if (!packet) {
      return res.status(404).json({ error: 'Packet not found' });
    }

    // Check channel and message permissions for this packet
    const isAdmin = (req as any).isAdmin;
    const allowedChannels = (req as any).allowedChannels as Set<number>;
    const canReadMessages = (req as any).canReadMessages as boolean;
    const filtered = filterPacketsByPermissions([packet], allowedChannels, isAdmin, canReadMessages);
    if (filtered.length === 0) {
      return res.status(403).json({ error: 'You do not have permission to view this packet' });
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
    databaseService.auditLogAsync(
      user.id,
      'packets_cleared',
      'packetmonitor',
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
