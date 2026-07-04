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
import { ConnectionType, MeshCoreDeviceType, MeshCoreManager, MeshCoreDiscoverFilter, type MeshCoreDiscoverMode } from '../meshcoreManager.js';
import { meshcoreManagerRegistry } from '../meshcoreRegistry.js';
import { getMeshCoreTelemetryPoller, nodeNumFromPubkey } from '../services/meshcoreTelemetryPoller.js';
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_BETWEEN_REQUESTS_MS,
  getMeshCoreRemoteTelemetryScheduler,
} from '../services/meshcoreRemoteTelemetryScheduler.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { validateAutoAckRegex } from '../utils/autoAckRegex.js';
import { meshcoreDeviceLimiter, messageLimiter } from '../middleware/rateLimiters.js';
import { getMeshCoreCredentialStore } from '../services/meshcoreCredentialStore.js';
import meshcorePacketLogService from '../services/meshcorePacketLogService.js';
import meshcorePositionHistoryService from '../services/meshcorePositionHistoryService.js';
import { resolveAutoAckPreSendDelaySeconds } from '../autoAckDelay.js';
import { isNullIsland } from '../../utils/nullIsland.js';

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
  /** Maximum message byte limits per context (UTF-8 byte count, not char count) */
  MAX_MESSAGE_BYTES_CHANNEL: 130,
  MAX_MESSAGE_BYTES_CHANNEL_SCOPED: 120,
  MAX_MESSAGE_BYTES_DM: 150,
  /** Legacy fallback — keep for safety ceiling in shared validation path */
  MAX_MESSAGE_LENGTH: 150,
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
 * Enhance a raw `neighbors` CLI reply with resolved node names.
 * Replaces each `{8-char-prefix}:{secs}:{snr*4}` line with a
 * human-readable version showing the contact name, SNR in dB,
 * and last-heard time.
 */
function enhanceNeighborsReply(reply: string, manager: ReturnType<typeof managerFor>): string {
  const trimmed = reply.trim();
  if (!trimmed || trimmed === '-none-' || /not supported/i.test(trimmed)) return reply;

  const lines = trimmed.split('\n');
  const enhanced: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length < 3) { enhanced.push(line); continue; }

    const prefix = parts[0].toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(prefix)) { enhanced.push(line); continue; }

    const secs = parseInt(parts[1], 10);
    const snrRaw = parseInt(parts[2], 10);
    if (Number.isNaN(secs) || Number.isNaN(snrRaw)) { enhanced.push(line); continue; }

    const contact = manager.resolveContactByPrefix(prefix);
    const name = contact?.advName ?? contact?.name ?? prefix;
    const snrDb = (snrRaw / 4).toFixed(1);
    const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
    enhanced.push(`${name}  SNR: ${snrDb} dB  heard: ${ago} ago`);
  }
  return enhanced.join('\n');
}

/**
 * Parse a comma-separated hex chain into a flat Uint8Array of hop bytes.
 *
 * Each token is exactly `hashBytes` bytes wide (`hashBytes * 2` hex chars):
 * "a3,7f,02" for the default 1-byte width, "a3f2,7f01" for 2-byte, etc.
 * Empty string parses to a zero-length array (zero-hop direct path).
 * Returns null on any malformed/wrong-width token so the route can 400.
 */
function parseHexPathChain(input: string, hashBytes: 1 | 2 | 3 = 1): Uint8Array | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return new Uint8Array(0);
  const parts = trimmed.split(',');
  const out = new Uint8Array(parts.length * hashBytes);
  const tokenRe = new RegExp(`^[0-9a-fA-F]{${hashBytes * 2}}$`);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i].trim();
    if (!tokenRe.test(tok)) return null;
    for (let j = 0; j < hashBytes; j++) {
      const n = parseInt(tok.slice(j * 2, j * 2 + 2), 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xff) return null;
      out[i * hashBytes + j] = n;
    }
  }
  return out;
}

function isValidMessage(text: string | undefined, maxBytes?: number): { valid: boolean; error?: string } {
  if (!text || typeof text !== 'string') {
    return { valid: false, error: 'Message text required' };
  }
  const limit = maxBytes ?? VALIDATION.MAX_MESSAGE_LENGTH;
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen > limit) {
    return { valid: false, error: `Message exceeds maximum size of ${limit} bytes (${byteLen} bytes encoded)` };
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
    const nodes = await managerFor(req).getAllNodes();
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
 * GET /api/sources/:id/meshcore/nodes/:publicKey/position-history
 *
 * Movement-trail points for one MeshCore node, oldest-first (#3852). Each
 * point is a distinct GPS fix recorded from contact adverts or the
 * Cayenne-LPP telemetry poll. `?since=<ms>` bounds the window (the map sends
 * the user-selected trail length); omit for the full retained window.
 */
router.get(
  '/nodes/:publicKey/position-history',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.params.id;
      const publicKey = req.params.publicKey;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key' });
      }
      const sinceRaw = req.query.since;
      const since = typeof sinceRaw === 'string' ? parseInt(sinceRaw, 10) : NaN;
      // Only a finite, non-negative cutoff is a real window; a negative value
      // would be a no-op cutoff that silently returns the entire history.
      const sinceArg = Number.isFinite(since) && since >= 0 ? since : undefined;
      const points = await meshcorePositionHistoryService.getPositionHistory(
        sourceId,
        publicKey,
        sinceArg,
      );
      res.json({
        success: true,
        count: points.length,
        data: points.map((p) => ({
          timestamp: p.timestamp,
          latitude: p.latitude,
          longitude: p.longitude,
          altitude: p.altitude ?? null,
        })),
      });
    } catch (error) {
      logger.error('[API] Error getting MeshCore position history:', error);
      res.status(500).json({ success: false, error: 'Failed to get position history' });
    }
  },
);

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
 * POST /api/sources/:id/meshcore/contacts/:publicKey/discover-path
 *
 * Flood a lightweight telemetry request to the contact to trigger path
 * discovery. The device temporarily forces flood routing, and when the
 * contact responds, the normal PATH return mechanism establishes the
 * forwarding route. The actual path update arrives asynchronously via
 * the PathUpdated push — this endpoint only confirms the flood was sent.
 */
