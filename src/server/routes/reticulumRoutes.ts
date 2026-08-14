/**
 * Reticulum API Routes (#3960 Phase 1a WP6)
 *
 * RESTful endpoints for Reticulum destinations/interfaces, mounted at
 * `/api/sources/:id/reticulum` (nested `Router({ mergeParams: true })`,
 * mirroring `meshcoreRoutes.ts`'s pattern). See
 * `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §3.7.
 *
 * **Guard semantics differ from MeshCore.** A Reticulum source's manager is
 * REMOVED from the registry on disconnect (build spec §3.6/§7 risk 2) — that
 * is intentional, unlike MeshCore's keep-registered behavior. So the guard
 * below MUST NOT 404 when no manager is registered: it resolves the manager
 * into `res.locals.reticulumManager` (or leaves it `undefined`) and lets
 * every handler fall back to serving from the DB. Only `GET /status`
 * actually reads `res.locals.reticulumManager`; every other handler ignores
 * it entirely and reads straight from `databaseService.reticulum` /
 * `databaseService.telemetry`, so persisted rows keep serving indefinitely
 * after a disconnect.
 *
 * Authentication: `GET /status` uses `optionalAuth()` only (mirrors
 * MeshCore's status endpoint — low-sensitivity connection state, and the
 * generic `/api/sources/:id/status` route follows the same pattern). Every
 * other endpoint uses `requirePermission('nodes', 'read'|'write',
 * { sourceIdFrom: 'params.id' })`.
 *
 * **Resource choice (post-review correction).** The build spec (§3.7)
 * originally called for the `'sources'` resource, but that is a GLOBAL
 * resource (absent from `SOURCEY_RESOURCES`, `src/types/permission.ts`) —
 * `checkPermissionAsync` ignores the resolved `sourceId` for a global
 * resource's authorization decision, so a grant on one source would have
 * authorized every source (a real per-source access-control gap, since
 * CLAUDE.md's multi-source rules require permissions to be per-source).
 * `'nodes'` IS a sourcey resource, matching the precedent set by the other
 * new per-source route families: `atakRoutes.ts` uses `'nodes'` for its
 * per-source contact/node-list reads, and Reticulum destinations are the
 * direct analog (a per-source list of discovered network entities) — so
 * `'nodes'` is reused here rather than introducing a dedicated resource.
 * `sourceIdFrom: 'params.id'` now genuinely scopes access: a `nodes:read`
 * grant on source A does NOT authorize source B.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isReticulumManager } from '../sourceManagerTypes.js';
import type { ReticulumManager, SendReticulumMessageParams } from '../reticulumManager.js';
import { reticulumConfigFromSource } from '../reticulumConfig.js';
import {
  reticulumInterfaceNodeId,
  RETICULUM_IFACE_RX_RATE,
  RETICULUM_IFACE_TX_RATE,
} from '../services/reticulumTelemetry.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import type { ListDestinationsOptions } from '../../db/repositories/reticulum.js';
import type { LxmfMethod } from '../reticulumProtocol.js';

/** Default lookback window for `GET /interfaces/:name/history` when `since` is omitted. */
const DEFAULT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Valid `POST /messages` `method` values — mirrors `LxmfMethod` (reticulumProtocol.ts). */
const VALID_LXMF_METHODS: ReadonlySet<string> = new Set<LxmfMethod>([
  'opportunistic',
  'direct',
  'propagated',
  'paper',
]);

const router = Router({ mergeParams: true });

/**
 * Router-level guard: resolves the Reticulum manager for `:id` into
 * `res.locals.reticulumManager`, narrowed by `isReticulumManager`. Unlike
 * `meshcoreRouteGuard`, this NEVER 404s on a missing manager — it sets
 * `res.locals.reticulumManager = undefined` and calls `next()` so read
 * handlers can serve from the DB. Only a missing `:id` route param (which
 * should not happen given the mount point, but is defensive) is rejected.
 */
