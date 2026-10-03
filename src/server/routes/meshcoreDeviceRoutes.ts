/**
 * MeshCore API Routes — device group
 *
 * Connection lifecycle + local-node status/stats/snapshot/info + advert.
 * Extracted verbatim from the former monolithic `meshcoreRoutes.ts`
 * (epic #3962 Task 4.3).
 */

import { Router, Request, Response } from 'express';
import { ConnectionType, MeshCoreDeviceType } from '../meshcoreManager.js';
import { getMeshCoreTelemetryPoller, nodeNumFromPubkey } from '../services/meshcoreTelemetryPoller.js';
import { logger } from '../../utils/logger.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';
import { resolveMeshcoreKeyAccess, filterKeyedMessages } from '../utils/meshcoreKeyAccess.js';
import { requireAuth, optionalAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import { managerFor, isValidConnectionParams, requireMeshcoreTx, failIfTxDisabled, stripPositions } from './meshcoreRouteShared.js';
import databaseService from '../../services/database.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  type MeshCoreAdvertMode,
  MESHCORE_ADVERT_MODES,
  DEFAULT_MESHCORE_ADVERT_MODE,
  isMeshCoreAdvertMode,
} from '../../types/meshcoreAdvert.js';
import { MeshCoreZeroHopAdvertUnsupportedError } from '../utils/meshcoreAdvert.js';
import { buildLocalContactRow, withoutLocalFlag, type MeshCoreContactResponse } from './meshcoreLocalContactRow.js';
import { applySignFlipToMeshCoreRows } from '../services/signFlipCorrection.js';
import { extendRequestTimeout } from '../middleware/requestTimeout.js';

/** Device connect: serial/TCP/BLE handshake + capability probe over RF. */
const CONNECT_TIMEOUT_MS = 90_000;

const router = Router({ mergeParams: true });

/**
 * GET /api/meshcore/status
 * Get connection status and local node info
 */
router.get('/status', optionalAuth(), requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req, res);
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
router.post('/connect', extendRequestTimeout(CONNECT_TIMEOUT_MS), meshcoreDeviceLimiter, requireAuth(), requirePermission('connection', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
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

    const manager = managerFor(req, res);
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
    await managerFor(req, res).disconnect();
    res.json({ success: true, message: 'Disconnected' });
  } catch (error) {
    logger.error('[API] Error disconnecting:', error);
    res.status(500).json({ success: false, error: 'Disconnect error' });
  }
});

/**
 * GET /api/sources/:id/meshcore/stats/:type
 *
 * Read local-node stats (core, radio, or packets). These hit the directly-
 * connected node over the local link — no RF transmission. Companion: the
 * companion protocol. Repeater: the serial CLI `stats-*` verbs (#5533).
 */
