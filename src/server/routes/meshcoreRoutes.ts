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
import { getMeshCoreCredentialStore } from '../services/meshcoreCredentialStore.js';

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
 * Destructive MeshCore CLI commands. Requests targeting any matching
 * command must carry `confirm: true` in the body or the /admin/cli route
 * rejects with DANGER_CONFIRM_REQUIRED. Keep in sync with the matching
 * pattern in MeshCoreRemoteConsole.tsx so the client knows which commands
 * to route through its typed-name confirmation modal.
 */
const DANGER_COMMAND_PATTERN = /(reboot|erase|clkreboot|factory)/i;

/**
 * Validation helper functions
 */
function isValidPublicKey(key: string | undefined): boolean {
  if (!key || typeof key !== 'string') return false;
  return /^[0-9a-fA-F]{64}$/.test(key);
}

/**
 * Fire-and-forget audit log helper for MeshCore admin / CLI routes.
 *
 * Matches the project's existing auditLogAsync usage: userId may be null
 * for anonymous, `action` is a verb naming the operation, `resource` is
 * one of the permission resources, and `details` is a JSON-serialized
 * object with whatever's relevant.
 *
 * **NEVER pass a password (or any decrypted credential) in `details`.**
 * The login routes call this only after stripping `password`,
 * `rememberPassword`, and the decrypted plaintext from the body.
 *
 * Errors from the audit write itself are swallowed — losing a single
 * audit row is preferable to failing the request the user cares about.
 */
function auditMeshcoreEvent(
  req: Request,
  action: string,
  resource: 'remote_admin' | 'configuration',
  details: Record<string, unknown>,
): void {
  const userId = req.session?.userId ?? null;
  const ip = req.ip || req.socket?.remoteAddress || null;
  databaseService
    .auditLogAsync(userId, action, resource, JSON.stringify(details), ip)
    .catch((err) => logger.error('[API] audit write failed:', err));
}

/**
 * Parse a comma-separated hex chain like "a3,7f,02" into a Uint8Array.
 * Empty string parses to a zero-length array (zero-hop direct path).
 * Returns null on any malformed token so the route can return a 400.
 */
function parseHexPathChain(input: string): Uint8Array | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return new Uint8Array(0);
  const parts = trimmed.split(',');
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i].trim();
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) return null;
    const n = parseInt(tok, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xff) return null;
    out[i] = n;
  }
  return out;
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
      tcpPort: parsedTcpPort ?? 5000,
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
 * POST /api/sources/:id/meshcore/contacts/:publicKey/reset-path
 *
 * Clear the cached forwarding route ("out_path") for a contact on the
 * device, so the next send re-discovers the route via flooding. Wraps
 * the firmware's CMD_RESET_PATH (companion protocol opcode 13).
 *
 * On success, MeshMonitor mirrors the device state by clearing the row's
 * out_path / path_len columns so the UI reflects the change immediately.
 */
router.post(
  '/contacts/:publicKey/reset-path',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex',
        });
      }
      const ok = await managerFor(req).resetContactPath(publicKey);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Reset path failed — contact may be unknown, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error resetting contact path:', error);
      res.status(500).json({ success: false, error: 'Failed to reset path' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/contacts/:publicKey/trace-path
 *
 * Send a diagnostic trace along the contact's cached forwarding path,
 * collecting per-hop SNR. Requires a known out_path (pathLen > 0).
 * Returns { success, hops: [{ index, snr }], lastSnr }.
 */
router.post(
  '/contacts/:publicKey/trace-path',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex',
        });
      }
      const result = await managerFor(req).traceContactPath(publicKey);
      if (!result) {
        return res.status(409).json({
          success: false,
          error: 'Trace path failed — contact may have no known path, source disconnected, timed out, or not a Companion device',
        });
      }
      res.json({ success: true, hops: result.hops, lastSnr: result.lastSnr });
    } catch (error) {
      logger.error('[API] Error tracing contact path:', error);
      res.status(500).json({ success: false, error: 'Failed to trace path' });
    }
  },
);

/**
 * PUT /api/sources/:id/meshcore/contacts/:publicKey/out-path
 *
 * Manually set the cached forwarding route ("out_path") for a contact.
 * Wraps the firmware's CMD_ADD_UPDATE_CONTACT (companion protocol
 * opcode 9), with the non-path fields preserved verbatim by
 * meshcore.js's setContactPath helper.
 *
 * Gated by the `meshcoreAdvancedPathEdit` setting because stale hops
 * silently drop direct sends to this contact. When the toggle is off
 * (default), the route returns 403 even for users with nodes:write.
 *
 * Body: { outPath: "a3,7f,02" }  — comma-separated hex chain, 0..64
 *                                   bytes (empty string = 0 hops).
 */