router.post(
  '/contacts/:publicKey/discover-path',
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
      const ok = await managerFor(req).discoverContactPath(publicKey);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Path discovery failed — contact may be unknown, source disconnected, or not a Companion device',
        });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error discovering contact path:', error);
      res.status(500).json({ success: false, error: 'Failed to discover path' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/discover
 *
 * Active node discovery — broadcasts a zero-hop NODE_DISCOVER_REQ so nodes in
 * direct radio range announce themselves, and auto-adds each responder as a
 * contact. Body: { mode: 'nearby' | 'repeaters' | 'sensors' }.
 *   - 'nearby'    → all node types (repeaters/rooms/sensors answer; companion
 *                   devices don't reply to discovery in current firmware)
 *   - 'repeaters' → repeaters + room servers only
 *   - 'sensors'   → sensors only
 * Responses are collected over a few-second window; returns the count of
 * unique responders and how many were newly discovered.
 */
router.post(
  '/discover',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mode = req.body?.mode as MeshCoreDiscoverMode | undefined;
      if (mode !== 'nearby' && mode !== 'repeaters' && mode !== 'sensors') {
        return res.status(400).json({
          success: false,
          error: "Invalid mode — must be 'nearby', 'repeaters', or 'sensors'",
        });
      }
      const filter =
        mode === 'repeaters' ? MeshCoreDiscoverFilter.REPEATERS
        : mode === 'sensors' ? MeshCoreDiscoverFilter.SENSORS
        : MeshCoreDiscoverFilter.NEARBY;
      // fetchNames=true: actively pull each discovered repeater/room-server's
      // name via ANON_REQ OWNER so the result is named within seconds (#3820).
      const { returned, newCount } = await managerFor(req).discoverNodes(filter, 8000, true);
      res.json({ success: true, returned, new: newCount });
    } catch (error) {
      logger.error('[API] Error discovering nodes:', error);
      res.status(500).json({ success: false, error: 'Failed to discover nodes' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/regions/discover
 *
 * Region/scope discovery (#3667 phase 3) — queries each known repeater /
 * room-server contact for the list of regions it serves, and returns the
 * de-duplicated set plus a per-repeater breakdown. Coverage depends on which
 * repeaters are in the contact list; run POST /discover (mode 'repeaters')
 * first for the fullest picture.
 *
 * Requires 'nodes' 'write' — like POST /discover, this transmits radio frames
 * (a regions request to each repeater), not just a DB read.
 */
router.post(
  '/regions/discover',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const result = await managerFor(req).discoverRegions();
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('[API] Error discovering regions:', error);
      res.status(500).json({ success: false, error: 'Failed to discover regions' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/config/discoverable
 *
 * Whether this node answers inbound discovery requests (is discoverable by
 * others). Reciprocal of the discovery feature — see MeshCore issue #1027.
 */
router.get(
  '/config/discoverable',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const enabled = await managerFor(req).getRespondToDiscovery();
      res.json({ success: true, enabled });
    } catch (error) {
      logger.error('[API] Error reading discoverable setting:', error);
      res.status(500).json({ success: false, error: 'Failed to read setting' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/discoverable
 *
 * Enable/disable answering inbound discovery requests. Body: { enabled: bool }.
 * When enabled, this companion replies to NODE_DISCOVER_REQ with a zero-hop
 * advert of its public key so nearby nodes can discover it.
 */
router.post(
  '/config/discoverable',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      }
      await managerFor(req).setRespondToDiscovery(enabled);
      res.json({ success: true, enabled });
    } catch (error) {
      logger.error('[API] Error setting discoverable:', error);
      res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/config/default-scope
 *
 * The per-source default MeshCore region/scope (#3667). Empty = unscoped.
 */
router.get(
  '/config/default-scope',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const scope = await managerFor(req).getDefaultScope();
      res.json({ success: true, scope });
    } catch (error) {
      logger.error('[API] Error reading default scope:', error);
      res.status(500).json({ success: false, error: 'Failed to read setting' });
    }
  },
);

/**
 * POST /api/sources/:id/meshcore/config/default-scope
 *
 * Set the per-source default region/scope. Body: { scope: string } — a plain
 * region name (alphanumeric + hyphen, optional leading '#' which is stripped),
 * or '' to clear (unscoped). Applied to all originated flood traffic that has
 * no channel-specific scope.
 */
router.post(
  '/config/default-scope',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const raw = req.body?.scope;
      if (raw !== '' && typeof raw !== 'string') {
        return res.status(400).json({ success: false, error: 'scope must be a string' });
      }
      const stripped = (raw as string).trim().replace(/^#/, '');
      if (stripped !== '' && !/^[A-Za-z0-9-]{1,63}$/.test(stripped)) {
        return res.status(400).json({ success: false, error: 'Scope must be 1-63 chars: letters, digits, hyphen' });
      }
      const scope = await managerFor(req).setDefaultScope(stripped);
      res.json({ success: true, scope });
    } catch (error) {
      logger.error('[API] Error setting default scope:', error);
      res.status(500).json({ success: false, error: 'Failed to update setting' });
    }
  },
);

/**
 * Saved regions catalog (#3770) — a GLOBAL, user-maintained list of MeshCore
 * region names used to populate scope dropdowns (channel settings + per-message
 * override) so users don't have to type/remember scopes. The catalog is not
 * source-scoped (a scope is derived purely from a region name), but the routes
 * live under the source-scoped meshcore router and reuse its auth wiring.
 *
 * GET    .../saved-regions      → list all saved regions
 * POST   .../saved-regions      → { name, note? } add (idempotent)
 * DELETE .../saved-regions/:id  → delete one
 */
router.get(
  '/saved-regions',
  requireAuth(),
  requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }),
  async (_req: Request, res: Response) => {
    try {
      const regions = await databaseService.savedRegions.getAllAsync();
      res.json({ success: true, regions });
    } catch (error) {
      logger.error('[API] Error listing saved regions:', error);
      res.status(500).json({ success: false, error: 'Failed to list saved regions' });
    }
  },
);

router.post(
  '/saved-regions',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const name = req.body?.name;
      const note = req.body?.note;
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, error: 'name is required' });
      }
      if (name.length > 64) {
        return res.status(400).json({ success: false, error: 'name must be 64 characters or fewer' });
      }
      if (note !== undefined && note !== null && typeof note !== 'string') {
        return res.status(400).json({ success: false, error: 'note must be a string' });
      }
      const region = await databaseService.savedRegions.addAsync(name, note ?? null);
      // Refresh the scope cache on every manager so the new region name is
      // available for resolving inbound messages immediately (#3829).
      for (const mgr of meshcoreManagerRegistry.list()) {
        mgr.notifySavedRegionsChanged();
      }
      res.json({ success: true, region });
    } catch (error: any) {
      // addAsync throws on an empty/invalid normalized name.
      if (error?.message?.includes('Invalid region name')) {
        return res.status(400).json({ success: false, error: error.message });
      }
      logger.error('[API] Error adding saved region:', error);
      res.status(500).json({ success: false, error: 'Failed to add saved region' });
    }
  },
);

router.delete(
  '/saved-regions/:regionId',
  requireAuth(),
  requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.regionId);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid region id' });
      }
      await databaseService.savedRegions.deleteAsync(id);
      // Refresh the scope cache on every manager so the deleted region is
      // no longer matched against inbound messages (#3829).
      for (const mgr of meshcoreManagerRegistry.list()) {
        mgr.notifySavedRegionsChanged();
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error deleting saved region:', error);
      res.status(500).json({ success: false, error: 'Failed to delete saved region' });
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
 * Requires nodes:write. Note: a stale manual path silently drops direct
 * sends to this contact until the next flood — the UI surfaces this and
 * offers "Reset Path" to re-discover.
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
      const rawPath = (req.body ?? {}).outPath;
      if (typeof rawPath !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Body must include `outPath` as a comma-separated hex string',
        });
      }
      // Per-hop hash width (1/2/3 bytes). Defaults to 1 for backward
      // compatibility with callers that don't send it. MeshCore packs the
      // width into the top 2 bits of out_path_len; 4-byte (and up) is
      // rejected by firmware, so only 1/2/3 are accepted here. See #3670.
      const rawHashBytes = (req.body ?? {}).hashBytes;
      let hashBytes: 1 | 2 | 3 = 1;
      if (rawHashBytes !== undefined) {
        if (rawHashBytes !== 1 && rawHashBytes !== 2 && rawHashBytes !== 3) {
          return res.status(400).json({
            success: false,
            error: 'hashBytes must be 1, 2, or 3',
          });
        }
        hashBytes = rawHashBytes;
      }
      const parsed = parseHexPathChain(rawPath, hashBytes);
      if (!parsed) {
        return res.status(400).json({
          success: false,
          error: `Invalid outPath — expected a comma-separated hex chain of ${hashBytes}-byte hops (${hashBytes * 2} hex chars each), e.g. "${'a3f27f01'.slice(0, hashBytes * 2)}"`,
        });
      }
      if (parsed.length > 64) {
        return res.status(400).json({
          success: false,
          error: `outPath too long: ${parsed.length} bytes (max 64)`,
        });
      }
      const hopCount = parsed.length / hashBytes;
      if (hopCount > 63) {
        return res.status(400).json({
          success: false,
          error: `outPath too long: ${hopCount} hops (max 63)`,
        });
      }
      const ok = await managerFor(req).setContactOutPath(publicKey, parsed, hashBytes);
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Set out_path failed — the device did not respond in time. Verify the device is connected and try again.',
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
      const result = await managerFor(req).shareContact(publicKey);
      if (!result.ok) {
        const error =
          result.error ??
          'Share contact failed — contact may be unknown, source disconnected, or not a Companion device';
        // A non-responding device is a gateway-timeout condition; everything
        // else (rejected, disconnected, not a Companion) is a 409 conflict.
        const status = /did not respond|timeout/i.test(error) ? 504 : 409;
        return res.status(status).json({ success: false, error });
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
      // No `isValidPublicKey` format guard here (unlike the path/DM/share routes
      // that transmit the key to the device): removal is a cleanup operation and
      // must work for malformed or "ghost" rows too (issue #3443). The key is
      // only used to look up the DB row, so an odd/truncated key is fine.
      if (!publicKey) {
        return res.status(400).json({ success: false, error: 'Missing public key' });
      }
      const manager = managerFor(req);
      // Try the device-side removal first (deletes from the device + DB on a
      // connected Companion). If that can't apply — the key isn't a real device
      // contact (malformed/ghost), the source is disconnected, or it's not a
      // Companion — fall back to forgetting the row locally so the stale entry
      // can still be cleaned up from MeshMonitor.
      let ok = await manager.removeContact(publicKey);
      if (!ok) {
        ok = await manager.forgetLocalContact(publicKey);
      }
      if (!ok) {
        return res.status(409).json({
          success: false,
          error: 'Remove contact failed — could not delete the contact row',
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
      const manager = managerFor(req);
      const result = await manager.getNeighbours(publicKey, { count, offset, orderBy });
      if (!result) {
        return res.status(409).json({
          success: false,
          error: 'Get neighbours failed — source disconnected, not a Companion, or firmware too old',
        });
      }
      const sourceId = (req.params as { id?: string }).id!;
      const resolved = result.neighbours.map((n: { publicKeyPrefix: string; heardSecondsAgo: number; snr: number }) => {
        const contact = manager.resolveContactByPrefix(n.publicKeyPrefix);
        return { ...n, name: contact?.advName ?? contact?.name ?? null, fullPublicKey: contact?.publicKey ?? null };
      });

      // Persist to meshcore_neighbor_info so the data survives page refreshes.
      const toStore = resolved
        .filter((n: { fullPublicKey: string | null }) => n.fullPublicKey != null)
        .map((n: { fullPublicKey: string | null; snr: number; heardSecondsAgo: number }) => ({
          neighborPublicKey: n.fullPublicKey!,
          snr: n.snr,
          lastHeardSecs: n.heardSecondsAgo,
        }));
      if (toStore.length > 0) {
        databaseService.meshcore.insertNeighborsBatch(sourceId, publicKey, toStore)
          .catch((err: Error) => logger.warn('[API] Failed to persist neighbours:', err.message));
      }

      res.json({ success: true, data: { ...result, neighbours: resolved } });
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
      const result = await managerFor(req).syncDeviceTime();
      if (!result.ok) {
        if (result.reason === 'command-failed') {
          // The guards passed but the device rejected (or never acked) the
          // command — surface the real reason instead of the misleading
          // "disconnected or not a Companion device" (issue #3570).
          return res.status(502).json({
            success: false,
            error: result.error
              ? `Device rejected the time-sync command: ${result.error}`
              : 'Device rejected the time-sync command',
          });
        }
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
 * Body: { privateKey: string (128-char hex), confirm: true }
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
      if (typeof privateKey !== 'string' || !/^[0-9a-fA-F]{128}$/.test(privateKey)) {
        return res.status(400).json({
          success: false,
          error: 'privateKey must be a 128-character hex string',
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
 * GET /api/meshcore/messages/channel/:idx
 * Per-channel message backlog. Unlike /messages (a global recent-tail shared by
 * every channel and DM), this returns just channel :idx's history — so a busy
 * channel can't push another channel's messages out of the visible window.
 */
router.get('/messages/channel/:idx', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const idx = parseInt(req.params.idx, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ success: false, error: 'idx must be a non-negative integer' });
    }
    let limit = parseInt(req.query.limit as string || '100', 10);
    if (isNaN(limit) || limit < 1) {
      limit = 100;
    } else if (limit > VALIDATION.MAX_MESSAGE_LIMIT) {
      limit = VALIDATION.MAX_MESSAGE_LIMIT;
    }
    const messages = await managerFor(req).getChannelMessages(idx, limit);
    res.json({
      success: true,
      data: messages,
      count: messages.length,
    });
  } catch (error) {
    logger.error('[API] Error getting channel messages:', error);
    res.status(500).json({ success: false, error: 'Failed to get channel messages' });
  }
});

/**
 * GET /api/meshcore/messages/channel-counts?channels=0,1,2
 * Total persisted message count per channel index, for the channel-list badges.
 * Accurate per channel (not the capped in-memory pool). Also returns the latest
 * message timestamp per channel (`latestTimestamps`) for the unread indicator
 * (#3703) — channels with no messages are omitted from that map.
 */
router.get('/messages/channel-counts', optionalAuth(), requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const raw = (req.query.channels as string | undefined) ?? '';
    const indices = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0);
    // De-dupe and cap to a sane number of channels per request.
    const unique = Array.from(new Set(indices)).slice(0, 64);
    const manager = managerFor(req);
    const [counts, latestTimestamps] = unique.length > 0
      ? await Promise.all([
          manager.getChannelMessageCounts(unique),
          manager.getChannelLatestTimestamps(unique),
        ])
      : [{}, {}];
    res.json({ success: true, counts, latestTimestamps });
  } catch (error) {
    logger.error('[API] Error getting channel message counts:', error);
    res.status(500).json({ success: false, error: 'Failed to get channel message counts' });
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
    const nodes = await manager.getAllNodes();
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
    const { text, toPublicKey, channelIdx, scope } = req.body;

    // Determine per-context byte limit before validating the message.
    // DM (toPublicKey present) → 150 bytes.
    // Channel with scope → 120 bytes. Channel without scope → 130 bytes.
    let msgMaxBytes: number;
    if (toPublicKey !== undefined && toPublicKey !== null && toPublicKey !== '') {
      msgMaxBytes = VALIDATION.MAX_MESSAGE_BYTES_DM;
    } else {
      const hasScope = typeof scope === 'string' && scope.trim().length > 0;
      msgMaxBytes = hasScope
        ? VALIDATION.MAX_MESSAGE_BYTES_CHANNEL_SCOPED
        : VALIDATION.MAX_MESSAGE_BYTES_CHANNEL;
    }

    // Validate message text using the context-appropriate byte limit.
    const textValidation = isValidMessage(text, msgMaxBytes);
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

    // Optional per-message scope/region override (#3701). Contract (#3704
    // review — kept unambiguous and matching normalizeScopeOverride):
    //   - key ABSENT (`undefined`) OR JSON `null` ⇒ NO override; the manager
    //     resolves the channel/default scope as usual. We collapse both to
    //     `undefined` here so "no override" has a single representation.
    //   - `''` (or whitespace/punctuation-only) ⇒ explicit UNSCOPED for this
    //     one send only.
    //   - a non-empty string ⇒ a one-off region override for this send only.
    // The override is NEVER persisted to the channel; the next normal send
    // re-asserts the channel/default scope. The manager normalises the value
    // leniently (strip '#', keep letters/digits/hyphens, warn on stripped
    // chars). Here we only reject wrong types / over-length up front so a
    // malformed body can't silently change scoping.
    let scopeOverride: string | undefined;
    if (scope !== undefined && scope !== null) {
      if (typeof scope !== 'string') {
        return res.status(400).json({ success: false, error: 'scope must be a string' });
      }
      if (scope.length > 63) {
        return res.status(400).json({ success: false, error: 'scope must be 63 characters or fewer' });
      }
      scopeOverride = scope;
    }

    const success = await managerFor(req).sendMessage(text, toPublicKey, parsedChannelIdx, scopeOverride);

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
 * GET /api/meshcore/rooms/sync-config?publicKey=...
 * Retrieve the current room sync configuration for a room server.
 */
router.get('/rooms/sync-config', requireAuth(), requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const publicKey = req.query.publicKey as string | undefined;
    if (typeof publicKey !== 'string' || !isValidPublicKey(publicKey)) {
      return res.status(400).json({ success: false, error: 'Invalid public key format' });
    }
    const sourceId = req.params.id!;
    const config = await databaseService.meshcore.getRoomSyncConfig(sourceId, publicKey);
    if (!config) {
      return res.json({ success: true, enabled: false, intervalMinutes: 60 });
    }
    res.json({ success: true, enabled: config.enabled, intervalMinutes: config.intervalMinutes });
  } catch (error) {
    logger.error('[API] Error getting room sync config:', error);
    res.status(500).json({ success: false, error: 'Failed to get room sync config' });
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
      const manager = managerFor(req);
      const result = await manager.sendCliCommand(publicKey, command, {
        timeoutMs: effectiveTimeout,
      });
      if (/^neighbors$/i.test(command.trim())) {
        result.reply = enhanceNeighborsReply(result.reply, manager);
      }
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
      const manager = managerFor(req);
      const result = await manager.sendLocalCliCommand(command, {
        timeoutMs: effectiveTimeout,
      });
      if (/^neighbors$/i.test(command.trim())) {
        result.reply = enhanceNeighborsReply(result.reply, manager);
      }
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
 * POST /api/sources/:id/meshcore/nodes/:publicKey/telemetry/poll
 *
 * Manually trigger an immediate remote-telemetry poll for one node,
 * outside the scheduler's cadence (issue #3674). Body:
 *   { type: 'status' | 'lpp' }
 * selecting which telemetry path to request — the UI exposes one button
 * per type. Reuses the scheduler's shared request → convert → insert
 * logic and honours the same per-source 60s mesh-TX gate so the buttons
 * can't be spammed onto the air.
 *
 * Gated by `nodes:read` (a manual poll is a user-initiated read that
 * happens to transmit), and additionally rate-limited at the HTTP layer
 * by `meshcoreDeviceLimiter`.
 */
router.post(
  '/nodes/:publicKey/telemetry/poll',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
      }

      const type = (req.body?.type ?? '') as string;
      if (type !== 'status' && type !== 'lpp') {
        return res.status(400).json({ success: false, error: "type must be 'status' or 'lpp'" });
      }

      const manager = meshcoreManagerRegistry.get(sourceId);
      if (!manager || !manager.isConnected()) {
        return res.status(409).json({ success: false, error: 'MeshCore source is not connected' });
      }

      const scheduler = getMeshCoreRemoteTelemetryScheduler();
      if (!scheduler) {
        return res.status(503).json({ success: false, error: 'Telemetry scheduler unavailable' });
      }

      // Per-source 60s mesh-TX gate — the same primitive the scheduler
      // uses, so a manual poll can't flood the air or collide with a
      // scheduled request already in flight on this source.
      const lastTx = manager.getLastMeshTxAt();
      const sinceLastTx = Date.now() - lastTx;
      if (lastTx > 0 && sinceLastTx < MIN_INTERVAL_BETWEEN_REQUESTS_MS) {
        const retryAfterSecs = Math.ceil((MIN_INTERVAL_BETWEEN_REQUESTS_MS - sinceLastTx) / 1000);
        res.set('Retry-After', String(retryAfterSecs));
        return res.status(429).json({
          success: false,
          error: `Too soon since last mesh transmission; retry in ${retryAfterSecs}s`,
          retryAfterSecs,
        });
      }

      // Load the persisted node (if any) so the scheduler can classify
      // advType for guest-login decisions. A node not yet in the DB is
      // fine — requestTelemetryForNode treats an unknown advType as a
      // companion (LPP-only, no guest login).
      const node = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);

      // Stamp before issuing so the gate applies regardless of result and
      // the scheduler's fair-rotation clock advances too.
      const now = Date.now();
      manager.recordMeshTx(now);
      await databaseService.meshcore.markTelemetryRequested(sourceId, publicKey, now);

      const result = await scheduler.requestTelemetryForNode(
        manager,
        { publicKey, advType: node?.advType ?? null },
        { includeStatus: type === 'status', includeLpp: type === 'lpp' },
      );

      res.json({
        success: true,
        data: { type, written: result.written, sources: result.sources },
      });
    } catch (error) {
      logger.error('[API] Error polling node telemetry:', error);
      res.status(500).json({ success: false, error: 'Telemetry poll failed' });
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
              // Tag as the static/advert-cached position (#3908) so it never
              // clobbers an established telemetry GNSS fix — mirrors persistContact,
              // including the Null Island (0,0) guard so an uninitialized GPS
              // default is never tagged as a real 'contact' position.
              positionSource: (typeof contact.latitude === 'number'
                && typeof contact.longitude === 'number'
                && !isNullIsland(contact.latitude, contact.longitude))
                ? 'contact'
                : undefined,
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

/**
 * POST /api/sources/:id/meshcore/nodes/:publicKey/favorite
 *
 * Toggle the server-side favorite flag for a MeshCore node (any role:
 * Companion, Repeater, Room Server, …). Body: { isFavorite: boolean }.
 *
 * MeshCore firmware has no native favorite concept, so this persists locally
 * only and never pushes anything to the device (unlike Meshtastic, whose
 * favorite toggle round-trips a SetFavoriteNode admin message). Favorited
 * nodes pin to the top of the node list (issue #3588).
 *
 * Gated by `nodes:write` to match the Meshtastic favorite endpoint and the
 * other MeshCore node-mutation routes.
 */
router.post(
  '/nodes/:publicKey/favorite',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return res.status(400).json({ success: false, error: 'Invalid public key format (expected 64-character hex string)' });
      }

      const { isFavorite } = req.body ?? {};
      if (typeof isFavorite !== 'boolean') {
        return res.status(400).json({ success: false, error: 'isFavorite must be a boolean' });
      }

      // Backfill identity from the in-memory contact before seeding the stub
      // row, so a node favorited while it only exists in-memory still carries
      // a name/type for the node list (mirrors the telemetry-config route).
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
              // Tag as the static/advert-cached position (#3908) so it never
              // clobbers an established telemetry GNSS fix — mirrors persistContact,
              // including the Null Island (0,0) guard so an uninitialized GPS
              // default is never tagged as a real 'contact' position.
              positionSource: (typeof contact.latitude === 'number'
                && typeof contact.longitude === 'number'
                && !isNullIsland(contact.latitude, contact.longitude))
                ? 'contact'
                : undefined,
              lastHeard: contact.lastSeen ?? null,
            },
            sourceId,
          );
        } catch (err) {
          logger.warn(
            `[API] favorite: contact backfill for ${publicKey.substring(0, 16)}… failed: ${(err as Error).message}`,
          );
        }
      }

      await manager.setNodeFavorite(publicKey, isFavorite);

      res.json({
        success: true,
        data: { publicKey, sourceId, isFavorite },
      });
    } catch (error) {
      logger.error('[API] Error setting MeshCore node favorite:', error);
      res.status(500).json({ success: false, error: 'Failed to set favorite' });
    }
  },
);