router.get(
  '/stats/:type',
  optionalAuth(),
  requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const manager = managerFor(req, res);
      const type = req.params.type;
      let data: any = null;
      if (type === 'core') data = await manager.getStatsCore();
      else if (type === 'radio') data = await manager.getStatsRadio();
      else if (type === 'packets') data = await manager.getStatsPackets();
      else {
        return res.status(400).json({ success: false, error: 'type must be core, radio, or packets' });
      }
      if (!data) {
        return res.status(409).json({ success: false, error: 'Stats unavailable — source disconnected, or the device did not answer' });
      }
      res.json({ success: true, data });
    } catch (error) {
      logger.error('[API] Error getting stats:', error);
      res.status(500).json({ success: false, error: 'Failed to get stats' });
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/snapshot
 * Single-call initial load: status, localNode, contacts, nodes, messages, and a seqCursor
 * (the timestamp of the newest message) for reconnect catch-up.
 *
 * The route itself is gated only by `connection:read` (a viewer needs that
 * just to see the source at all), but `messages` carries DM content, which
 * has its own, stricter `messages:read` grant ("Node Details & DM"). A
 * caller with `connection:read` but not `messages:read` — e.g. an anonymous
 * user given view-only status access — must not receive message content via
 * this bundled payload (issue #4422).
 */
router.get('/snapshot', optionalAuth(), requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req, res);
    const status = manager.getConnectionStatus();
    const localNode = manager.getLocalNode();
    const contacts = manager.getContacts();
    const nodes = await manager.getAllNodes();

    const sourceId = (req.params as { id: string }).id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4422 req.user is untyped on Express.Request, matches existing pattern (sourceRoutes.ts)
    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const canReadMessages = isAdmin || (user
      ? await databaseService.checkPermissionAsync(user.id, 'messages', 'read', sourceId)
      : false);
    // Ignore / Block (#5408): flag messages that match the CURRENT lists.
    // #5551: keyed (repeater-decrypted) rows need access to their key too.
    const messages = canReadMessages
      ? meshcoreMessageFilter.annotate(
          sourceId,
          filterKeyedMessages(manager.getRecentMessages(50), await resolveMeshcoreKeyAccess(user)),
          localNode?.publicKey,
        )
      : [];
    const seqCursor = messages.length > 0 ? Math.max(...messages.map(m => m.timestamp)) : 0;

    // Shares the local-row construction site with GET /contacts and
    // POST /contacts/refresh (#4438 / #4449) — see meshcoreLocalContactRow.ts.
    const allContacts: MeshCoreContactResponse[] = withoutLocalFlag(contacts);
    if (localNode && localNode.latitude && localNode.longitude) {
      allContacts.unshift(buildLocalContactRow(localNode));
    }

    // `connection:read` alone does not entitle a caller to positions on the
    // map — that additionally requires `nodes:viewOnMap`, mirroring the
    // messages gate above (issue #4559). Strip lat/lon rather than dropping
    // the rows so the contact list this snapshot also feeds keeps working.
    // Resolved once (not via maskContactPositionsForViewOnMap per array) —
    // it's the same user/source for both, so a second permission check would
    // just be a redundant DB round-trip on every snapshot request.
    const canViewOnMap = user ? await hasPermission(user, 'nodes', 'viewOnMap', sourceId) : false;
    // #5363: display-only sign-flip correction of the positions that remain.
    const maskedContacts = canViewOnMap ? await applySignFlipToMeshCoreRows(allContacts, sourceId) : stripPositions(allContacts);
    const maskedNodes = canViewOnMap ? await applySignFlipToMeshCoreRows(nodes, sourceId) : stripPositions(nodes);

    res.json({
      success: true,
      data: {
        status: {
          ...status,
          localNode,
          deviceTypeName: MeshCoreDeviceType[status.deviceType],
        },
        contacts: maskedContacts,
        nodes: maskedNodes,
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
 * Companion and Repeater (#5533; the repeater answers the serial CLI
 * `stats-*` verbs). For a Repeater, `telemetryRef.nodeId` is the real key from
 * `get public.key`, not the `'repeater'` placeholder in `identity.publicKey`,
 * and is null until that key has been read. Other device types get
 * `latest: null`.
 */
router.get('/info', optionalAuth(), requirePermission('connection', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const manager = managerFor(req, res);
    const status = manager.getConnectionStatus();
    const localNode = manager.getLocalNode();
    const poller = getMeshCoreTelemetryPoller();
    const snapshot = poller ? poller.getLastSnapshot(manager.sourceId) : undefined;

    const telemetryNodeId = localNode?.publicKey ? manager.getLocalTelemetryNodeId() : null;
    const telemetryRef = telemetryNodeId
      ? {
          nodeId: telemetryNodeId,
          nodeNum: nodeNumFromPubkey(telemetryNodeId),
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
 * POST /api/meshcore/advert
 * Send a self-advert. Body: `{ mode?: 'zero_hop' | 'flood' }` — missing means
 * zero_hop. A manual flood is never blocked by the automated flood floor, but
 * it does stamp the per-source last-flood time that the floor reads.
 * Requires authentication - broadcasts on mesh network
 */
router.post('/advert', meshcoreDeviceLimiter, requireAuth(), requirePermission('connection', 'write', { sourceIdFrom: 'params.id' }), requireMeshcoreTx(), async (req: Request, res: Response) => {
  const rawMode = (req.body as { mode?: unknown } | undefined)?.mode;
  if (rawMode !== undefined && !isMeshCoreAdvertMode(rawMode)) {
    fail(res, 400, 'INVALID_ADVERT_MODE', `mode must be one of: ${MESHCORE_ADVERT_MODES.join(', ')}`);
    return;
  }
  const mode: MeshCoreAdvertMode = rawMode ?? DEFAULT_MESHCORE_ADVERT_MODE;
  try {
    const success = await managerFor(req, res).sendAdvert(mode);

    if (success) {
      ok(res, { mode });
    } else {
      fail(res, 400, 'ADVERT_FAILED', 'Failed to send advert');
    }
  } catch (error) {
    if (failIfTxDisabled(res, error)) return;
    if (error instanceof MeshCoreZeroHopAdvertUnsupportedError) {
      fail(res, 409, error.code, error.message, { floodSent: error.floodSent });
      return;
    }
    logger.error('[API] Error sending advert:', error);
    fail(res, 500, 'ADVERT_ERROR', 'Advert error');
  }
});

export default router;