router.put(
  '/contacts/:publicKey/out-path',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex',
        });
      }
      // Settings are stored as string values; the boolean check is here
      // only for robustness against future schema changes.
      const flagRaw: unknown = await databaseService.settings.getSetting('meshcoreAdvancedPathEdit');
      const flagEnabled = flagRaw === 'true' || flagRaw === '1' || flagRaw === true;
      if (!flagEnabled) {
        return res.status(403).json({
          success: false,
          error: 'Advanced MeshCore path editing is disabled. Enable meshcoreAdvancedPathEdit in Settings to use this endpoint.',
        });
      }
      const rawPath = (req.body ?? {}).outPath;
      if (typeof rawPath !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Body must include `outPath` as a comma-separated hex string',
        });
      }
      const parsed = parseHexPathChain(rawPath);
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: 'Invalid outPath — expected comma-separated hex bytes, e.g. "a3,7f,02"',
        });
      }
      if (parsed.length > 64) {
        return res.status(400).json({
          success: false,
          error: `outPath too long: ${parsed.length} bytes (max 64)`,
        });
      }
      const ok = await managerFor(req).setContactOutPath(publicKey, parsed);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Set out_path failed — contact may be unknown, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error setting contact out_path:', error);
      res.status(500).json({ success: false, error: 'Failed to set out_path' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/contacts/:publicKey/share
 *
 * Broadcast the contact's saved advert as a zero-hop frame so nearby nodes
 * can pick it up and add it themselves. Wraps the firmware's
 * CMD_SHARE_CONTACT (companion protocol opcode 16). The device only
 * retransmits the stored advert; no local state mutates.
 */
router.post(
  '/contacts/:publicKey/share',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex',
        });
      }
      const ok = await managerFor(req).shareContact(publicKey);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Share contact failed — contact may be unknown, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true, broadcast: true });
    } catch (error) {
      logger.error('[API] Error sharing contact:', error);
      res.status(500).json({ success: false, error: 'Failed to share contact' });
    }
  },
);

/**
 * DELETE /api/sources/:id/meshcore/contacts/:publicKey
 *
 * Remove a contact from the device's contact list. Deletes the in-memory
 * entry, the meshcore_nodes DB row, and fires a contact-updated push so
 * the UI removes the row without a full refresh.
 */