// ============ Auto-Pathfinding Automation ============

router.get(
  '/automation/pathfinding',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req);
      const sourceId = (req.params as { id?: string }).id!;
      const status = mgr.getAutoPathfindingStatus();

      const enabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingEnabled');
      const pathDiscoveryEnabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingPathDiscoveryEnabled');
      const neighborsEnabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingNeighborsEnabled');
      const intervalMinutes = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingIntervalMinutes');
      const repeatHours = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoPathfindingRepeatHours');

      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          pathDiscoveryEnabled: pathDiscoveryEnabled === 'true',
          neighborsEnabled: neighborsEnabled === 'true',
          intervalMinutes: parseInt(intervalMinutes || '5', 10) || 5,
          repeatHours: parseInt(repeatHours || '24', 10) || 24,
          schedulerRunning: status.enabled,
          lastRunAt: status.lastRunAt || null,
        },
      });
    } catch (error) {
      logger.error('[API] Error reading auto-pathfinding settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-pathfinding settings' });
    }
  },
);

router.post(
  '/automation/pathfinding',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req);
      const sourceId = (req.params as { id?: string }).id!;
      const {
        enabled,
        pathDiscoveryEnabled,
        neighborsEnabled,
        intervalMinutes,
        repeatHours,
      } = req.body as {
        enabled?: boolean;
        pathDiscoveryEnabled?: boolean;
        neighborsEnabled?: boolean;
        intervalMinutes?: number;
        repeatHours?: number;
      };

      if (enabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingEnabled', String(enabled));
      }
      if (pathDiscoveryEnabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingPathDiscoveryEnabled', String(pathDiscoveryEnabled));
      }
      if (neighborsEnabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingNeighborsEnabled', String(neighborsEnabled));
      }
      if (intervalMinutes !== undefined) {
        const clamped = Math.max(3, Math.min(60, intervalMinutes));
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingIntervalMinutes', String(clamped));
      }
      if (repeatHours !== undefined) {
        const clamped = Math.max(1, Math.min(168, repeatHours));
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoPathfindingRepeatHours', String(clamped));
      }

      await mgr.startAutoPathfinding();

      const status = mgr.getAutoPathfindingStatus();
      res.json({
        success: true,
        data: {
          schedulerRunning: status.enabled,
          lastRunAt: status.lastRunAt || null,
        },
      });
    } catch (error) {
      logger.error('[API] Error saving auto-pathfinding settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-pathfinding settings' });
    }
  },
);

