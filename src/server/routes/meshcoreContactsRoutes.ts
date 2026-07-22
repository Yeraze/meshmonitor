/**
 * MeshCore API Routes — contacts group
 *
 * Nodes/contacts listing, position history, discovery (node + region),
 * path management (reset/discover/trace/out-path), share/remove/export/
 * import, neighbours (remote query + stored), per-node telemetry-config/
 * poll, and favorite toggle. Extracted verbatim from the former
 * monolithic `meshcoreRoutes.ts` (epic #3962 Task 4.3).
 */

import { Router, Request, Response } from 'express';
import { MeshCoreDiscoverFilter, type MeshCoreDiscoverMode } from '../meshcoreManager.js';
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_BETWEEN_REQUESTS_MS,
  getMeshCoreRemoteTelemetryScheduler,
} from '../services/meshcoreRemoteTelemetryScheduler.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { meshcoreDeviceLimiter } from '../middleware/rateLimiters.js';
import meshcorePositionHistoryService from '../services/meshcorePositionHistoryService.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { managerFor, isValidPublicKey, auditMeshcoreEvent, parseHexPathChain } from './meshcoreRouteShared.js';

const router = Router({ mergeParams: true });

/**
 * GET /api/meshcore/nodes
 * Get all known nodes (local + contacts)
 */
router.get('/nodes', optionalAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const nodes = await managerFor(req, res).getAllNodes();
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
    const manager = managerFor(req, res);
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
    const contacts = await managerFor(req, res).refreshContacts();
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
      const ok = await managerFor(req, res).resetContactPath(publicKey);
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
      const ok = await managerFor(req, res).discoverContactPath(publicKey);
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
      const { returned, newCount } = await managerFor(req, res).discoverNodes(filter, 8000, true);
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
      const result = await managerFor(req, res).discoverRegions();
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('[API] Error discovering regions:', error);
      res.status(500).json({ success: false, error: 'Failed to discover regions' });
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
      const result = await managerFor(req, res).traceContactPath(publicKey);
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
      const ok = await managerFor(req, res).setContactOutPath(publicKey, parsed, hashBytes);
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
      const result = await managerFor(req, res).shareContact(publicKey);
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
      const manager = managerFor(req, res);
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
      const bytes = await managerFor(req, res).exportContact(isSelf ? null : publicKey);
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
      const ok = await managerFor(req, res).importContact(advertBytes);
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
      const manager = managerFor(req, res);
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

      const manager = managerFor(req, res);
      if (!manager.isConnected()) {
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
      const manager = managerFor(req, res);
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
                && !isBogusPosition(contact.latitude, contact.longitude))
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
      const manager = managerFor(req, res);
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
                && !isBogusPosition(contact.latitude, contact.longitude))
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

// ---------------------------------------------------------------------------
// POST /api/sources/:id/meshcore/neighbors/request
// Request neighbor data from a MeshCore repeater (remote or local).
// ---------------------------------------------------------------------------

router.post('/neighbors/request', meshcoreDeviceLimiter, requireAuth(), requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  const sourceId = (req.params as { id?: string }).id!;
  const { publicKey } = req.body as { publicKey?: string };

  try {
    const manager = managerFor(req, res);

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

export default router;
