/**
 * Read-only routes for a MeshCore MQTT ingest source (#5096).
 *
 * An ingest source has no device, so every existing `/meshcore/*` handler is
 * either unreachable to it (they sit behind `meshcoreRouteGuard`) or wrong for
 * it (`managerFor()` returns a device manager and the message read uses a
 * synchronous in-memory ring the ingest manager does not have).
 *
 * These two endpoints are what the ingest source page needs and nothing more.
 * They live under `/ingest/` so they can never shadow a device route, and they
 * refuse a device-backed source outright — a Companion has richer endpoints
 * already, and serving the same data twice invites the two to drift.
 *
 * Mounted BEFORE `meshcoreRouteGuard` in the barrel; see `anyMeshCoreRouteGuard`.
 */
import { resolveMeshcoreKeyAccess, filterKeyedMessages } from '../utils/meshcoreKeyAccess.js';
import { Router, type Request, type Response } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreMqttManager } from '../sourceManagerTypes.js';
import type { MeshCoreMqttManager } from '../meshcoreMqttManager.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';

const router = Router({ mergeParams: true });

const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 100;

/**
 * Resolve the ingest manager, or null for anything else.
 *
 * `anyMeshCoreRouteGuard` has already established this is *a* MeshCore source,
 * so a null here means device-backed, not missing.
 */
function ingestManagerFor(req: Request): MeshCoreMqttManager | null {
  const mgr = sourceManagerRegistry.getManager((req.params as { id?: string }).id ?? '');
  return mgr && isMeshCoreMqttManager(mgr) ? mgr : null;
}

/**
 * May this viewer see which broker the source connects to?
 *
 * The overview is gated on `nodes:read`, which the anonymous user often holds
 * so a public dashboard can list nodes. The broker host is source CONFIG, not
 * mesh data, so it takes the same grant as `GET /api/sources/:id`: a signed-in
 * user with `sources:read`, or an admin. Anonymous viewers never see it, even
 * if someone grants `sources:read` to the anonymous account — #5596 keeps the
 * host away from callers with no login.
 */
async function mayViewBrokerHost(req: Request): Promise<boolean> {
  const user = (req as Request & { user?: { id: number; username?: string; isAdmin?: boolean } }).user;
  if (!user || user.username === 'anonymous') return false;
  if (user.isAdmin === true) return true;
  return databaseService.checkPermissionAsync(user.id, 'sources', 'read');
}

function refuseDeviceSource(res: Response) {
  return fail(
    res,
    404,
    'NOT_AN_INGEST_SOURCE',
    'These routes serve MeshCore MQTT ingest sources only; a device-backed source has its own endpoints',
  );
}

/**
 * GET /api/sources/:id/meshcore/ingest/overview
 *
 * What the ingest source page needs for its header: which broker and region it
 * reads, whether it is connected, and the observers heard from — including each
 * observer's own battery / uptime / noise floor from its `/status` heartbeat.
 *
 * `region` is always present. `brokerUrl` is the redacted URL for a viewer who
 * may read source config, and null for everyone else.
 */
router.get(
  '/ingest/overview',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = ingestManagerFor(req);
      if (!mgr) return refuseDeviceSource(res);

      const status = mgr.getStatus();
      const observers = [...mgr.getObserverStatuses().entries()].map(([publicKey, snap]) => ({
        publicKey,
        online: snap.online,
        lastSeenMs: snap.at,
        batteryMv: snap.batteryMv ?? null,
        uptimeSecs: snap.uptimeSecs ?? null,
        noiseFloor: snap.noiseFloor ?? null,
      }));
      // Newest heartbeat first — an operator scanning this list wants the
      // observers that are actually reporting, not insertion order.
      observers.sort((a, b) => b.lastSeenMs - a.lastSeenMs);

      const nodes = await mgr.getAllNodes();

      // Region is the topic segment every observer publishes under — public by
      // nature. The broker host is not: see mayViewBrokerHost. The URL arrives
      // from the manager with any `user:password@` already redacted.
      const feed = mgr.getFeedEndpoint();
      const brokerUrl = (await mayViewBrokerHost(req)) ? feed.brokerUrl : null;

      return ok(res, {
        connected: mgr.isConnected(),
        status,
        region: feed.region,
        brokerUrl,
        nodeCount: nodes.length,
        observers,
      });
    } catch (error) {
      logger.error('[API] MeshCore ingest overview failed:', error);
      return fail(res, 500, 'INGEST_OVERVIEW_FAILED', 'Failed to build ingest overview');
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/ingest/nodes
 *
 * Every node this source learned from adverts. Distinct from
 * `/api/sources/:id/nodes`, which returns only POSITIONED nodes and requires
 * `nodes:viewOnMap` because it feeds maps — a node list wants the unpositioned
 * ones too.
 */
router.get(
  '/ingest/nodes',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = ingestManagerFor(req);
      if (!mgr) return refuseDeviceSource(res);
      const nodes = await mgr.getAllNodes();
      return ok(res, { nodes, count: nodes.length });
    } catch (error) {
      logger.error('[API] MeshCore ingest nodes failed:', error);
      return fail(res, 500, 'INGEST_NODES_FAILED', 'Failed to fetch ingest nodes');
    }
  },
);

/**
 * GET /api/sources/:id/meshcore/ingest/messages
 *
 * Channel messages this source decrypted. The device route cannot serve these:
 * it reads a synchronous in-memory ring, and an ingest manager persists
 * straight to the database instead (there is no session to keep a ring for).
 */
router.get(
  '/ingest/messages',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const mgr = ingestManagerFor(req);
      if (!mgr) return refuseDeviceSource(res);

      const raw = parseInt((req.query.limit as string) ?? '', 10);
      const limit =
        Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_MESSAGE_LIMIT) : DEFAULT_MESSAGE_LIMIT;

      // Ignore / Block (#5408): computed from the current lists at read time.
      const messages = meshcoreMessageFilter.annotate(
        (req.params as { id?: string }).id ?? '',
        // #5552: rows decrypted with a virtual-channel key need that grant.
        filterKeyedMessages(
          await mgr.getRecentMessagesAsync(limit),
          await resolveMeshcoreKeyAccess((req as Request & { user?: { id: number; isAdmin?: boolean } }).user),
        ),
      );
      return ok(res, { messages, count: messages.length });
    } catch (error) {
      logger.error('[API] MeshCore ingest messages failed:', error);
      return fail(res, 500, 'INGEST_MESSAGES_FAILED', 'Failed to fetch ingest messages');
    }
  },
);

export default router;
