/**
 * MeshCore API Routes
 *
 * RESTful endpoints for MeshCore device interaction
 *
 * Authentication:
 * - Read-only endpoints use optionalAuth() (status, nodes, contacts, messages)
 * - Write operations require authentication (connect, disconnect, send, config)
 */

import { Router, Request, Response } from 'express';
import { ConnectionType, MeshCoreDeviceType, MeshCoreManager } from '../meshcoreManager.js';
import { meshcoreManagerRegistry } from '../meshcoreRegistry.js';
import { getMeshCoreTelemetryPoller, nodeNumFromPubkey } from '../services/meshcoreTelemetryPoller.js';
import { MAX_INTERVAL_MINUTES } from '../services/meshcoreRemoteTelemetryScheduler.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter, messageLimiter } from '../middleware/rateLimiters.js';

/**
 * Resolve the manager for a request. Mounted only under
 * `/api/sources/:id/meshcore/*`, so `req.params.id` is always present —
 * the legacy un-nested mount and its registry fallback were removed in
 * slice 3 along with the global `meshcore` permission resource.
 *
 * Presence + existence of the manager is enforced by the router-level
 * guard below, so the assertion here is safe.
 */
function managerFor(req: Request): MeshCoreManager {
  const sourceId = (req.params as { id?: string }).id!;
  return meshcoreManagerRegistry.get(sourceId)!;
}

const router = Router({ mergeParams: true });

/**
 * Router-level guard: every request must carry an `:id` and that source
 * must have a registered manager. This lets every handler call
 * `managerFor` without null-checking at each call-site.
 */
router.use((req, res, next) => {
  const sourceId = (req.params as { id?: string }).id;
  if (!sourceId) {
    return res.status(404).json({
      success: false,
      error: 'MeshCore routes must be mounted under /api/sources/:id/meshcore',
    });
  }
  if (!meshcoreManagerRegistry.get(sourceId)) {
    return res.status(404).json({
      success: false,
      error: `No MeshCore manager for source ${sourceId}`,
    });
  }
  next();
});

/**
 * Input Validation Constants
 */
const VALIDATION = {
  /** MeshCore public keys are 64-character hex strings (32 bytes) */
  PUBLIC_KEY_LENGTH: 64,
  /** Maximum message length (LoRa packet size limit) */
  MAX_MESSAGE_LENGTH: 230,
  /** Maximum device name length */
  MAX_NAME_LENGTH: 32,
  /** Maximum message history limit */
  MAX_MESSAGE_LIMIT: 1000,
  /** Radio frequency range (MHz) */
  FREQ_MIN: 137.0,
  FREQ_MAX: 1020.0,
  /** Bandwidth values (kHz) */
  VALID_BANDWIDTHS: [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500],
  /** Spreading factor range */
  SF_MIN: 5,
  SF_MAX: 12,
  /** Coding rate range (represents 4/5 through 4/8) */
  CR_MIN: 5,
  CR_MAX: 8,
  /** Valid baud rates */
  VALID_BAUD_RATES: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600],
  /** TCP port range */
  PORT_MIN: 1,
  PORT_MAX: 65535,
} as const;

/**
 * Validation helper functions
 */
function isValidPublicKey(key: string | undefined): boolean {
  if (!key || typeof key !== 'string') return false;
  return /^[0-9a-fA-F]{64}$/.test(key);
}