function reticulumRouteGuard(req: Request, res: Response, next: NextFunction) {
  const sourceId = (req.params as { id?: string }).id;
  if (!sourceId) {
    return fail(res, 404, 'MISSING_SOURCE_ID', 'Reticulum routes must be mounted under /api/sources/:id/reticulum');
  }
  const mgr = sourceManagerRegistry.getManager(sourceId);
  res.locals.reticulumManager = mgr && isReticulumManager(mgr) ? mgr : undefined;
  next();
}

router.use(reticulumRouteGuard);

/**
 * GET /status
 * Connectivity + inventory snapshot. `connected:false` (and no `mode`) when
 * no manager is registered for this source — a disconnected Reticulum
 * source still answers this route, it just reports itself as disconnected.
 * `rnsVersion`/`bridgeVersion` (#3960 Phase 1b WP-B) come from the manager's
 * cached `welcome`/`status` handshake fields: omitted when no manager is
 * registered, `null` when a manager is registered but hasn't completed its
 * handshake yet.
 */
router.get('/status', optionalAuth(), async (req: Request, res: Response) => {
  const sourceId = (req.params as { id: string }).id;
  try {
    const manager = res.locals.reticulumManager as ReticulumManager | undefined;
    const connected = manager ? manager.isConnected() : false;

    let mode: 'attach' | 'tcp_peer' | undefined;
    try {
      const source = await databaseService.sources.getSource(sourceId);
      if (source) {
        const cfg = reticulumConfigFromSource(source);
        if (cfg) mode = cfg.mode;
      }
    } catch (err) {
      // Non-fatal — status still reports connected/counts without a mode.
      logger.debug(`[Reticulum:${sourceId}] status: failed to resolve source config: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }

    const [destinationCount, interfaceCount] = await Promise.all([
      databaseService.reticulum.countDestinations(sourceId),
      databaseService.reticulum.countInterfaces(sourceId),
    ]);

    // WP-B: bridge/RNS versions cached by the manager from the welcome/status
    // handshake. undefined (dropped from the JSON body) when no manager is
    // registered; null when a manager is registered but hasn't connected yet.
    const rnsVersion = manager ? manager.getRnsVersion() : undefined;
    const bridgeVersion = manager ? manager.getBridgeVersion() : undefined;

    return ok(res, {
      connected,
      mode,
      interfaceCount,
      destinationCount,
      rnsVersion,
      bridgeVersion,
    });
  } catch (err) {
    logger.error(`[Reticulum:${sourceId}] Error building status: ${err instanceof Error ? err.message : String(err)}`);
    return fail(res, 500, 'RETICULUM_STATUS_FAILED', 'Failed to get Reticulum status');
  }
});

/**
 * GET /destinations
 * List destinations for this source. Optional query filters: `favorite`
 * ("true" to restrict to favorites), `appName`, `limit`.
 */
router.get(
  '/destinations',
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    try {
      const opts: ListDestinationsOptions = {};
      if (req.query.favorite === 'true') opts.favoriteOnly = true;
      if (typeof req.query.appName === 'string' && req.query.appName.length > 0) {
        opts.appName = req.query.appName;
      }
      if (typeof req.query.limit === 'string') {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0) opts.limit = n;
      }
      const rows = await databaseService.reticulum.listDestinations(sourceId, opts);
      return ok(res, rows);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error listing destinations: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_DESTINATIONS_LIST_FAILED', 'Failed to list Reticulum destinations');
    }
  },
);

/**
 * GET /destinations/:hash
 */
router.get(
  '/destinations/:hash',
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const hash = req.params.hash;
    try {
      const row = await databaseService.reticulum.getDestination(sourceId, hash);
      if (!row) {
        return fail(res, 404, 'DESTINATION_NOT_FOUND', `No Reticulum destination ${hash} for source ${sourceId}`);
      }
      return ok(res, row);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error getting destination ${hash}: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_DESTINATION_GET_FAILED', 'Failed to get Reticulum destination');
    }
  },
);

/**
 * POST /destinations/:hash/favorite
 * Body: `{ favorite: boolean }`.
 */
router.post(
  '/destinations/:hash/favorite',
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const hash = req.params.hash;
    const { favorite } = (req.body ?? {}) as { favorite?: unknown };
    if (typeof favorite !== 'boolean') {
      return fail(res, 400, 'INVALID_FAVORITE', 'body.favorite must be a boolean');
    }
    try {
      const existing = await databaseService.reticulum.getDestination(sourceId, hash);
      if (!existing) {
        return fail(res, 404, 'DESTINATION_NOT_FOUND', `No Reticulum destination ${hash} for source ${sourceId}`);
      }
      await databaseService.reticulum.setDestinationFavorite(sourceId, hash, favorite);
      return ok(res, { destinationHash: hash, isFavorite: favorite });
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error setting favorite for ${hash}: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_DESTINATION_FAVORITE_FAILED', 'Failed to set Reticulum destination favorite');
    }
  },
);

/**
 * GET /interfaces
 */
router.get(
  '/interfaces',
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    try {
      const rows = await databaseService.reticulum.listInterfaces(sourceId);
      return ok(res, rows);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error listing interfaces: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_INTERFACES_LIST_FAILED', 'Failed to list Reticulum interfaces');
    }
  },
);

/**
 * GET /interfaces/:name/history
 * Throughput series (tx/rx rate samples) for one interface, read from the
 * shared `telemetry` table via the synthetic `rns:iface:<name>` nodeId
 * (see `reticulumTelemetry.ts`). Optional query params: `since` (epoch ms,
 * defaults to a 24h lookback), `limit`.
 */
router.get(
  '/interfaces/:name/history',
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const name = req.params.name;
    try {
      const iface = await databaseService.reticulum.getInterface(sourceId, name);
      if (!iface) {
        return fail(res, 404, 'INTERFACE_NOT_FOUND', `No Reticulum interface ${name} for source ${sourceId}`);
      }

      const sinceParam = typeof req.query.since === 'string' ? parseInt(req.query.since, 10) : NaN;
      const since = Number.isFinite(sinceParam) ? sinceParam : Date.now() - DEFAULT_HISTORY_WINDOW_MS;

      const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

      const nodeId = reticulumInterfaceNodeId(name);
      const samples = await databaseService.telemetry.getSignalTrendSamples(
        nodeId,
        [RETICULUM_IFACE_TX_RATE, RETICULUM_IFACE_RX_RATE],
        since,
        sourceId,
        limit,
      );

      return ok(res, { interfaceName: name, since, samples });
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error getting interface history for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_INTERFACE_HISTORY_FAILED', 'Failed to get Reticulum interface history');
    }
  },
);

// ==========================================================================
// LXMF messages/propagation/identity (#3960 Phase 2 WP4)
//
// Resource: 'messages' (sourcey — see build spec §0 R2, unlike the
// destinations/interfaces routes above which reuse 'nodes'). Read routes
// (GET /messages*, GET /threads/:threadHash) serve straight from the DB and
// tolerate an absent manager, same as the Phase 1a read routes. Write routes
// (POST/PUT) need a live bridge connection and 409 SOURCE_NOT_CONNECTED when
// `res.locals.reticulumManager` is undefined.
// ==========================================================================

/**
 * GET /messages
 * Conversations list (latest message per peer), newest-first. Uses this
 * source's own LXMF destination hash — when a manager is registered and has
 * cached one (`getOwnAddresses()`) — to disambiguate which side of each row
 * is "the peer"; falls back to state-based inference (see
 * `ReticulumRepository.listConversations`'s doc) when no manager/hash is
 * available, e.g. a disconnected source still serving persisted rows.
 */
router.get(
  '/messages',
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    try {
      const manager = res.locals.reticulumManager as ReticulumManager | undefined;
      const selfHash = manager?.getOwnAddresses()[0];
      const rows = await databaseService.reticulum.listConversations(sourceId, selfHash);
      return ok(res, rows);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error listing conversations: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_MESSAGES_LIST_FAILED', 'Failed to list Reticulum conversations');
    }
  },
);

/**
 * GET /messages/:peerHash
 * One conversation's messages, newest-first. Optional query params: `before`
 * (ms-epoch cursor, strictly-older pagination), `limit` (default 50, set by
 * the repository).
 */
router.get(
  '/messages/:peerHash',
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const peerHash = req.params.peerHash;
    try {
      const opts: { before?: number; limit?: number } = {};
      if (typeof req.query.before === 'string') {
        const n = parseInt(req.query.before, 10);
        if (Number.isFinite(n)) opts.before = n;
      }
      if (typeof req.query.limit === 'string') {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0) opts.limit = n;
      }
      const rows = await databaseService.reticulum.listMessages(sourceId, peerHash, opts);
      return ok(res, rows);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error listing messages for ${peerHash}: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_MESSAGES_GET_FAILED', 'Failed to get Reticulum conversation');
    }
  },
);

/**
 * GET /threads/:threadHash
 * A message thread (LXMF `fields.thread` marker), chronological.
 */
router.get(
  '/threads/:threadHash',
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const threadHash = req.params.threadHash;
    try {
      const rows = await databaseService.reticulum.listThread(sourceId, threadHash);
      return ok(res, rows);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error listing thread ${threadHash}: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_THREAD_GET_FAILED', 'Failed to get Reticulum thread');
    }
  },
);

/**
 * POST /messages
 * Send an LXMF message. Body: `{ to, content, title?, fields?, method?, replyToHash? }`.
 * Requires a live manager — 409 SOURCE_NOT_CONNECTED when this source has no
 * registered Reticulum manager (disconnected). Returns the created/optimistic
 * row from `ReticulumManager.sendMessage` (reconciled to its real LXM hash by
 * the time this resolves).
 */
router.post(
  '/messages',
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      to?: unknown;
      content?: unknown;
      title?: unknown;
      fields?: unknown;
      method?: unknown;
      replyToHash?: unknown;
    };

    if (typeof body.to !== 'string' || body.to.length === 0) {
      return fail(res, 400, 'INVALID_TO', 'body.to must be a non-empty string');
    }
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return fail(res, 400, 'INVALID_CONTENT', 'body.content must be a non-empty string');
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      return fail(res, 400, 'INVALID_TITLE', 'body.title must be a string');
    }
    if (
      body.fields !== undefined &&
      (typeof body.fields !== 'object' || body.fields === null || Array.isArray(body.fields))
    ) {
      return fail(res, 400, 'INVALID_FIELDS', 'body.fields must be an object');
    }
    if (body.method !== undefined && (typeof body.method !== 'string' || !VALID_LXMF_METHODS.has(body.method))) {
      return fail(res, 400, 'INVALID_METHOD', `body.method must be one of: ${Array.from(VALID_LXMF_METHODS).join(', ')}`);
    }
    if (body.replyToHash !== undefined && typeof body.replyToHash !== 'string') {
      return fail(res, 400, 'INVALID_REPLY_TO_HASH', 'body.replyToHash must be a string');
    }

    const manager = res.locals.reticulumManager as ReticulumManager | undefined;
    if (!manager) {
      return fail(res, 409, 'SOURCE_NOT_CONNECTED', `Reticulum source ${sourceId} has no active connection`);
    }

    try {
      const params: SendReticulumMessageParams = {
        to: body.to,
        content: body.content,
        title: body.title as string | undefined,
        fields: body.fields as Record<string, unknown> | undefined,
        method: body.method as LxmfMethod | undefined,
        replyToHash: body.replyToHash as string | undefined,
      };
      const row = await manager.sendMessage(params);
      return ok(res, row);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error sending message: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_SEND_FAILED', 'Failed to send Reticulum message');
    }
  },
);

/**
 * POST /propagation/sync
 * Trigger a best-effort propagation-node message pickup (`sync_propagation`).
 */
router.post(
  '/propagation/sync',
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const manager = res.locals.reticulumManager as ReticulumManager | undefined;
    if (!manager) {
      return fail(res, 409, 'SOURCE_NOT_CONNECTED', `Reticulum source ${sourceId} has no active connection`);
    }
    try {
      await manager.syncPropagation();
      return ok(res);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error syncing propagation: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_PROPAGATION_SYNC_FAILED', 'Failed to sync Reticulum propagation node');
    }
  },
);

/**
 * PUT /propagation/node
 * Body: `{ destHash: string|null }`. `null` is accepted at the type level
 * (matching the build spec's route contract) but currently rejected with a
 * 400 — the bridge (`RNSManager.set_propagation_node`) has no wire-level
 * "clear" operation, it raises on a falsy destination hash. Only a non-empty
 * string destination hash can be applied today.
 */
router.put(
  '/propagation/node',
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const { destHash } = (req.body ?? {}) as { destHash?: unknown };

    if (destHash !== null && typeof destHash !== 'string') {
      return fail(res, 400, 'INVALID_DEST_HASH', 'body.destHash must be a string or null');
    }
    if (destHash === null || destHash.length === 0) {
      return fail(
        res,
        400,
        'PROPAGATION_NODE_CLEAR_UNSUPPORTED',
        'Clearing the propagation node is not supported — body.destHash must be a non-empty destination hash',
      );
    }

    const manager = res.locals.reticulumManager as ReticulumManager | undefined;
    if (!manager) {
      return fail(res, 409, 'SOURCE_NOT_CONNECTED', `Reticulum source ${sourceId} has no active connection`);
    }

    try {
      await manager.setPropagationNode(destHash);
      return ok(res, { destinationHash: destHash });
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error setting propagation node: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_PROPAGATION_NODE_FAILED', 'Failed to set Reticulum propagation node');
    }
  },
);

/**
 * GET /identity
 * PUBLIC info only (build spec §0 R2/R5): `{ destinationHash, displayName }`.
 * NEVER a private key — there is deliberately no Node route for that (backup
 * = the bridge's `LXMF_STORAGE_DIR` volume, per R5). Degrades gracefully
 * (both fields `null`) rather than erroring when no manager is registered —
 * mirrors `GET /status`'s disconnected-source behavior.
 */
router.get(
  '/identity',
  requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const manager = res.locals.reticulumManager as ReticulumManager | undefined;
    if (!manager) {
      return ok(res, { destinationHash: null, displayName: null });
    }
    try {
      const identity = await manager.getIdentity();
      return ok(res, identity);
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error getting identity: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_IDENTITY_FAILED', 'Failed to get Reticulum identity');
    }
  },
);

/**
 * PUT /display-name
 * Body: `{ name: string }`.
 */
router.put(
  '/display-name',
  requirePermission('messages', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    const sourceId = (req.params as { id: string }).id;
    const { name } = (req.body ?? {}) as { name?: unknown };
    if (typeof name !== 'string' || name.length === 0) {
      return fail(res, 400, 'INVALID_NAME', 'body.name must be a non-empty string');
    }

    const manager = res.locals.reticulumManager as ReticulumManager | undefined;
    if (!manager) {
      return fail(res, 409, 'SOURCE_NOT_CONNECTED', `Reticulum source ${sourceId} has no active connection`);
    }

    try {
      await manager.setDisplayName(name);
      return ok(res, { displayName: name });
    } catch (err) {
      logger.error(`[Reticulum:${sourceId}] Error setting display name: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'RETICULUM_DISPLAY_NAME_FAILED', 'Failed to set Reticulum display name');
    }
  },
);

export default router;