router.delete(
  '/contacts/:publicKey',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex',
        });
      }
      const ok = await managerFor(req).removeContact(publicKey);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Remove contact failed — contact may be unknown, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error removing contact:', error);
      res.status(500).json({ success: false, error: 'Failed to remove contact' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/contacts/:publicKey/export
 *
 * Export a contact as a signed advert blob suitable for sharing via
 * QR code, NFC, or meshcore:// URL. Returns the raw bytes as a JSON
 * number array. Omit :publicKey (use 'self') to export the local node.
 */
router.get(
  '/contacts/:publicKey/export',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      const isSelf = publicKey === 'self';
      if (!isSelf && !isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex or "self"',
        });
      }
      const bytes = await managerFor(req).exportContact(isSelf ? null : publicKey);
      if (!bytes) {
        return res.status(409).json({
          success: false,
          error: 'Export contact failed — contact may be unknown, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true, data: { advertBytes: bytes } });
    } catch (error) {
      logger.error('[API] Error exporting contact:', error);
      res.status(500).json({ success: false, error: 'Failed to export contact' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/contacts/import
 *
 * Import a contact from a signed advert blob. Refreshes contacts on
 * success. Body: { advertBytes: number[] }
 */
router.post(
  '/contacts/import',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const advertBytes = (req.body ?? {}).advertBytes;
      if (!Array.isArray(advertBytes) || advertBytes.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Body must include advertBytes as a non-empty number array',
        });
      }
      if (advertBytes.some((b: unknown) => typeof b !== 'number' || b < 0 || b > 255)) {
        return res.status(400).json({
          success: false,
          error: 'advertBytes must contain only integers 0-255',
        });
      }
      const ok = await managerFor(req).importContact(advertBytes);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Import contact failed — may be invalid advert data, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error importing contact:', error);
      res.status(500).json({ success: false, error: 'Failed to import contact' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/contacts/:publicKey/neighbours
 *
 * Query the neighbour list from a remote repeater node. Returns an array
 * of { publicKeyPrefix, heardSecondsAgo, snr } entries. Requires the
 * target to be a repeater running firmware v1.9.0+.
 *
 * Query params: count (default 10), offset (default 0),
 *   orderBy (0=newest, 1=oldest, 2=strongest, 3=weakest)
 */
router.get(
  '/contacts/:publicKey/neighbours',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid public key — must be 64-char hex',
        });
      }
      const count = Math.min(Math.max(parseInt(req.query.count as string || '10', 10) || 10, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string || '0', 10) || 0, 0);
      const orderBy = Math.min(Math.max(parseInt(req.query.orderBy as string || '0', 10) || 0, 0), 3);
      const result = await managerFor(req).getNeighbours(publicKey, { count, offset, orderBy });
      if (!result) {
        return res.status(409).json({
          success: false,
          error: 'Get neighbours failed — source disconnected, not a Companion, or firmware too old',
        });
      }
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[API] Error getting neighbours:', error);
      res.status(500).json({ success: false, error: 'Failed to get neighbours' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/sync-time
 *
 * Sync the device's RTC to the server's current time. Companion only.
 */
router.post(
  '/config/sync-time',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const ok = await managerFor(req).syncDeviceTime();
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Sync time failed — source disconnected or not a Companion device',
        });
      }
      res.json({ success: true, message: 'Device time synced' });
    } catch (error) {
      logger.error('[API] Error syncing device time:', error);
      res.status(500).json({ success: false, error: 'Failed to sync time' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/reboot
 *
 * Reboot the locally connected device. Destructive — requires confirm:true.
 * The device will disconnect and restart; the source will need to reconnect.
 */
router.post(
  '/config/reboot',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const { confirm } = req.body as { confirm?: boolean };
      if (confirm !== true) {
        return res.status(400).json({
          success: false,
          error: 'Reboot requires confirm:true in the request body',
          code: 'DANGER_CONFIRM_REQUIRED',
        });
      }
      const ok = await managerFor(req).rebootDevice();
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Reboot failed — source disconnected or not a Companion device',
        });
      }
      auditMeshcoreEvent(req, 'meshcore_reboot', 'configuration', {
        sourceId: req.params.id,
      });
      res.json({ success: true, message: 'Reboot command sent' });
    } catch (error) {
      logger.error('[API] Error rebooting device:', error);
      res.status(500).json({ success: false, error: 'Failed to reboot' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/config/private-key
 *
 * Export the device's Ed25519 private key for backup. Returns the hex
 * string. SECURITY-SENSITIVE — gated on configuration:write.
 */
router.get(
  '/config/private-key',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const hex = await managerFor(req).exportPrivateKey();
      if (!hex) {
        return res.status(409).json({
          success: false,
          error: 'Export private key failed — source disconnected or not a Companion device',
        });
      }
      auditMeshcoreEvent(req, 'meshcore_export_private_key', 'configuration', {
        sourceId: req.params.id,
      });
      res.json({ success: true, data: { privateKey: hex } });
    } catch (error) {
      logger.error('[API] Error exporting private key:', error);
      res.status(500).json({ success: false, error: 'Failed to export private key' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/private-key
 *
 * Import an Ed25519 private key onto the device. Replaces the device
 * identity. DESTRUCTIVE + SECURITY-SENSITIVE — requires confirm:true.
 * Body: { privateKey: string (64-char hex), confirm: true }
 */
router.post(
  '/config/private-key',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const { privateKey, confirm } = req.body as { privateKey?: string; confirm?: boolean };
      if (confirm !== true) {
        return res.status(400).json({
          success: false,
          error: 'Import private key requires confirm:true — this replaces the device identity',
          code: 'DANGER_CONFIRM_REQUIRED',
        });
      }
      if (typeof privateKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(privateKey)) {
        return res.status(400).json({
          success: false,
          error: 'privateKey must be a 64-character hex string',
        });
      }
      const ok = await managerFor(req).importPrivateKey(privateKey);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Import private key failed — source disconnected or not a Companion device',
        });
      }
      auditMeshcoreEvent(req, 'meshcore_import_private_key', 'configuration', {
        sourceId: req.params.id,
      });
      res.json({ success: true, message: 'Private key imported — device identity changed' });
    } catch (error) {
      logger.error('[API] Error importing private key:', error);
      res.status(500).json({ success: false, error: 'Failed to import private key' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/stats/:type
 *
 * Read local-node stats (core, radio, or packets). These hit the directly-
 * connected companion node over the local link — no RF transmission.
 */
router.get(
  '/stats/:type',
  optionalAuth(),
  requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const manager = managerFor(req);
      const type = req.params.type;
      let data: any = null;
      if (type === 'core') data = await manager.getStatsCore();
      else if (type === 'radio') data = await manager.getStatsRadio();
      else if (type === 'packets') data = await manager.getStatsPackets();
      else {
        return res.status(400).json({ success: false, error: 'type must be core, radio, or packets' });
      }
      if (!data) {
        return res.status(409).json({ success: false, error: 'Stats unavailable — source disconnected or not a Companion' });
      }
      res.json({ success: true, data });
    } catch (error) {
      logger.error('[API] Error getting stats:', error);
      res.status(500).json({ success: false, error: 'Failed to get stats' });
    }
  },
);

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
    const { text, toPublicKey, channelIdx } = req.body;

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

    // Validate optional channelIdx (broadcast on a specific channel).
    let parsedChannelIdx: number | undefined;
    if (channelIdx !== undefined && channelIdx !== null) {
      const n = Number(channelIdx);
      if (!Number.isInteger(n) || n < 0 || n > 255) {
        return res.status(400).json({ success: false, error: 'channelIdx must be an integer between 0 and 255' });
      }
      parsedChannelIdx = n;
    }

    const success = await managerFor(req).sendMessage(text, toPublicKey, parsedChannelIdx);

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
 * Log into a remote node for admin access.
 *
 * Body: { publicKey: string, password: string, rememberPassword?: boolean }
 *   - `password` may be empty for guest login.
 *   - `rememberPassword: true` persists the password (AES-256-GCM, see
 *     MeshCoreCredentialStore). Rejected with 400 when SESSION_SECRET was
 *     auto-generated — check GET /admin/credentials-capability first.
 *
 * Gated on `remote_admin:write` per-source. (Pre-4.7 versions used
 * `configuration:write`; remote_admin was split out so operators can grant
 * one without the other.)
 */
router.post('/admin/login', meshcoreDeviceLimiter, requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, password, rememberPassword } = req.body as {
      publicKey?: string;
      password?: string;
      rememberPassword?: boolean;
    };

    if (typeof publicKey !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'publicKey and password (string) required; password may be empty for guest login' });
    }

    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }

    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();

    if (rememberPassword && !store.capability.canRemember) {
      return res.status(400).json({
        success: false,
        error: 'Saving credentials is disabled',
        reason: store.capability.reason,
        code: 'CREDENTIAL_PERSISTENCE_DISABLED',
      });
    }

    const success = await managerFor(req).loginToNode(publicKey, password);
    if (!success) {
      auditMeshcoreEvent(req, 'meshcore_remote_login_failed', 'remote_admin', {
        sourceId,
        publicKey,
      });
      return res.status(401).json({ success: false, error: 'Login failed' });
    }

    if (rememberPassword) {
      try {
        await store.store(sourceId, publicKey, password);
      } catch (err) {
        logger.warn('[API] Login succeeded but credential persistence failed:', err);
        auditMeshcoreEvent(req, 'meshcore_remote_login', 'remote_admin', {
          sourceId,
          publicKey,
          persisted: false,
          persistenceError: err instanceof Error ? err.message : String(err),
        });
        return res.json({
          success: true,
          message: 'Login successful, but saving the password failed',
          persisted: false,
        });
      }
      auditMeshcoreEvent(req, 'meshcore_remote_login', 'remote_admin', {
        sourceId,
        publicKey,
        persisted: true,
      });
      return res.json({ success: true, message: 'Login successful', persisted: true });
    }

    auditMeshcoreEvent(req, 'meshcore_remote_login', 'remote_admin', {
      sourceId,
      publicKey,
      persisted: false,
    });
    res.json({ success: true, message: 'Login successful', persisted: false });
  } catch (error) {
    logger.error('[API] Error logging in:', error);
    res.status(500).json({ success: false, error: 'Login error' });
  }
});

// ============ Room Server Endpoints ============

/**
 * GET /api/meshcore/rooms/servers
 * List discovered room servers (advType=3) with login state.
 */
router.get('/rooms/servers', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req);
    const rooms = manager.getRoomServers();
    const result = rooms.map(r => ({
      publicKey: r.publicKey,
      advName: r.advName,
      name: r.name,
      lastSeen: r.lastSeen,
      rssi: r.rssi,
      snr: r.snr,
      loggedIn: manager.isRoomLoggedIn(r.publicKey),
    }));
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[API] Error listing room servers:', error);
    res.status(500).json({ success: false, error: 'Failed to list room servers' });
  }
});