// ============ Auto-Acknowledge Automation ============
//
// Per-source settings store for MeshCore auto-acknowledge. The trigger
// fires from the manager's incoming-message handler (handleBridgeEvent),
// so this endpoint is just a CRUD wrapper — no scheduler.

router.get(
  '/automation/autoack',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;

      const enabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckEnabled');
      const regex = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckRegex');
      const message = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckMessage');
      const channels = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckChannels');
      const directMessages = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckDirectMessages');
      const useDM = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckUseDM');
      const cooldownSeconds = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckCooldownSeconds');
      const preSendDelaySeconds = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckPreSendDelaySeconds');
      const testMessages = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckTestMessages');
      const scopeMode = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeMode');
      const scopeName = await settings.getSettingForSource(sourceId, 'meshcoreAutoAckScopeName');

      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          regex: regex || '^(test|ping)',
          message: message || '🤖 Copy, {NODE_NAME}! {HOPS} hops @ {TIME}',
          channels: (channels || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => parseInt(s, 10))
            .filter(n => Number.isFinite(n)),
          directMessages: directMessages === 'true',
          useDM: useDM === 'true',
          cooldownSeconds: parseInt(cooldownSeconds || '0', 10) || 0,
          // Defense-in-depth: clamp on read too (default 0, cap 120s) so a
          // value written directly to the DB can't escape the UI's bounds.
          preSendDelaySeconds: resolveAutoAckPreSendDelaySeconds(preSendDelaySeconds),
          testMessages: testMessages || 'test\nTest message\nping\nPING\nHello world\nTESTING 123',
          // MeshCore scope/region for the ack reply (#3833).
          scopeMode: (scopeMode as 'inherit' | 'trigger' | 'unscoped' | 'named') || 'inherit',
          scopeName: scopeName || '',
        },
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-ack settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-ack settings' });
    }
  },
);

