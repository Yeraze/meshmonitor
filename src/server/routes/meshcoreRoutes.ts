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
import meshcoreManager, { ConnectionType, MeshCoreDeviceType } from '../meshcoreManager.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter, messageLimiter } from '../middleware/rateLimiters.js';

const router = Router();

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
router.get('/status', optionalAuth(), requirePermission('meshcore', 'read'), async (_req: Request, res: Response) => {
  try {
    const status = meshcoreManager.getConnectionStatus();
    const localNode = meshcoreManager.getLocalNode();

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
router.post('/connect', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (req: Request, res: Response) => {
  try {
    const { connectionType, serialPort, tcpHost, tcpPort, baudRate } = req.body;

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

    const config = {
      connectionType: connectionType as ConnectionType || ConnectionType.SERIAL,
      serialPort,
      tcpHost,
      tcpPort: parsedTcpPort ?? 4403,
      baudRate: parsedBaudRate ?? 115200,
    };

    const success = await meshcoreManager.connect(config);

    if (success) {
      res.json({
        success: true,
        message: 'Connected successfully',
        data: {
          localNode: meshcoreManager.getLocalNode(),
          deviceType: MeshCoreDeviceType[meshcoreManager.getConnectionStatus().deviceType],
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
router.post('/disconnect', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (_req: Request, res: Response) => {
  try {
    await meshcoreManager.disconnect();
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
router.get('/nodes', optionalAuth(), requirePermission('meshcore', 'read'), async (_req: Request, res: Response) => {
  try {
    const nodes = meshcoreManager.getAllNodes();
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
router.get('/contacts', optionalAuth(), requirePermission('meshcore', 'read'), async (_req: Request, res: Response) => {
  try {
    const contacts = meshcoreManager.getContacts();
    const localNode = meshcoreManager.getLocalNode();

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
router.post('/contacts/refresh', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (_req: Request, res: Response) => {
  try {
    const contacts = await meshcoreManager.refreshContacts();
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
 * Get recent messages
 */
router.get('/messages', optionalAuth(), requirePermission('meshcore', 'read'), async (req: Request, res: Response) => {
  try {
    let limit = parseInt(req.query.limit as string || '50', 10);
    // Validate and clamp limit to reasonable bounds
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    } else if (limit > VALIDATION.MAX_MESSAGE_LIMIT) {
      limit = VALIDATION.MAX_MESSAGE_LIMIT;
    }
    const messages = meshcoreManager.getRecentMessages(limit);
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
 * POST /api/meshcore/messages/send
 * Send a message
 * Requires authentication - sends data over mesh network
 */
router.post('/messages/send', messageLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (req: Request, res: Response) => {
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

    const success = await meshcoreManager.sendMessage(text, toPublicKey);

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
router.post('/advert', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (_req: Request, res: Response) => {
  try {
    const success = await meshcoreManager.sendAdvert();

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
router.post('/admin/login', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (req: Request, res: Response) => {
  try {
    const { publicKey, password } = req.body;

    if (!publicKey || !password) {
      return res.status(400).json({ success: false, error: 'Public key and password required' });
    }

    // Validate public key format
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const success = await meshcoreManager.loginToNode(publicKey, password);

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
router.get('/admin/status/:publicKey', requireAuth(), requirePermission('meshcore', 'read'), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    // Validate public key format
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const status = await meshcoreManager.requestNodeStatus(publicKey);

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
router.post('/config/name', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    // Validate name
    const nameValidation = isValidName(name);
    if (!nameValidation.valid) {
      return res.status(400).json({ success: false, error: nameValidation.error });
    }

    const success = await meshcoreManager.setName(name.trim());

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
router.post('/config/radio', meshcoreDeviceLimiter, requireAuth(), requirePermission('meshcore', 'write'), async (req: Request, res: Response) => {
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

    const success = await meshcoreManager.setRadio(parsedFreq, parsedBw, parsedSf, parsedCr);

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

export default router;