/**
 * POST /api/meshcore/rooms/login
 * Login to a room server to receive posts and (if permitted) submit new ones.
 * Body: { publicKey: string, password: string, rememberPassword?: boolean }
 *   - `password` may be empty for guest/read-only access.
 *   - `rememberPassword: true` persists the password (AES-256-GCM via credential store).
 */
router.post('/rooms/login', meshcoreDeviceLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, password, rememberPassword } = req.body as {
      publicKey?: string;
      password?: string;
      rememberPassword?: boolean;
    };

    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    if (typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'password (string) required; may be empty for guest login' });
    }

    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();

    if (rememberPassword && !store.capability.canRemember) {
      return res.status(400).json({
        success: false,
        error: 'Saving credentials is disabled',
        reason: store.capability.reason,
        code: 'CREDENTIAL_PERSISTENCE_DISABLED',
      });
    }

    const success = await managerFor(req).loginToRoom(publicKey, password);
    if (!success) {
      return res.status(401).json({ success: false, error: 'Room login failed' });
    }

    if (rememberPassword) {
      try {
        await store.storeRoom(sourceId, publicKey, password);
      } catch (err) {
        logger.warn('[API] Room login succeeded but credential persistence failed:', err);
        return res.json({ success: true, message: 'Room login successful, but saving the password failed', persisted: false });
      }
      return res.json({ success: true, message: 'Room login successful', persisted: true });
    }

    res.json({ success: true, message: 'Room login successful', persisted: false });
  } catch (error) {
    logger.error('[API] Error logging into room:', error);
    res.status(500).json({ success: false, error: 'Room login error' });
  }
});