router.post(
  '/automation/autoack',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;
      const {
        enabled,
        regex,
        message,
        channels,
        directMessages,
        useDM,
        cooldownSeconds,
        preSendDelaySeconds,
        testMessages,
        scopeMode,
        scopeName,
      } = req.body as {
        enabled?: boolean;
        regex?: string;
        message?: string;
        channels?: number[];
        directMessages?: boolean;
        useDM?: boolean;
        cooldownSeconds?: number;
        preSendDelaySeconds?: number;
        testMessages?: string;
        scopeMode?: 'inherit' | 'trigger' | 'unscoped' | 'named';
        scopeName?: string;
      };

      if (enabled !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckEnabled', String(enabled));
      }
      if (regex !== undefined) {
        // Store-time safety gate. The shared validator rejects unsafe
        // shapes (catastrophic backtracking, oversized patterns) and
        // confirms the value is a syntactically valid RegExp. Centralised
        // with the manager's execution-time check so the two stay in
        // sync; this also satisfies CodeQL's js/regex-injection check.
        const validation = validateAutoAckRegex(regex);
        if (!validation.ok) {
          return res.status(400).json({ success: false, error: `Invalid regex pattern: ${validation.error}` });
        }
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckRegex', regex);
      }
      if (message !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckMessage', message);
      }
      if (channels !== undefined) {
        const csv = Array.isArray(channels)
          ? channels.filter(n => Number.isFinite(n)).join(',')
          : '';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckChannels', csv);
      }
      if (directMessages !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckDirectMessages', String(directMessages));
      }
      if (useDM !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckUseDM', String(useDM));
      }
      if (cooldownSeconds !== undefined) {
        const clamped = Math.max(0, Math.min(3600, cooldownSeconds));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckCooldownSeconds', String(clamped));
      }
      if (preSendDelaySeconds !== undefined) {
        // Pre-send delay caps at 120s (#3876) — long enough to let a repeater
        // settle, short enough that an ack stays prompt.
        const clamped = Math.max(0, Math.min(120, preSendDelaySeconds));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckPreSendDelaySeconds', String(clamped));
      }
      if (testMessages !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckTestMessages', testMessages);
      }
      if (scopeMode !== undefined) {
        const mode = ['inherit', 'trigger', 'unscoped', 'named'].includes(String(scopeMode)) ? String(scopeMode) : 'inherit';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckScopeMode', mode);
      }
      if (scopeName !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAckScopeName', String(scopeName).trim());
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-ack settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-ack settings' });
    }
  },
);

