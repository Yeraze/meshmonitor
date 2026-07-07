import { Router, Request, Response } from 'express';
import { optionalAuth, requireAuth, requirePermission, requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getEnvironmentConfig } from '../config/environment.js';

const router = Router();

// Connection status endpoint
router.get('/', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const connSourceId = req.query.sourceId as string | undefined;
    // When the caller explicitly names a sourceId but no manager is registered
    // for it (e.g. autoConnect=false, or user manually disconnected via
    // /api/sources/:id/disconnect — issue #2773), return a stable
    // "not connected" response instead of silently falling back to the legacy
    // singleton. The singleton is the primary source's manager and would
    // otherwise leak its state across sources.
    if (connSourceId && !sourceManagerRegistry.getManager(connSourceId)) {
      res.json({
        connected: false,
        nodeResponsive: false,
        configuring: false,
        userDisconnected: false,
      });
      return;
    }
    const connManager = resolveSourceManager(connSourceId);
    const status = await connManager.getConnectionStatus();
    // Hide nodeIp from anonymous users
    if (!req.session.userId) {
      const { nodeIp: _nodeIp, ...statusWithoutNodeIp } = status;
      res.json(statusWithoutNodeIp);
    } else {
      res.json(status);
    }
  } catch (error) {
    logger.error('Error getting connection status:', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

router.post('/disconnect', requirePermission('connection', 'write'), async (req: Request, res: Response) => {
  try {
    const { sourceId: disconnectSourceId } = req.body;
    const disconnectManager = (resolveSourceManager(disconnectSourceId));
    await disconnectManager.userDisconnect();

    // Audit log
    void databaseService.auditLogAsync(
      req.user!.id,
      'connection_disconnected',
      'connection',
      'User initiated disconnect',
      req.ip || null
    );

    res.json({ success: true, status: 'user-disconnected' });
  } catch (error) {
    logger.error('Error disconnecting:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// User-initiated reconnect endpoint
router.post('/reconnect', requirePermission('connection', 'write'), async (req: Request, res: Response) => {
  try {
    const { sourceId: reconnectSourceId } = req.body;
    const reconnectManager = (resolveSourceManager(reconnectSourceId));
    const success = await reconnectManager.userReconnect();

    // Audit log
    void databaseService.auditLogAsync(
      req.user!.id,
      'connection_reconnected',
      'connection',
      JSON.stringify({ success }),
      req.ip || null
    );

    res.json({
      success,
      status: success ? 'connecting' : 'disconnected',
    });
  } catch (error) {
    logger.error('Error reconnecting:', error);
    res.status(500).json({ error: 'Failed to reconnect' });
  }
});

// Get detailed connection info (authenticated users only)
router.get('/info', requireAuth(), async (req: Request, res: Response) => {
  try {
    const ciSourceId = req.query.sourceId as string | undefined;
    const ciManager = resolveSourceManager(ciSourceId);
    const status = await ciManager.getConnectionStatus();
    const env = getEnvironmentConfig();
    const ipOverride = await databaseService.settings.getSetting('meshtasticNodeIpOverride');
    const portOverride = await databaseService.settings.getSetting('meshtasticTcpPortOverride');

    res.json({
      ...status,
      defaultIp: env.meshtasticNodeIp,
      defaultPort: env.meshtasticTcpPort,
      isOverridden: !!(ipOverride || portOverride),
      tcpPort: portOverride ? parseInt(portOverride, 10) : env.meshtasticTcpPort
    });
  } catch (error) {
    logger.error('Error getting connection info:', error);
    res.status(500).json({ error: 'Failed to get connection info' });
  }
});

// Configure connection IP address (admin only)
router.post('/configure', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { nodeIp } = req.body;

    // Validate IP format (IPv4 address or hostname, with optional port)
    // Accepts: 192.168.1.100, 192.168.1.100:4403, hostname, hostname:4403
    const ipRegex = /^(?:(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)|[\w.-]+)(?::\d{1,5})?$/;
    if (!nodeIp || !ipRegex.test(nodeIp)) {
      return res.status(400).json({ error: 'Invalid IP address or hostname' });
    }

    // Validate port range if specified
    const portMatch = nodeIp.match(/:(\d+)$/);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      if (port < 1 || port > 65535) {
        return res.status(400).json({ error: 'Port must be between 1 and 65535' });
      }
    }

    // Set the override
    const { sourceId: connConfigSourceId } = req.body;
    const connConfigManager = (resolveSourceManager(connConfigSourceId));
    await connConfigManager.setNodeIpOverride(nodeIp);

    // Audit log
    void databaseService.auditLogAsync(
      req.user!.id,
      'connection_address_changed',
      'connection',
      JSON.stringify({ address: nodeIp }),
      req.ip || null
    );

    res.json({
      success: true,
      message: 'Node address updated. Reconnecting...',
      nodeIp
    });
  } catch (error) {
    logger.error('Error configuring connection:', error);
    res.status(500).json({ error: 'Failed to configure connection' });
  }
});

export default router;