function isValidMessage(text: string | undefined): { valid: boolean; error?: string } {
  if (!text || typeof text !== 'string') {
    return { valid: false, error: 'Message text required' };
  }
  if (text.length > VALIDATION.MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Message exceeds maximum length of ${VALIDATION.MAX_MESSAGE_LENGTH} characters` };
  }
  return { valid: true };
}

function isValidName(name: string | undefined): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Name required' };
  }
  if (name.length > VALIDATION.MAX_NAME_LENGTH) {
    return { valid: false, error: `Name exceeds maximum length of ${VALIDATION.MAX_NAME_LENGTH} characters` };
  }
  if (name.trim().length === 0) {
    return { valid: false, error: 'Name cannot be empty or whitespace only' };
  }
  return { valid: true };
}

function isValidRadioParams(freq: number, bw: number, sf: number, cr: number): { valid: boolean; error?: string } {
  if (freq < VALIDATION.FREQ_MIN || freq > VALIDATION.FREQ_MAX) {
    return { valid: false, error: `Frequency must be between ${VALIDATION.FREQ_MIN} and ${VALIDATION.FREQ_MAX} MHz` };
  }
  if (!(VALIDATION.VALID_BANDWIDTHS as readonly number[]).includes(bw)) {
    return { valid: false, error: `Bandwidth must be one of: ${VALIDATION.VALID_BANDWIDTHS.join(', ')} kHz` };
  }
  if (sf < VALIDATION.SF_MIN || sf > VALIDATION.SF_MAX || !Number.isInteger(sf)) {
    return { valid: false, error: `Spreading factor must be an integer between ${VALIDATION.SF_MIN} and ${VALIDATION.SF_MAX}` };
  }
  if (cr < VALIDATION.CR_MIN || cr > VALIDATION.CR_MAX || !Number.isInteger(cr)) {
    return { valid: false, error: `Coding rate must be an integer between ${VALIDATION.CR_MIN} and ${VALIDATION.CR_MAX}` };
  }
  return { valid: true };
}

function isValidConnectionParams(params: {
  connectionType?: string;
  tcpPort?: number;
  baudRate?: number;
}): { valid: boolean; error?: string } {
  const { connectionType, tcpPort, baudRate } = params;

  if (connectionType && !['serial', 'tcp'].includes(connectionType)) {
    return { valid: false, error: 'Connection type must be "serial" or "tcp"' };
  }
  if (tcpPort !== undefined) {
    if (!Number.isInteger(tcpPort) || tcpPort < VALIDATION.PORT_MIN || tcpPort > VALIDATION.PORT_MAX) {
      return { valid: false, error: `TCP port must be between ${VALIDATION.PORT_MIN} and ${VALIDATION.PORT_MAX}` };
    }
  }
  if (baudRate !== undefined && !(VALIDATION.VALID_BAUD_RATES as readonly number[]).includes(baudRate)) {
    return { valid: false, error: `Baud rate must be one of: ${VALIDATION.VALID_BAUD_RATES.join(', ')}` };
  }
  return { valid: true };
}

/**
 * GET /api/meshcore/status
 * Get connection status and local node info
 */
router.get('/status', optionalAuth(), requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req);
    const status = manager.getConnectionStatus();
    const localNode = manager.getLocalNode();

    res.json({
      success: true,
      data: {
        ...status,
        localNode,
        deviceTypeName: MeshCoreDeviceType[status.deviceType],
      },
    });
  } catch (error) {
    logger.error('[API] Error getting MeshCore status:', error);
    res.status(500).json({ success: false, error: 'Failed to get status' });
  }
});

/**
 * POST /api/meshcore/connect
 * Connect to a MeshCore device
 * Requires authentication - connects to hardware
 */
router.post('/connect', meshcoreDeviceLimiter, requireAuth(), requirePermission('connection', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { connectionType, serialPort, tcpHost, tcpPort, baudRate, deviceType } = req.body;

    // Parse numeric values
    const parsedTcpPort = tcpPort ? parseInt(tcpPort, 10) : undefined;
    const parsedBaudRate = baudRate ? parseInt(baudRate, 10) : undefined;

    // Validate connection parameters
    const validation = isValidConnectionParams({
      connectionType,
      tcpPort: parsedTcpPort,
      baudRate: parsedBaudRate,
    });
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const firmwareType: 'companion' | 'repeater' = deviceType === 'repeater' ? 'repeater' : 'companion';

    const config = {
      connectionType: connectionType as ConnectionType || ConnectionType.SERIAL,
      serialPort,
      tcpHost,
      tcpPort: parsedTcpPort ?? 4403,
      baudRate: parsedBaudRate ?? 115200,
      firmwareType,
    };

    const manager = managerFor(req);
    const success = await manager.connect(config);

    if (success) {
      res.json({
        success: true,
        message: 'Connected successfully',
        data: {
          localNode: manager.getLocalNode(),
          deviceType: MeshCoreDeviceType[manager.getConnectionStatus().deviceType],
        },
      });
    } else {
      res.status(400).json({ success: false, error: 'Connection failed' });
    }
  } catch (error) {
    logger.error('[API] Error connecting to MeshCore:', error);
    res.status(500).json({ success: false, error: 'Connection error' });
  }
});

/**
 * POST /api/meshcore/disconnect
 * Disconnect from the device
 * Requires authentication - disconnects hardware
 */
router.post('/disconnect', meshcoreDeviceLimiter, requireAuth(), requirePermission('connection', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    await managerFor(req).disconnect();
    res.json({ success: true, message: 'Disconnected' });
  } catch (error) {
    logger.error('[API] Error disconnecting:', error);
    res.status(500).json({ success: false, error: 'Disconnect error' });
  }
});

/**
 * GET /api/meshcore/nodes
 * Get all known nodes (local + contacts)
 */
router.get('/nodes', optionalAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const nodes = managerFor(req).getAllNodes();
    res.json({
      success: true,
      data: nodes,
      count: nodes.length,
    });
  } catch (error) {
    logger.error('[API] Error getting nodes:', error);
    res.status(500).json({ success: false, error: 'Failed to get nodes' });
  }
});

/**
 * GET /api/meshcore/contacts
 * Get contacts list
 */
router.get('/contacts', optionalAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req);
    const contacts = manager.getContacts();
    const localNode = manager.getLocalNode();

    // Include local node in contacts list if it has coordinates
    const allContacts = [...contacts];
    if (localNode && localNode.latitude && localNode.longitude) {
      allContacts.unshift({
        publicKey: localNode.publicKey,
        advName: `${localNode.name} (local)`,
        name: localNode.name,
        latitude: localNode.latitude,
        longitude: localNode.longitude,
        advType: localNode.advType,
        rssi: undefined,
        snr: undefined,
        lastSeen: Date.now(),
      });
    }

    res.json({
      success: true,
      data: allContacts,
      count: allContacts.length,
    });
  } catch (error) {
    logger.error('[API] Error getting contacts:', error);
    res.status(500).json({ success: false, error: 'Failed to get contacts' });
  }
});

/**
 * POST /api/meshcore/contacts/refresh
 * Refresh contacts from device
 * Requires authentication - triggers device communication
 */
router.post('/contacts/refresh', meshcoreDeviceLimiter, requireAuth(), requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const contacts = await managerFor(req).refreshContacts();
    res.json({
      success: true,
      data: Array.from(contacts.values()),
      count: contacts.size,
    });
  } catch (error) {
    logger.error('[API] Error refreshing contacts:', error);
    res.status(500).json({ success: false, error: 'Failed to refresh contacts' });
  }
});

/**
 * GET /api/meshcore/messages
 * Get recent messages. Optional ?since=<ms-timestamp> returns only messages newer than that time.
 */
router.get('/messages', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    let limit = parseInt(req.query.limit as string || '50', 10);
    // Validate and clamp limit to reasonable bounds
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    } else if (limit > VALIDATION.MAX_MESSAGE_LIMIT) {
      limit = VALIDATION.MAX_MESSAGE_LIMIT;
    }
    const sinceRaw = req.query.since as string | undefined;
    const since = sinceRaw ? parseInt(sinceRaw, 10) : undefined;
    let messages = managerFor(req).getRecentMessages(limit);
    if (since !== undefined && !isNaN(since)) {
      messages = messages.filter(m => m.timestamp > since);
    }
    res.json({
      success: true,
      data: messages,
      count: messages.length,
    });
  } catch (error) {
    logger.error('[API] Error getting messages:', error);
    res.status(500).json({ success: false, error: 'Failed to get messages' });
  }
});

/**
 * GET /api/sources/:id/meshcore/snapshot
 * Single-call initial load: status, localNode, contacts, nodes, messages, and a seqCursor
 * (the timestamp of the newest message) for reconnect catch-up.
 */
router.get('/snapshot', optionalAuth(), requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req);
    const status = manager.getConnectionStatus();
    const localNode = manager.getLocalNode();
    const contacts = manager.getContacts();
    const nodes = manager.getAllNodes();
    const messages = manager.getRecentMessages(50);
    const seqCursor = messages.length > 0 ? Math.max(...messages.map(m => m.timestamp)) : 0;

    // Mirror the contacts-with-localNode logic from GET /contacts
    const allContacts = [...contacts];
    if (localNode && localNode.latitude && localNode.longitude) {
      allContacts.unshift({
        publicKey: localNode.publicKey,
        advName: `${localNode.name} (local)`,
        name: localNode.name,
        latitude: localNode.latitude,
        longitude: localNode.longitude,
        advType: localNode.advType,
        rssi: undefined,
        snr: undefined,
        lastSeen: Date.now(),
      });
    }

    res.json({
      success: true,
      data: {
        status: {
          ...status,
          localNode,
          deviceTypeName: MeshCoreDeviceType[status.deviceType],
        },
        contacts: allContacts,
        nodes,
        messages,
        seqCursor,
      },
    });
  } catch (error) {
    logger.error('[API] Error getting snapshot:', error);
    res.status(500).json({ success: false, error: 'Failed to get snapshot' });
  }
});

/**
 * GET /api/sources/:id/meshcore/info
 *
 * Single-call payload for the MeshCore Node Info page:
 *
 *   - `identity`: name, pubkey, node type, manufacturer/model, firmware
 *     ver + build date, radio config, advertised lat/lon — pulled from
 *     `localNode` which now folds in DeviceQuery output.
 *   - `latest`: the most recent telemetry poll snapshot from
 *     `MeshCoreTelemetryPoller`. Contains battery, queue depth, noise
 *     floor, RSSI/SNR, RTC drift, packet counters, and computed
 *     duty-cycle / rate fields. `null` until the first poll completes.
 *   - `telemetryRef`: { nodeId, nodeNum, sourceId } — the keys the existing
 *     `/api/telemetry/:nodeId?sourceId=...` endpoint indexes graphs on.
 *
 * Companion-only. Repeaters do not expose GetStats; the response will
 * still include identity but `latest` will be `null` and clients should
 * suppress the health/graphs panels.
 */
router.get('/info', optionalAuth(), requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req);
    const status = manager.getConnectionStatus();
    const localNode = manager.getLocalNode();
    const poller = getMeshCoreTelemetryPoller();
    const snapshot = poller ? poller.getLastSnapshot(manager.sourceId) : undefined;

    const telemetryRef = localNode?.publicKey
      ? {
          nodeId: localNode.publicKey,
          nodeNum: nodeNumFromPubkey(localNode.publicKey),
          sourceId: manager.sourceId,
        }
      : null;

    res.json({
      success: true,
      data: {
        sourceId: manager.sourceId,
        connected: status.connected,
        deviceType: status.deviceType,
        deviceTypeName: MeshCoreDeviceType[status.deviceType],
        identity: localNode,
        latest: snapshot ?? null,
        telemetryRef,
      },
    });
  } catch (error) {
    logger.error('[API] Error getting MeshCore info:', error);
    res.status(500).json({ success: false, error: 'Failed to get info' });
  }
});

/**
 * POST /api/meshcore/messages/send
 * Send a message
 * Requires authentication - sends data over mesh network
 */
router.post('/messages/send', messageLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { text, toPublicKey } = req.body;

    // Validate message text
    const textValidation = isValidMessage(text);
    if (!textValidation.valid) {
      return res.status(400).json({ success: false, error: textValidation.error });
    }

    // Validate public key if provided (for direct messages)
    if (toPublicKey !== undefined && toPublicKey !== null && toPublicKey !== '') {
      if (!isValidPublicKey(toPublicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
      }
    }

    const success = await managerFor(req).sendMessage(text, toPublicKey);

    if (success) {
      res.json({ success: true, message: 'Message sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send message' });
    }
  } catch (error) {
    logger.error('[API] Error sending message:', error);
    res.status(500).json({ success: false, error: 'Send error' });
  }
});

/**
 * POST /api/meshcore/advert
 * Send an advertisement
 * Requires authentication - broadcasts on mesh network
 */
router.post('/advert', meshcoreDeviceLimiter, requireAuth(), requirePermission('connection', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const success = await managerFor(req).sendAdvert();

    if (success) {
      res.json({ success: true, message: 'Advert sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send advert' });
    }
  } catch (error) {
    logger.error('[API] Error sending advert:', error);
    res.status(500).json({ success: false, error: 'Advert error' });
  }
});

/**
 * POST /api/meshcore/admin/login
 * Login to a remote node for admin access
 * Requires authentication - sensitive admin operation
 */
router.post('/admin/login', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, password } = req.body;

    if (!publicKey || !password) {
      return res.status(400).json({ success: false, error: 'Public key and password required' });
    }

    // Validate public key format
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const success = await managerFor(req).loginToNode(publicKey, password);

    if (success) {
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.status(401).json({ success: false, error: 'Login failed' });
    }
  } catch (error) {
    logger.error('[API] Error logging in:', error);
    res.status(500).json({ success: false, error: 'Login error' });
  }
});

/**
 * GET /api/meshcore/admin/status/:publicKey
 * Get status from a remote node (requires prior login)
 * Requires authentication - queries remote node
 */
router.get('/admin/status/:publicKey', requireAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    // Validate public key format
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const status = await managerFor(req).requestNodeStatus(publicKey);

    if (status) {
      res.json({ success: true, data: status });
    } else {
      res.status(404).json({ success: false, error: 'No status received' });
    }
  } catch (error) {
    logger.error('[API] Error getting node status:', error);
    res.status(500).json({ success: false, error: 'Status error' });
  }
});

/**
 * POST /api/meshcore/config/name
 * Set device name
 * Requires authentication - modifies device configuration
 */
router.post('/config/name', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    // Validate name
    const nameValidation = isValidName(name);
    if (!nameValidation.valid) {
      return res.status(400).json({ success: false, error: nameValidation.error });
    }

    const success = await managerFor(req).setName(name.trim());

    if (success) {
      res.json({ success: true, message: 'Name updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update name' });
    }
  } catch (error) {
    logger.error('[API] Error setting name:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/radio
 * Set radio parameters
 * Requires authentication - modifies device radio configuration
 */
router.post('/config/radio', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { freq, bw, sf, cr } = req.body;

    if (freq === undefined || bw === undefined || sf === undefined || cr === undefined) {
      return res.status(400).json({ success: false, error: 'All radio parameters required (freq, bw, sf, cr)' });
    }

    // Parse and validate radio parameters
    const parsedFreq = parseFloat(freq);
    const parsedBw = parseFloat(bw);
    const parsedSf = parseInt(sf, 10);
    const parsedCr = parseInt(cr, 10);

    if (isNaN(parsedFreq) || isNaN(parsedBw) || isNaN(parsedSf) || isNaN(parsedCr)) {
      return res.status(400).json({ success: false, error: 'Radio parameters must be valid numbers' });
    }

    const radioValidation = isValidRadioParams(parsedFreq, parsedBw, parsedSf, parsedCr);
    if (!radioValidation.valid) {
      return res.status(400).json({ success: false, error: radioValidation.error });
    }

    const success = await managerFor(req).setRadio(parsedFreq, parsedBw, parsedSf, parsedCr);

    if (success) {
      res.json({ success: true, message: 'Radio config updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update radio config' });
    }
  } catch (error) {
    logger.error('[API] Error setting radio config:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/coords
 * Set device GPS coordinates (companion only)
 * Requires authentication - modifies device configuration
 */
router.post('/config/coords', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { lat, lon } = req.body;

    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ success: false, error: 'Both lat and lon are required' });
    }

    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
      return res.status(400).json({ success: false, error: 'lat and lon must be valid numbers' });
    }

    if (parsedLat < -90 || parsedLat > 90) {
      return res.status(400).json({ success: false, error: 'lat must be between -90 and 90' });
    }
    if (parsedLon < -180 || parsedLon > 180) {
      return res.status(400).json({ success: false, error: 'lon must be between -180 and 180' });
    }

    const success = await managerFor(req).setCoords(parsedLat, parsedLon);

    if (success) {
      res.json({ success: true, message: 'Coordinates updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update coordinates' });
    }
  } catch (error) {
    logger.error('[API] Error setting coords:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/advert-loc-policy
 * Set advert location policy (companion only)
 * Requires authentication - modifies device configuration
 */
router.post('/config/advert-loc-policy', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { policy } = req.body;

    if (policy === undefined) {
      return res.status(400).json({ success: false, error: 'policy is required' });
    }

    const parsedPolicy = parseInt(policy, 10);

    if (parsedPolicy !== 0 && parsedPolicy !== 1) {
      return res.status(400).json({ success: false, error: 'policy must be 0 or 1' });
    }

    const success = await managerFor(req).setAdvertLocPolicy(parsedPolicy);

    if (success) {
      res.json({ success: true, message: 'Advert location policy updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update advert location policy' });
    }
  } catch (error) {
    logger.error('[API] Error setting advert loc policy:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

const TELEMETRY_MODES = ['always', 'device', 'never'] as const;
type TelemetryModeReq = typeof TELEMETRY_MODES[number];

function isTelemetryMode(value: unknown): value is TelemetryModeReq {
  return typeof value === 'string' && (TELEMETRY_MODES as readonly string[]).includes(value);
}

/**
 * POST /api/meshcore/config/telemetry-mode-base
 * Set basic telemetry sharing mode (companion only).
 * Body: { mode: 'always' | 'device' | 'never' }
 */
router.post('/config/telemetry-mode-base', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (!isTelemetryMode(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be always|device|never' });
    }
    const success = await managerFor(req).setTelemetryModeBase(mode);
    if (success) {
      res.json({ success: true, message: 'Basic telemetry mode updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update basic telemetry mode' });
    }
  } catch (error) {
    logger.error('[API] Error setting telemetry mode (base):', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/telemetry-mode-loc
 * Set location telemetry sharing mode (companion only).
 * Body: { mode: 'always' | 'device' | 'never' }
 */
router.post('/config/telemetry-mode-loc', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (!isTelemetryMode(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be always|device|never' });
    }
    const success = await managerFor(req).setTelemetryModeLoc(mode);
    if (success) {
      res.json({ success: true, message: 'Location telemetry mode updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update location telemetry mode' });
    }
  } catch (error) {
    logger.error('[API] Error setting telemetry mode (loc):', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/telemetry-mode-env
 * Set environment telemetry sharing mode (companion only).
 * Body: { mode: 'always' | 'device' | 'never' }
 */
router.post('/config/telemetry-mode-env', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (!isTelemetryMode(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be always|device|never' });
    }
    const success = await managerFor(req).setTelemetryModeEnv(mode);
    if (success) {
      res.json({ success: true, message: 'Environment telemetry mode updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update environment telemetry mode' });
    }
  } catch (error) {
    logger.error('[API] Error setting telemetry mode (env):', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * GET /api/sources/:id/meshcore/nodes/:publicKey/telemetry-config
 *
 * Read the per-node remote-telemetry-retrieval config for a specific
 * mesh node. Returns the persisted (telemetryEnabled,
 * telemetryIntervalMinutes, lastTelemetryRequestAt) triple, or
 * defaults (`enabled: false, intervalMinutes: 60, lastRequestAt: null`)
 * if the node has never been written.
 */
router.get(
  '/nodes/:publicKey/telemetry-config',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
      }
      const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);
      res.json({
        success: true,
        data: {
          publicKey,
          sourceId,
          enabled: Boolean(node?.telemetryEnabled),
          intervalMinutes: node?.telemetryIntervalMinutes ?? 60,
          lastRequestAt: node?.lastTelemetryRequestAt ?? null,
        },
      });
    } catch (error) {
      logger.error('[API] Error getting per-node telemetry-config:', error);
      res.status(500).json({ success: false, error: 'Failed to read telemetry-config' });
    }
  },
);

/**
 * PATCH /api/sources/:id/meshcore/nodes/:publicKey/telemetry-config
 *
 * Update the per-node remote-telemetry-retrieval config. Body:
 *   { enabled?: boolean, intervalMinutes?: number }
 *
 * Gated by `configuration:write` per the PR #3019 pattern for any
 * MeshCore control that mutates source-bound state.
 */
router.patch(
  '/nodes/:publicKey/telemetry-config',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
      }

      const { enabled, intervalMinutes } = req.body ?? {};

      const patch: { enabled?: boolean; intervalMinutes?: number } = {};
      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
        }
        patch.enabled = enabled;
      }
      if (intervalMinutes !== undefined) {
        const n = Number(intervalMinutes);
        if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_MINUTES) {
          return res.status(400).json({
            success: false,
            error: `intervalMinutes must be an integer between 1 and ${MAX_INTERVAL_MINUTES}`,
          });
        }
        patch.intervalMinutes = n;
      }
      if (patch.enabled === undefined && patch.intervalMinutes === undefined) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
      }

      await databaseService.meshcore.setNodeTelemetryConfig(sourceId, publicKey, patch);
      const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);
      res.json({
        success: true,
        data: {
          publicKey,
          sourceId,
          enabled: Boolean(node?.telemetryEnabled),
          intervalMinutes: node?.telemetryIntervalMinutes ?? 60,
          lastRequestAt: node?.lastTelemetryRequestAt ?? null,
        },
      });
    } catch (error) {
      logger.error('[API] Error setting per-node telemetry-config:', error);
      res.status(500).json({ success: false, error: 'Failed to update telemetry-config' });
    }
  },
);

export default router;