// ============ Auto-Announce Automation ============
//
// Per-source settings + actions for MeshCore auto-announce. The
// scheduler lives on the manager (`startAutoAnnounce`,
// `runAutoAnnounceCycle`); this surface is the CRUD + manual-fire +
// preview wrapper the UI calls.

router.get(
  '/automation/announce',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;

      const enabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceEnabled');
      const intervalHours = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceIntervalHours');
      const message = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceMessage');
      const channelIndexesRaw = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceChannelIndexes');
      const announceOnStart = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceOnStart');
      const useSchedule = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceUseSchedule');
      const schedule = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceSchedule');
      const advertEnabled = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceAdvertEnabled');
      const advertDelaySeconds = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceAdvertDelaySeconds');
      const lastRunAt = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceLastRunAt');
      const scopeMode = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceScopeMode');
      const scopeName = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceScopeName');

      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          intervalHours: parseInt(intervalHours || '6', 10) || 6,
          message: message || 'MeshMonitor {VERSION} online for {DURATION} — {CONTACTCOUNT} contacts',
          channelIndexes: (channelIndexesRaw || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => parseInt(s, 10))
            .filter(n => Number.isFinite(n)),
          announceOnStart: announceOnStart === 'true',
          useSchedule: useSchedule === 'true',
          schedule: schedule || '0 */6 * * *',
          advertEnabled: advertEnabled === 'true',
          advertDelaySeconds: parseInt(advertDelaySeconds || '30', 10) || 30,
          lastRunAt: lastRunAt ? parseInt(lastRunAt, 10) || null : null,
          // MeshCore scope/region for the announcement (#3833). No trigger here,
          // so only inherit / unscoped / named are meaningful.
          scopeMode: (scopeMode as 'inherit' | 'unscoped' | 'named') || 'inherit',
          scopeName: scopeName || '',
        },
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-announce settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-announce settings' });
    }
  },
);

router.post(
  '/automation/announce',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const settings = databaseService.settings;
      const {
        enabled,
        intervalHours,
        message,
        channelIndexes,
        announceOnStart,
        useSchedule,
        schedule,
        advertEnabled,
        advertDelaySeconds,
        scopeMode,
        scopeName,
      } = req.body as {
        enabled?: boolean;
        intervalHours?: number;
        message?: string;
        channelIndexes?: number[];
        announceOnStart?: boolean;
        useSchedule?: boolean;
        schedule?: string;
        advertEnabled?: boolean;
        advertDelaySeconds?: number;
        scopeMode?: 'inherit' | 'unscoped' | 'named';
        scopeName?: string;
      };

      if (enabled !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceEnabled', String(enabled));
      }
      if (intervalHours !== undefined) {
        const clamped = Math.max(1, Math.min(168, Math.floor(intervalHours) || 6));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceIntervalHours', String(clamped));
      }
      if (message !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceMessage', String(message));
      }
      if (channelIndexes !== undefined) {
        const csv = Array.isArray(channelIndexes)
          ? channelIndexes.filter(n => Number.isFinite(n)).join(',')
          : '';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceChannelIndexes', csv);
      }
      if (announceOnStart !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceOnStart', String(announceOnStart));
      }
      if (useSchedule !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceUseSchedule', String(useSchedule));
      }
      if (schedule !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceSchedule', String(schedule));
      }
      if (advertEnabled !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertEnabled', String(advertEnabled));
      }
      if (advertDelaySeconds !== undefined) {
        const clamped = Math.max(0, Math.min(600, Math.floor(advertDelaySeconds) || 30));
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceAdvertDelaySeconds', String(clamped));
      }
      if (scopeMode !== undefined) {
        const mode = ['inherit', 'unscoped', 'named'].includes(String(scopeMode)) ? String(scopeMode) : 'inherit';
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceScopeMode', mode);
      }
      if (scopeName !== undefined) {
        await settings.setSourceSetting(sourceId, 'meshcoreAutoAnnounceScopeName', String(scopeName).trim());
      }

      // Re-arm the scheduler so the new settings take effect immediately.
      const mgr = meshcoreManagerRegistry.get(sourceId);
      if (mgr) {
        await mgr.startAutoAnnounce().catch((err: Error) =>
          logger.warn(`[API] auto-announce restart after save failed: ${err.message}`));
      }

      const lastRunRaw = await settings.getSettingForSource(sourceId, 'meshcoreAutoAnnounceLastRunAt');
      res.json({
        success: true,
        data: {
          lastRunAt: lastRunRaw ? parseInt(lastRunRaw, 10) || null : null,
        },
      });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-announce settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-announce settings' });
    }
  },
);