/**
 * POST /api/meshcore/rooms/login-with-saved
 * Login to a room server using a previously saved credential.
 * Body: { publicKey: string }
 */
router.post('/rooms/login-with-saved', meshcoreDeviceLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.body as { publicKey?: string };
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format' });
    }

    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const result = await store.loadRoom(sourceId, publicKey);

    if (result.kind === 'none') {
      return res.status(404).json({ success: false, error: 'No saved room credential', code: 'NO_STORED_CREDENTIAL' });
    }
    if (result.kind === 'key_rotated') {
      return res.status(409).json({ success: false, error: 'Saved credential was encrypted with a different key', code: 'CREDENTIAL_KEY_ROTATED' });
    }

    const success = await managerFor(req).loginToRoom(publicKey, result.password);
    if (!success) {
      return res.status(401).json({ success: false, error: 'Saved credential rejected by room server', code: 'STORED_CREDENTIAL_REJECTED' });
    }
    res.json({ success: true, usedStored: true });
  } catch (error) {
    logger.error('[API] Error logging into room with saved credential:', error);
    res.status(500).json({ success: false, error: 'Room login error' });
  }
});

/**
 * GET /api/meshcore/rooms/credentials
 * List room servers with saved credentials for this source.
 */
router.get('/rooms/credentials', requireAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const stored = await store.listStoredRoom(sourceId);
    res.json({
      success: true,
      canRemember: store.capability.canRemember,
      reason: store.capability.reason,
      stored,
    });
  } catch (error) {
    logger.error('[API] Error listing room credentials:', error);
    res.status(500).json({ success: false, error: 'Failed to list room credentials' });
  }
});

/**
 * POST /api/meshcore/rooms/post
 * Send a text post to a room server.
 * Body: { roomPublicKey: string, text: string }
 */
router.post('/rooms/post', messageLimiter, requireAuth(), requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { roomPublicKey, text } = req.body as {
      roomPublicKey?: string;
      text?: string;
    };

    if (typeof roomPublicKey !== 'string' || !isValidPublicKey(roomPublicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid roomPublicKey format (expected 64-character hex string)' });
    }
    const textValidation = isValidMessage(text);
    if (!textValidation.valid) {
      return res.status(400).json({ success: false, error: textValidation.error });
    }

    const success = await managerFor(req).sendRoomPost(text!, roomPublicKey);
    if (success) {
      res.json({ success: true, message: 'Room post sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send room post' });
    }
  } catch (error) {
    logger.error('[API] Error sending room post:', error);
    res.status(500).json({ success: false, error: 'Room post error' });
  }
});

/**
 * PATCH /api/meshcore/rooms/sync-config
 * Configure periodic room sync for a room server.
 * Body: { publicKey: string, enabled: boolean, intervalMinutes?: number }
 *   - `intervalMinutes` must be >= 60. Defaults to 60.
 */
router.patch('/rooms/sync-config', requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, enabled, intervalMinutes } = req.body as {
      publicKey?: string;
      enabled?: boolean;
      intervalMinutes?: number;
    };
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled (boolean) required' });
    }
    const interval = intervalMinutes ?? 60;
    if (!Number.isInteger(interval) || interval < 60 || interval > 1440) {
      return res.status(400).json({ success: false, error: 'intervalMinutes must be 60-1440' });
    }

    const sourceId = req.params.id!;
    await databaseService.meshcore.setRoomSyncConfig(sourceId, publicKey, {
      roomSyncEnabled: enabled,
      roomSyncIntervalMinutes: interval,
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('[API] Error setting room sync config:', error);
    res.status(500).json({ success: false, error: 'Failed to set room sync config' });
  }
});

