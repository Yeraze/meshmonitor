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
 * Authentication: `GET /status` uses `optionalAuth()` only (mirrors the
 * generic `/api/sources/:id/status` route — a public connectivity probe).
 * Every other endpoint uses `requirePermission('sources', 'read'|'write',
 * { sourceIdFrom: 'params.id' })` per the build spec (§3.7), mirroring
 * `sourceRoutes.ts`'s own `'sources'`-resource checks.
 *
 * **Known caveat:** `'sources'` is a GLOBAL resource (not in
 * `SOURCEY_RESOURCES`, `src/types/permission.ts`), unlike the sourcey
 * resources the other new per-source route families use (`nodes` in
 * atakRoutes.ts, `packetmonitor` in mqttPacketRoutes.ts). So a `sources:read`
 * grant on one source authorizes every source for these endpoints —
 * `sourceIdFrom` does not achieve per-source ACCESS-CONTROL isolation here
 * (it is a no-op for a global resource's authorization decision, same as
 * `sourceRoutes.ts`'s own `'sources'`-gated endpoints). DATA isolation is
 * unaffected: every handler still queries `databaseService.reticulum`/
 * `databaseService.telemetry` scoped to the `:id` in the URL, so a source's
 * response can never contain another source's rows. See
 * `reticulumRoutes.test.ts`'s module comment for the full analysis; a
 * dedicated sourcey resource (new `ResourceType` + migration) would close
 * this gap but is out of scope for a routes-only WP.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isReticulumManager } from '../sourceManagerTypes.js';
import type { ReticulumManager } from '../reticulumManager.js';
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

/** Default lookback window for `GET /interfaces/:name/history` when `since` is omitted. */
const DEFAULT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  res.locals.reticulumManager = mgr && isReticulumManager(mgr) ? (mgr as ReticulumManager) : undefined;
  next();
}

router.use(reticulumRouteGuard);

/**
 * GET /status
 * Connectivity + inventory snapshot. `connected:false` (and no `mode`) when
 * no manager is registered for this source — a disconnected Reticulum
 * source still answers this route, it just reports itself as disconnected.
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

    const [destinations, interfaces] = await Promise.all([
      databaseService.reticulum.listDestinations(sourceId),
      databaseService.reticulum.listInterfaces(sourceId),
    ]);

    return ok(res, {
      connected,
      mode,
      interfaceCount: interfaces.length,
      destinationCount: destinations.length,
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
  requirePermission('sources', 'read', { sourceIdFrom: 'params.id' }),
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
  requirePermission('sources', 'read', { sourceIdFrom: 'params.id' }),
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
  requirePermission('sources', 'write', { sourceIdFrom: 'params.id' }),
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
  requirePermission('sources', 'read', { sourceIdFrom: 'params.id' }),
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
  requirePermission('sources', 'read', { sourceIdFrom: 'params.id' }),
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

export default router;