router.get(
  '/automation/announce/preview',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req);
      const message = String(req.query.message ?? '');
      if (!message) {
        return res.status(400).json({ success: false, error: 'Missing message parameter' });
      }
      const preview = await mgr.previewAnnouncementMessage(message);
      res.json({ success: true, preview });
    } catch (error) {
      logger.error('[API] Error generating meshcore announce preview:', error);
      res.status(500).json({ success: false, error: 'Failed to generate preview' });
    }
  },
);

router.post(
  '/automation/announce/send',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req);
      const result = await mgr.runAutoAnnounceCycle('manual');
      const status = mgr.getAutoAnnounceStatus();
      res.json({ success: true, data: { ...result, lastRunAt: status.lastRunAt || null } });
    } catch (error) {
      logger.error('[API] Error sending manual meshcore announce:', error);
      res.status(500).json({ success: false, error: 'Failed to send announcement' });
    }
  },
);

// ============ Timer Triggers Automation ============
//
// Triggers persist as a JSON array; the manager re-reads on schedule
// fire so a freshly-saved template applies on the next tick. The
// shared MeshCoreTimerTrigger type lives in src/server/meshcoreManager.ts.

router.get(
  '/automation/timers',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const raw = (await databaseService.settings.getSettingForSource(sourceId, 'meshcoreTimerTriggers')) || '[]';
      let triggers: unknown = [];
      try { triggers = JSON.parse(raw); } catch { triggers = []; }
      res.json({ success: true, data: { triggers: Array.isArray(triggers) ? triggers : [] } });
    } catch (error) {
      logger.error('[API] Error reading meshcore timer triggers:', error);
      res.status(500).json({ success: false, error: 'Failed to read timer triggers' });
    }
  },
);

router.post(
  '/automation/timers',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const body = req.body as { triggers?: unknown };
      if (!Array.isArray(body.triggers)) {
        return res.status(400).json({ success: false, error: 'triggers must be an array' });
      }
      await databaseService.settings.setSourceSetting(sourceId, 'meshcoreTimerTriggers', JSON.stringify(body.triggers));

      const mgr = meshcoreManagerRegistry.get(sourceId);
      if (mgr) {
        await mgr.startTimerTriggers().catch((err: Error) =>
          logger.warn(`[API] timer-trigger restart after save failed: ${err.message}`));
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error saving meshcore timer triggers:', error);
      res.status(500).json({ success: false, error: 'Failed to save timer triggers' });
    }
  },
);

router.post(
  '/automation/timers/:triggerId/run',
  meshcoreDeviceLimiter,
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = managerFor(req);
      const triggerId = String((req.params as { triggerId?: string }).triggerId || '');
      if (!triggerId) {
        return res.status(400).json({ success: false, error: 'triggerId required' });
      }
      const result = await mgr.runTimerTrigger(triggerId);
      res.json({ success: result.ok, data: result });
    } catch (error) {
      logger.error('[API] Error running meshcore timer trigger:', error);
      res.status(500).json({ success: false, error: 'Failed to run timer trigger' });
    }
  },
);

// ============ Auto-Responder Automation ============
//
// Multi-pattern reactor. Triggers persist as a JSON array and the
// manager re-reads them on every incoming message so a saved pattern
// fires on the next packet without a restart.

router.get(
  '/automation/responder',
  optionalAuth(),
  requirePermission('automation', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const enabled = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoResponderEnabled');
      const raw = (await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoResponderTriggers')) || '[]';
      let triggers: unknown = [];
      try { triggers = JSON.parse(raw); } catch { triggers = []; }
      res.json({
        success: true,
        data: {
          enabled: enabled === 'true',
          triggers: Array.isArray(triggers) ? triggers : [],
        },
      });
    } catch (error) {
      logger.error('[API] Error reading meshcore auto-responder settings:', error);
      res.status(500).json({ success: false, error: 'Failed to read auto-responder settings' });
    }
  },
);