/**
 * POST /api/meshcore/admin/cli
 * Send a CLI command to a remote MeshCore node and await its single-packet
 * reply. Body: { publicKey: string, command: string, timeoutMs?: number }.
 *
 * Returns 504 on timeout (no reply within the window — may indicate stale
 * path, ACL eviction, or the remote being offline). Returns 502 when the
 * underlying bridge rejected the send.
 */
router.post('/admin/cli', meshcoreDeviceLimiter, requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey, command, timeoutMs, confirm } = req.body as {
      publicKey?: string;
      command?: string;
      timeoutMs?: number;
      confirm?: boolean;
    };

    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'command must be a non-empty string' });
    }
    if (command.length > 230) {
      // LoRa packet MTU ceiling — anything larger will be truncated by the
      // firmware. Reject up front so the user gets a clear error.
      return res.status(400).json({ success: false, error: 'command too long (max 230 bytes)' });
    }
    // Defense-in-depth danger guard. The frontend opens a typed-name
    // confirmation modal for these commands, but server-side enforcement
    // means scripts and direct API calls cannot bypass the prompt by
    // simply not rendering it. Keep the pattern in sync with the
    // client-side DANGER_COMMAND_PATTERN in MeshCoreRemoteConsole.tsx.
    if (DANGER_COMMAND_PATTERN.test(command) && confirm !== true) {
      auditMeshcoreEvent(req, 'meshcore_remote_cli_blocked', 'remote_admin', {
        sourceId: req.params.id,
        publicKey,
        command,
        reason: 'DANGER_CONFIRM_REQUIRED',
      });
      return res.status(400).json({
        success: false,
        error: 'Destructive command requires confirm:true in the request body',
        code: 'DANGER_CONFIRM_REQUIRED',
      });
    }
    const effectiveTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000
        ? timeoutMs
        : undefined;

    try {
      const result = await managerFor(req).sendCliCommand(publicKey, command, {
        timeoutMs: effectiveTimeout,
      });
      auditMeshcoreEvent(req, 'meshcore_remote_cli', 'remote_admin', {
        sourceId: req.params.id,
        publicKey,
        command,
        confirm: confirm === true,
        replyChars: result.reply?.length ?? 0,
        elapsedMs: result.elapsedMs,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditMeshcoreEvent(req, 'meshcore_remote_cli_failed', 'remote_admin', {
        sourceId: req.params.id,
        publicKey,
        command,
        error: msg,
      });
      if (/timed out/i.test(msg)) {
        return res.status(504).json({ success: false, error: msg, code: 'CLI_TIMEOUT' });
      }
      if (/Companion firmware|not connected|Contact not found/i.test(msg)) {
        return res.status(400).json({ success: false, error: msg });
      }
      logger.error('[API] CLI command failed:', err);
      res.status(502).json({ success: false, error: msg });
    }
  } catch (error) {
    logger.error('[API] Unexpected error in /admin/cli:', error);
    res.status(500).json({ success: false, error: 'CLI error' });
  }
});

/**
 * POST /api/meshcore/cli
 *
 * Send a CLI command to the LOCALLY connected MeshCore node. Returns the
 * device's response text.
 *
 * Body: { command: string, confirm?: boolean, timeoutMs?: number }
 *
 * Dispatch depends on the local firmware (see
 * `MeshCoreManager.sendLocalCliCommand`):
 *   - Repeater / Room Server: forwarded to the device's native text CLI
 *     over serial.
 *   - Companion: handled by a small synthetic-CLI interpreter that
 *     covers ver / stats / clock / advert / help. Unknown commands
 *     return a usage hint.
 *
 * Reuses the same `DANGER_COMMAND_PATTERN` guard as the remote /admin/cli
 * route — destructive verbs (reboot / erase / clkreboot / factory)
 * require `confirm: true`.
 *
 * Gated on `configuration:write` per-source — matches the existing
 * local-device config routes (`/config/name`, `/config/radio`, etc.).
 */
