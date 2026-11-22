/**
 * MeshCore location override routes (#5842), shared by device-backed and
 * MQTT ingest/broker sources (#6531).
 *
 *   GET/POST/DELETE  /api/sources/:id/meshcore/nodes/:publicKey/position-override
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { isValidPublicKey } from './meshcoreRouteShared.js';
import { ok, fail } from '../utils/apiResponse.js';
import type { ISourceManager } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';

const router = Router({ mergeParams: true });

/**
 * Location override for one MeshCore contact (#5842), parity with the
 * Meshtastic `/api/nodes/:nodeId/position-override` routes.
 *
 * MeshMonitor-only: the override lives in `meshcore_nodes` (migration 206)
 * and nothing is sent to the radio, so a Companion, a Repeater and an MQTT
 * ingest/broker source all behave the same and the routes do not need a
 * connection. That is why they sit on the DATA side of the barrel, behind
 * `anyMeshCoreRouteGuard` (#6531): an MQTT observer never hears its own
 * adverts, so the override is the only way to put it on the map. Advert ingest
 * keeps writing the advert `latitude`/`longitude`; read sides apply the
 * override over them (`src/server/utils/meshcorePositionOverride.ts`).
 *
 * Editing takes the same per-source permission as the Meshtastic route,
 * `nodes:write` on the source, behind `requireAuth()` like every MeshCore
 * write route (so the anonymous account cannot edit it). Reading takes `nodes:read`; the coordinates
 * additionally need `nodes:viewOnMap`, and a private override's coordinates
 * need `nodes_private:read`, both on this source.
 */
router.get(
  '/nodes/:publicKey/position-override',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'Invalid public key format (expected 64-character hex string)');
      }
      const override = await databaseService.meshcore.getNodePositionOverride(sourceId, publicKey);
      const data = {
        publicKey,
        enabled: override?.enabled ?? false,
        isPrivate: override?.isPrivate ?? false,
        latitude: override?.latitude,
        longitude: override?.longitude,
        altitude: override?.altitude,
      };
      const user = req.user ?? null;
      const canViewOnMap = !!user && await hasPermission(user, 'nodes', 'viewOnMap', sourceId);
      const canViewPrivate = !!user && await hasPermission(user, 'nodes_private', 'read', sourceId);
      if (!canViewOnMap || (data.isPrivate && !canViewPrivate)) {
        delete data.latitude;
        delete data.longitude;
        delete data.altitude;
      }
      return ok(res, data);
    } catch (error) {
      logger.error('[API] Error reading MeshCore position override:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to get position override');
    }
  },
);

router.post(
  '/nodes/:publicKey/position-override',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'Invalid public key format (expected 64-character hex string)');
      }
      const { enabled, latitude, longitude, altitude, isPrivate } = req.body ?? {};
      if (typeof enabled !== 'boolean') {
        return fail(res, 400, 'INVALID_PARAMETER_TYPE', 'enabled must be a boolean');
      }
      if (isPrivate !== undefined && typeof isPrivate !== 'boolean') {
        return fail(res, 400, 'INVALID_PARAMETER_TYPE', 'isPrivate must be a boolean');
      }
      if (enabled) {
        if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
          return fail(res, 400, 'INVALID_LATITUDE', 'Latitude must be a number between -90 and 90');
        }
        if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
          return fail(res, 400, 'INVALID_LONGITUDE', 'Longitude must be a number between -180 and 180');
        }
        if (altitude !== undefined && altitude !== null && (typeof altitude !== 'number' || !Number.isFinite(altitude))) {
          return fail(res, 400, 'INVALID_ALTITUDE', 'Altitude must be a number');
        }
      }

      // The node must be known to this source: a stored row, or (device
      // sources only) a live contact. A live-only contact gets its identity
      // row first, so the override does not land on a nameless stub (mirrors
      // the favorite route). An ingest source has no contact list; every node
      // it knows, observers included, already has a stored row.
      const existing = await databaseService.meshcore.getNodeByPublicKeyAndSource(publicKey, sourceId);
      if (!existing) {
        const mgr = res.locals.meshcoreAnyManager as ISourceManager | undefined;
        const contact = mgr && isMeshCoreManager(mgr) ? mgr.getContact(publicKey) : undefined;
        if (!contact) {
          return fail(res, 404, 'NODE_NOT_FOUND', 'Node not found on this source');
        }
        await databaseService.meshcore.upsertNode(
          {
            publicKey,
            name: contact.advName ?? contact.name ?? null,
            advType: contact.advType ?? null,
            lastHeard: contact.lastSeen ?? null,
          },
          sourceId,
        );
      }

      await databaseService.meshcore.setNodePositionOverride(sourceId, publicKey, {
        enabled,
        latitude: enabled ? latitude : null,
        longitude: enabled ? longitude : null,
        altitude: enabled && typeof altitude === 'number' ? altitude : null,
        isPrivate: enabled ? isPrivate === true : false,
      });

      return ok(res, {
        publicKey,
        sourceId,
        enabled,
        latitude: enabled ? latitude : null,
        longitude: enabled ? longitude : null,
        altitude: enabled && typeof altitude === 'number' ? altitude : null,
        isPrivate: enabled ? isPrivate === true : false,
      });
    } catch (error) {
      logger.error('[API] Error setting MeshCore position override:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to set position override');
    }
  },
);

router.delete(
  '/nodes/:publicKey/position-override',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id: string }).id;
      const { publicKey } = req.params;
      if (!isValidPublicKey(publicKey)) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'Invalid public key format (expected 64-character hex string)');
      }
      await databaseService.meshcore.clearNodePositionOverride(sourceId, publicKey);
      return ok(res, { publicKey, sourceId, enabled: false });
    } catch (error) {
      logger.error('[API] Error clearing MeshCore position override:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear position override');
    }
  },
);

export default router;