router.post(
  '/automation/responder',
  requireAuth(),
  requirePermission('automation', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const body = req.body as { enabled?: boolean; triggers?: unknown };

      if (body.enabled !== undefined) {
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoResponderEnabled', String(body.enabled));
      }
      if (body.triggers !== undefined) {
        if (!Array.isArray(body.triggers)) {
          return res.status(400).json({ success: false, error: 'triggers must be an array' });
        }
        // Validate each trigger's regex up front so a broken pattern
        // never reaches the message loop. Reuses the same validator
        // the manager applies at execution time.
        for (const tr of body.triggers as Array<{ id?: string; pattern?: string }>) {
          if (typeof tr?.pattern !== 'string') continue;
          const v = validateAutoAckRegex(tr.pattern);
          if (!v.ok) {
            return res.status(400).json({
              success: false,
              error: `Invalid regex for trigger ${tr.id || '(unnamed)'}: ${v.error}`,
            });
          }
        }
        await databaseService.settings.setSourceSetting(sourceId, 'meshcoreAutoResponderTriggers', JSON.stringify(body.triggers));
      }

      const mgr = meshcoreManagerRegistry.get(sourceId);
      if (mgr) mgr.resetAutoResponderRegexCache();

      res.json({ success: true });
    } catch (error) {
      logger.error('[API] Error saving meshcore auto-responder settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save auto-responder settings' });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/sources/:id/meshcore/neighbors/request
// Request neighbor data from a MeshCore repeater (remote or local).
// ---------------------------------------------------------------------------

router.post('/neighbors/request', meshcoreDeviceLimiter, requireAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  const sourceId = (req.params as { id?: string }).id!;
  const { publicKey } = req.body as { publicKey?: string };

  try {
    const manager = managerFor(req);

    if (publicKey) {
      const normalizedKey = publicKey.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalizedKey)) {
        return res.status(400).json({ success: false, error: 'publicKey must be a 64-char hex string' });
      }
      const contact = manager.resolveContactByPrefix(normalizedKey);
      if (!contact) {
        return res.status(404).json({ success: false, error: 'Contact not found' });
      }
      if (contact.advType !== 2) {
        return res.status(400).json({ success: false, error: 'Neighbors request is only supported for Repeaters (advType=2)' });
      }
    }

    const result = await manager.requestNeighbors(publicKey);
    if (result === null) {
      return res.json({ success: true, data: { neighbors: [], count: 0, notSupported: true } });
    }

    auditMeshcoreEvent(req, 'meshcore_neighbors_request', 'configuration', {
      sourceId,
      publicKey: publicKey ?? '(local)',
      neighborCount: result.neighbors.length,
    });

    res.json({ success: true, data: { neighbors: result.neighbors, count: result.neighbors.length } });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes('timed out')) {
      return res.status(504).json({ success: false, error: msg, code: 'CLI_TIMEOUT' });
    }
    logger.error('[API] MeshCore neighbors request failed:', err);
    res.status(500).json({ success: false, error: 'Neighbors request failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sources/:id/meshcore/neighbors
// Query stored MeshCore neighbor data (for map rendering).
// ---------------------------------------------------------------------------

router.get('/neighbors', requireAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  const sourceId = (req.params as { id?: string }).id!;
  const sinceMs = Number(req.query.since) || 0;
  const nodeFilter = typeof req.query.node === 'string' ? req.query.node : undefined;

  try {
    let items = await databaseService.meshcore.getNeighbors([sourceId], sinceMs);
    if (nodeFilter) {
      items = items.filter((i) => i.publicKey === nodeFilter);
    }
    res.json({ success: true, data: { items } });
  } catch (error) {
    logger.error('[API] Error fetching MeshCore neighbors:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch neighbors' });
  }
});

/**
 * GET /api/sources/:id/meshcore/packets
 *
 * Paginated OTA packet log for the MeshCore Packet Monitor (newest first).
 * Filters: payload_type, route_type, since (ms). Returns the same envelope
 * shape as the Meshtastic packet monitor so the frontend can share logic.
 */
const MESHCORE_PACKET_MAX_LIMIT = 1000;

router.get(
  '/packets',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
      // Honor the user-configured retention cap (meshcore_packet_log_max_count)
      // as the default effective limit, the same way the export endpoint does
      // (issue #3690). An explicit client-supplied `limit` still wins so a
      // caller can request fewer rows; both are clamped by the hard ceiling.
      const maxCount = await meshcorePacketLogService.getMaxCount();
      const requestedLimit = parseInt(req.query.limit as string, 10);
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : maxCount;
      const limit = Math.min(Math.max(effectiveLimit, 1), MESHCORE_PACKET_MAX_LIMIT);
      const payloadType = req.query.payload_type !== undefined ? parseInt(req.query.payload_type as string, 10) : undefined;
      const routeType = req.query.route_type !== undefined ? parseInt(req.query.route_type as string, 10) : undefined;
      let since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;
      // Accept seconds or milliseconds (mirror Meshtastic packet routes).
      if (since !== undefined && since < 1e12) since = since * 1000;

      const query = {
        sourceId,
        offset,
        limit,
        payloadType: Number.isFinite(payloadType as number) ? payloadType : undefined,
        routeType: Number.isFinite(routeType as number) ? routeType : undefined,
        since: Number.isFinite(since as number) ? since : undefined,
      };

      const [packets, total, enabled, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getPackets(query),
        meshcorePacketLogService.getPacketCount({ sourceId, payloadType: query.payloadType, routeType: query.routeType, since: query.since }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);

      res.json({ packets, total, offset, limit, enabled, maxCount, maxAgeHours });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch packets' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/packets/stats
 *
 * Summary stats for the MeshCore Packet Monitor: total count, enabled flag,
 * and the retention limits.
 */
router.get(
  '/packets/stats',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const [total, enabled, maxCount, maxAgeHours] = await Promise.all([
        meshcorePacketLogService.getPacketCount({ sourceId }),
        meshcorePacketLogService.isEnabled(),
        meshcorePacketLogService.getMaxCount(),
        meshcorePacketLogService.getMaxAgeHours(),
      ]);
      res.json({ total, enabled, maxCount, maxAgeHours });
    } catch (error) {
      logger.error('[API] Error fetching MeshCore packet stats:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch packet stats' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/packets/export
 *
 * Export this source's OTA packet log as JSONL (newest first), honoring the
 * same payload_type / route_type / since filters as the list endpoint. Streams
 * one JSON object per line as an attachment download — the MeshCore analogue of
 * the Meshtastic packet-monitor export (issue #3391).
 */
router.get(
  '/packets/export',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const payloadType = req.query.payload_type !== undefined ? parseInt(req.query.payload_type as string, 10) : undefined;
      const routeType = req.query.route_type !== undefined ? parseInt(req.query.route_type as string, 10) : undefined;
      let since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;
      // Accept seconds or milliseconds (mirror the list endpoint).
      if (since !== undefined && since < 1e12) since = since * 1000;

      // Export every retained packet matching the filters (up to the cap).
      const maxCount = await meshcorePacketLogService.getMaxCount();
      const packets = await meshcorePacketLogService.getPackets({
        sourceId,
        offset: 0,
        limit: maxCount,
        payloadType: Number.isFinite(payloadType as number) ? payloadType : undefined,
        routeType: Number.isFinite(routeType as number) ? routeType : undefined,
        since: Number.isFinite(since as number) ? since : undefined,
      });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const hasActiveFilters = req.query.payload_type !== undefined ||
                               req.query.route_type !== undefined ||
                               req.query.since !== undefined;
      const filterInfo = hasActiveFilters ? '-filtered' : '';
      const filename = `meshcore-packet-monitor${filterInfo}-${timestamp}.jsonl`;

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      for (const packet of packets) {
        res.write(JSON.stringify(packet) + '\n');
      }
      res.end();
      logger.debug(`[API] Exported ${packets.length} MeshCore packets to ${filename}`);
    } catch (error) {
      logger.error('[API] Error exporting MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to export packets' });
    }
  },
);

/**
 * DELETE /api/sources/:id/meshcore/packets
 *
 * Clear this source's OTA packet log. Requires packetmonitor:write.
 */
router.delete(
  '/packets',
  requireAuth(),
  requirePermission('packetmonitor', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const deleted = await meshcorePacketLogService.clearPackets(sourceId);
      auditMeshcoreEvent(req, 'meshcore_packets_cleared', 'configuration', { sourceId, deleted });
      res.json({ success: true, deleted });
    } catch (error) {
      logger.error('[API] Error clearing MeshCore packets:', error);
      res.status(500).json({ success: false, error: 'Failed to clear packets' });
    }
  },
);

export default router;