router.post('/cli', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { command, confirm, timeoutMs } = req.body as {
      command?: string;
      confirm?: boolean;
      timeoutMs?: number;
    };

    if (typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'command must be a non-empty string' });
    }
    if (command.length > 230) {
      return res.status(400).json({ success: false, error: 'command too long (max 230 bytes)' });
    }
    if (DANGER_COMMAND_PATTERN.test(command) && confirm !== true) {
      auditMeshcoreEvent(req, 'meshcore_local_cli_blocked', 'configuration', {
        sourceId: req.params.id,
        command,
        reason: 'DANGER_CONFIRM_REQUIRED',
      });
      return res.status(400).json({
        success: false,
        error: 'Destructive command requires confirm:true in the request body',
        code: 'DANGER_CONFIRM_REQUIRED',
      });
    }
    const effectiveTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000
        ? timeoutMs
        : undefined;

    try {
      const result = await managerFor(req).sendLocalCliCommand(command, {
        timeoutMs: effectiveTimeout,
      });
      auditMeshcoreEvent(req, 'meshcore_local_cli', 'configuration', {
        sourceId: req.params.id,
        command,
        confirm: confirm === true,
        replyChars: result.reply?.length ?? 0,
        elapsedMs: result.elapsedMs,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditMeshcoreEvent(req, 'meshcore_local_cli_failed', 'configuration', {
        sourceId: req.params.id,
        command,
        error: msg,
      });
      if (/timed out/i.test(msg)) {
        return res.status(504).json({ success: false, error: msg, code: 'CLI_TIMEOUT' });
      }
      if (/not connected|not available for this device type|Serial port not open/i.test(msg)) {
        return res.status(400).json({ success: false, error: msg });
      }
      logger.error('[API] Local CLI command failed:', err);
      res.status(502).json({ success: false, error: msg });
    }
  } catch (error) {
    logger.error('[API] Unexpected error in /cli:', error);
    res.status(500).json({ success: false, error: 'CLI error' });
  }
});

/**
 * GET /api/meshcore/admin/credentials-capability
 *
 * Reports whether the server can persist MeshCore admin passwords. The
 * answer is determined by whether SESSION_SECRET was explicitly configured
 * (vs auto-generated on boot). When `canRemember=false`, the UI hides the
 * "Remember password" checkbox.
 *
 * Also returns the subset of stored credentials for THIS source whose
 * envelope `kid` no longer matches the current SESSION_SECRET — used to
 * surface a "N saved passwords need to be re-entered" banner.
 */
router.get('/admin/credentials-capability', requireAuth(), requirePermission('remote_admin', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const [rotatedAll, storedAll] = await Promise.all([store.listRotated(), store.listStored()]);
    const rotated = rotatedAll.filter((r) => r.sourceId === sourceId);
    const stored = storedAll.filter((s) => s.sourceId === sourceId);
    res.json({
      success: true,
      data: {
        canRemember: store.capability.canRemember,
        reason: store.capability.reason,
        rotatedCount: rotated.length,
        rotated: rotated.map((r) => ({ publicKey: r.publicKey, name: r.name })),
        stored: stored.map((s) => ({ publicKey: s.publicKey, name: s.name })),
      },
    });
  } catch (error) {
    logger.error('[API] Error reading credentials capability:', error);
    res.status(500).json({ success: false, error: 'Capability lookup failed' });
  }
});

/**
 * POST /api/meshcore/admin/login-with-saved
 *
 * Auto-login using a previously-saved admin credential. The console
 * triggers this on mount when the capability endpoint reports a non-
 * rotated stored credential for the target contact, so the user doesn't
 * have to re-enter the password every session.
 *
 * SECURITY INVARIANT — the saved plaintext password NEVER leaves this
 * process. The flow is:
 *     1. Client sends only { publicKey }. No password.
 *     2. Server reads the encrypted envelope from the DB and decrypts
 *        it server-side via MeshCoreCredentialStore.
 *     3. Server passes the plaintext to MeshCoreManager.loginToNode
 *        IN-PROCESS — it is used to derive the per-contact shared
 *        secret and discarded.
 *     4. Server returns only { success, usedStored, code } — never
 *        the plaintext, never the envelope, never the key fingerprint
 *        (the fingerprint is opaque metadata, but still kept off the
 *        client because exposing it would let a hostile script enumerate
 *        SESSION_SECRET rotations).
 *
 * Response codes:
 *   404 NO_STORED_CREDENTIAL — nothing saved for this (source, pubkey).
 *   410 CREDENTIAL_KEY_ROTATED — SESSION_SECRET changed since the
 *       password was saved; client should clear and prompt fresh.
 *   401 STORED_CREDENTIAL_REJECTED — credential decrypted but the remote
 *       rejected the login (remote's admin password probably changed).
 */
