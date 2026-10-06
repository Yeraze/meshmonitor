import { Router, Request, Response } from 'express';
import { optionalAuth, requireAuth, requireAdmin } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager, isMqttConnectionStatusManager } from '../sourceManagerTypes.js';
import { requireMeshtasticDeviceSource } from '../utils/requireMeshtasticDeviceSource.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { mayViewSourceEndpoint } from '../utils/sourceConfigRedaction.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';
import { fail } from '../utils/apiResponse.js';

const NOT_CONNECTED = {
  connected: false,
  nodeResponsive: false,
  configuring: false,
  userDisconnected: false,
};

/**
 * Connection status for a sourceId that is NOT a live Meshtastic manager, or
 * undefined when the caller should use the Meshtastic manager as before.
 * resolveSourceManager() would report the PRIMARY radio's status for these
 * (#5375): an MQTT broker/bridge reports its own broker link; any other
 * non-Meshtastic source (MeshCore, Reticulum) or an id with no live manager
 * reports a stable "not connected".
 */
async function nonMeshtasticConnectionStatus(sourceId: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!sourceId) return undefined;
  const mgr = sourceManagerRegistry.getManager(sourceId);
  if (mgr && isMeshtasticManager(mgr)) return undefined;
  if (mgr && isMqttConnectionStatusManager(mgr)) return { ...(await mgr.getConnectionStatus()) };
  return { ...NOT_CONNECTED };
}

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
    // The same applies to a non-Meshtastic source (#5375): report its own
    // state, never the primary radio's.
    const ownStatus = await nonMeshtasticConnectionStatus(connSourceId);
    const status = ownStatus ?? await resolveSourceManager(connSourceId).getConnectionStatus();
    // The node address is a connection endpoint: signed in with `sources:read`
    // (or admin) only, the same rule the source list applies to `config.host`.
    if (!(await mayViewSourceEndpoint(req))) {
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

// Disconnect / reconnect / configure act on ONE Meshtastic TCP link: the
// `sourceId` in the body, or the primary source when it is omitted. A
// non-Meshtastic sourceId would act on the PRIMARY radio instead (#5375), and
// `connection` is a per-source permission, so the gate resolves the source
// once and checks the permission on it. MeshCore and MQTT sources are
// connected and disconnected through `/api/sources/:id/(dis)connect`.
const connectionWriteGate = requireDeviceSourcePermission('connection', 'write', 'body', 'connection controls');

router.post('/disconnect', connectionWriteGate, async (req: Request, res: Response) => {
  try {
    await getDeviceSourceTarget(req).manager.userDisconnect();

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
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to disconnect');
  }
});

// User-initiated reconnect endpoint
router.post('/reconnect', connectionWriteGate, async (req: Request, res: Response) => {
  try {
    const success = await getDeviceSourceTarget(req).manager.userReconnect();

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
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to reconnect');
  }
});

// Get detailed connection info (authenticated users only)
router.get('/info', requireAuth(), async (req: Request, res: Response) => {
  try {
    const ciSourceId = req.query.sourceId as string | undefined;
    // A non-Meshtastic source has no node address or TCP override to show;
    // report its own status and say so, not the primary's link (#5375).
    const ownStatus = await nonMeshtasticConnectionStatus(ciSourceId);
    if (ownStatus) {
      const { nodeIp: _nodeIp, ...rest } = ownStatus;
      res.json({ ...rest, hasLocalRadio: false });
      return;
    }
    const ciManager = resolveSourceManager(ciSourceId);
    const status = await ciManager.getConnectionStatus();
    const env = getEnvironmentConfig();
    const ipOverride = await databaseService.settings.getSetting('meshtasticNodeIpOverride');
    const portOverride = await databaseService.settings.getSetting('meshtasticTcpPortOverride');

    // Signed in is not enough to see the address — see mayViewSourceEndpoint.
    if (!(await mayViewSourceEndpoint(req))) {
      const { nodeIp: _nodeIp, ...rest } = status;
      res.json({
        ...rest,
        defaultPort: env.meshtasticTcpPort,
        isOverridden: !!(ipOverride || portOverride),
        tcpPort: portOverride ? parseInt(portOverride, 10) : env.meshtasticTcpPort,
      });
      return;
    }

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
router.post('/configure', requireAdmin(), requireMeshtasticDeviceSource('body', 'connection controls'), async (req: Request, res: Response) => {
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
