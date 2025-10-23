import express from 'express';
import packetLogService from '../services/packetLogService.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { RequestHandler } from 'express';

const router = express.Router();

/**
 * Permission middleware - require BOTH channels:read AND messages:read
 */
const requirePacketPermissions: RequestHandler = (req, res, next) => {
  const user = (req as any).user;
  const userId = user?.id ?? null;

  // Get user permissions (works for both authenticated and anonymous users)
  const permissions = userId !== null
    ? databaseService.permissionModel.getUserPermissionSet(userId)
    : {};

  // Check if user is admin (admins have all permissions)
  const isAdmin = user?.isAdmin ?? false;

  if (isAdmin) {
    // Admins have all permissions
    return next();
  }

  // Check both channels:read and messages:read
  const hasChannelsRead = permissions.channels?.read === true;
  const hasMessagesRead = permissions.messages?.read === true;

  if (!hasChannelsRead || !hasMessagesRead) {
    logger.warn(`❌ Permission denied for packet access - channels:read=${hasChannelsRead}, messages:read=${hasMessagesRead}`);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You need both channels:read and messages:read permissions to access packet logs'
    });
  }

  next();
};

/**
 * GET /api/packets
 * Get packet logs with optional filtering
 */
router.get('/', requirePacketPermissions, (req, res) => {
  try {
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    let limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    // Enforce maximum limit to prevent unbounded queries
    const MAX_LIMIT = 1000;
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

    const packets = packetLogService.getPackets({
      offset,
      limit,
      portnum,
      from_node,
      to_node,
      channel,
      encrypted,
      since
    });

    const total = packetLogService.getPacketCount({
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
router.get('/stats', requirePacketPermissions, (_req, res) => {
  try {
    const total = packetLogService.getPacketCount();
    const encrypted = packetLogService.getPacketCount({ encrypted: true });
    const decoded = packetLogService.getPacketCount({ encrypted: false });

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
 * GET /api/packets/:id
 * Get single packet by ID
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
router.delete('/', requirePacketPermissions, (req, res) => {
  try {
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;

    if (!isAdmin) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Only administrators can clear packet logs'
      });
    }

    const deletedCount = packetLogService.clearPackets();
    logger.info(`🧹 Admin ${user.username} cleared ${deletedCount} packet logs`);

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