router.post('/admin/login-with-saved', meshcoreDeviceLimiter, requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.body as { publicKey?: string };
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    const sourceId = req.params.id!;
    const store = getMeshCoreCredentialStore();
    const result = await store.load(sourceId, publicKey);
    if (result.kind === 'none') {
      auditMeshcoreEvent(req, 'meshcore_remote_login_saved_failed', 'remote_admin', {
        sourceId, publicKey, code: 'NO_STORED_CREDENTIAL',
      });
      return res.status(404).json({ success: false, error: 'No saved credential for this node', code: 'NO_STORED_CREDENTIAL' });
    }
    if (result.kind === 'key_rotated') {
      auditMeshcoreEvent(req, 'meshcore_remote_login_saved_failed', 'remote_admin', {
        sourceId, publicKey, code: 'CREDENTIAL_KEY_ROTATED',
      });
      return res.status(410).json({
        success: false,
        error: 'Saved credential was encrypted with a previous SESSION_SECRET',
        code: 'CREDENTIAL_KEY_ROTATED',
        // Deliberately NOT echoing result.storedKid back to the client —
        // an attacker shouldn't be able to enumerate prior fingerprints.
      });
    }
    // result.password is intentionally consumed in-process only; do not
    // log it, do not echo it, do not include it in any response field.
    const ok = await managerFor(req).loginToNode(publicKey, result.password);
    if (!ok) {
      auditMeshcoreEvent(req, 'meshcore_remote_login_saved_failed', 'remote_admin', {
        sourceId, publicKey, code: 'STORED_CREDENTIAL_REJECTED',
      });
      return res.status(401).json({ success: false, error: 'Saved credential rejected by the remote', code: 'STORED_CREDENTIAL_REJECTED' });
    }
    auditMeshcoreEvent(req, 'meshcore_remote_login_saved', 'remote_admin', {
      sourceId, publicKey,
    });
    res.json({ success: true, usedStored: true });
  } catch (error) {
    logger.error('[API] Error in login-with-saved:', error);
    res.status(500).json({ success: false, error: 'Login error' });
  }
});

/**
 * DELETE /api/meshcore/admin/credentials/:publicKey
 * Forget a previously-saved admin password. No-op if none is saved.
 */
router.delete('/admin/credentials/:publicKey', requireAuth(), requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const publicKey = req.params.publicKey;
    if (!isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
    }
    await getMeshCoreCredentialStore().clear(sourceId, publicKey);
    auditMeshcoreEvent(req, 'meshcore_credential_forget', 'remote_admin', {
      sourceId, publicKey,
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('[API] Error clearing credential:', error);
    res.status(500).json({ success: false, error: 'Clear failed' });
  }
});

/**
 * GET /api/meshcore/admin/status/:publicKey
 * Get status from a remote node (requires prior login)
 * Requires authentication - queries remote node
 */
router.get('/admin/status/:publicKey', requireAuth(), requirePermission('remote_admin', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
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
 * POST /api/meshcore/config/tx-power
 * Set TX power (dBm)
 * Requires authentication - modifies device radio configuration
 */
router.post('/config/tx-power', meshcoreDeviceLimiter, requireAuth(), requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const { power } = req.body;

    if (power === undefined) {
      return res.status(400).json({ success: false, error: 'power is required' });
    }

    const parsedPower = parseInt(power, 10);

    if (isNaN(parsedPower) || parsedPower < 1 || parsedPower > 22) {
      return res.status(400).json({ success: false, error: 'TX power must be between 1 and 22 dBm' });
    }

    const success = await managerFor(req).setTxPower(parsedPower);

    if (success) {
      res.json({ success: true, message: 'TX power updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update TX power' });
    }
  } catch (error) {
    logger.error('[API] Error setting TX power:', error);
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

      // Backfill advType/advName from the in-memory contact before
      // seeding the stub row, so the remote-telemetry scheduler can
      // classify the target correctly on the very next tick. Without
      // this, setNodeTelemetryConfig writes a publicKey-only row and
      // the scheduler treats every target as a Companion regardless
      // of whether it's actually a Repeater — see issue #3092.
      const manager = managerFor(req);
      const contact = manager.getContact(publicKey);
      if (contact) {
        try {
          await databaseService.meshcore.upsertNode(
            {
              publicKey,
              name: contact.advName ?? contact.name ?? null,
              advType: contact.advType ?? null,
              latitude: contact.latitude ?? null,
              longitude: contact.longitude ?? null,
              lastHeard: contact.lastSeen ?? null,
            },
            sourceId,
          );
        } catch (err) {
          logger.warn(
            `[API] telemetry-config: contact backfill for ${publicKey.substring(0, 16)}… failed: ${(err as Error).message}`,
          );
        }
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
