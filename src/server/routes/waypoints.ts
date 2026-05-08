/**
 * Waypoint routes
 *
 * Mounted at `/api/sources/:id/waypoints` via `sourceRoutes.ts`. Every
 * endpoint is gated by the `waypoints` permission scoped to the path's
 * `:id` (source id). Mutating endpoints additionally enforce the
 * `lockedTo` invariant via `waypointService.update` / `deleteLocal`.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { waypointService } from '../services/waypointService.js';

// `mergeParams` lets us read `:id` from the parent (sourceRoutes) router.
const router = Router({ mergeParams: true });

function getSourceId(req: Request): string | null {
  const id = req.params?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function parseBbox(query: any): { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined {
  const raw = query?.bbox;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parts = raw.split(',').map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [minLat, minLon, maxLat, maxLon] = parts;
  return { minLat, maxLat, minLon, maxLon };
}

function badRequest(res: Response, message: string) {
  return res.status(400).json({ error: message, code: 'BAD_REQUEST' });
}

// GET /api/sources/:id/waypoints?includeExpired=&bbox=minLat,minLon,maxLat,maxLon
router.get(
  '/',
  requirePermission('waypoints', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = getSourceId(req);
      if (!sourceId) return badRequest(res, 'sourceId is required');

      const source = await databaseService.sources.getSource(sourceId);
      if (!source) return res.status(404).json({ error: 'Source not found' });

      const includeExpired = req.query.includeExpired === 'true' || req.query.includeExpired === '1';
      const bbox = parseBbox(req.query);

      const waypoints = await waypointService.list(sourceId, { includeExpired, bbox });
      res.json({ success: true, data: waypoints });
    } catch (error) {
      logger.error('Error listing waypoints:', error);
      res.status(500).json({ error: 'Failed to list waypoints' });
    }
  },
);

// POST /api/sources/:id/waypoints
router.post(
  '/',
  requirePermission('waypoints', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = getSourceId(req);
      if (!sourceId) return badRequest(res, 'sourceId is required');

      const source = await databaseService.sources.getSource(sourceId);
      if (!source) return res.status(404).json({ error: 'Source not found' });

      const body = req.body ?? {};
      const lat = Number(body.lat ?? body.latitude);
      const lon = Number(body.lon ?? body.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return badRequest(res, 'lat and lon are required numeric fields');
      }
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return badRequest(res, 'lat/lon out of range');
      }

      const name = typeof body.name === 'string' ? body.name : '';
      const description = typeof body.description === 'string' ? body.description : '';
      const icon = body.icon === undefined || body.icon === null
        ? null
        : typeof body.icon === 'number' || typeof body.icon === 'string'
          ? body.icon
          : null;
      const expireAt = body.expire === undefined || body.expire === null
        ? null
        : Number.isFinite(Number(body.expire))
          ? Number(body.expire)
          : null;
      const lockedTo = body.locked_to === undefined || body.locked_to === null
        ? null
        : Number(body.locked_to);
      const virtual = Boolean(body.virtual);
      const rebroadcastIntervalS = body.rebroadcast_interval_s === undefined || body.rebroadcast_interval_s === null
        ? null
        : Number(body.rebroadcast_interval_s);

      // Best-effort: use the source's local node as the owner. Fallback to 0
      // when the manager isn't reachable (still records, owner_node_num NULL).
      const manager = sourceManagerRegistry.getManager(sourceId);
      const ownerNodeNum = manager?.getLocalNodeInfo()?.nodeNum ?? 0;

      const persisted = await waypointService.createLocal(
        sourceId,
        ownerNodeNum,
        {
          latitude: lat,
          longitude: lon,
          name,
          description,
          icon,
          expireAt,
          lockedTo,
          rebroadcastIntervalS,
        },
        { virtual },
      );

      // Broadcast unless this is a virtual-only entry. Errors are logged but
      // do not surface to the caller — the waypoint is already persisted and
      // the rebroadcast scheduler (follow-up PR) will retry.
      if (!virtual && manager && typeof (manager as any).broadcastWaypoint === 'function') {
        try {
          await (manager as any).broadcastWaypoint({
            id: persisted.waypointId,
            latitude: persisted.latitude,
            longitude: persisted.longitude,
            expire: persisted.expireAt ?? 0,
            lockedTo: persisted.lockedTo ?? 0,
            name: persisted.name,
            description: persisted.description,
            icon: persisted.iconCodepoint ?? 0,
          });
        } catch (err) {
          logger.warn(`Failed to broadcast new waypoint ${persisted.waypointId}:`, err);
        }
      }

      res.status(201).json({ success: true, data: persisted });
    } catch (error) {
      logger.error('Error creating waypoint:', error);
      res.status(500).json({ error: 'Failed to create waypoint' });
    }
  },
);

// PATCH /api/sources/:id/waypoints/:waypointId
router.patch(
  '/:waypointId',
  requirePermission('waypoints', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = getSourceId(req);
      if (!sourceId) return badRequest(res, 'sourceId is required');

      const waypointId = Number(req.params.waypointId);
      if (!Number.isFinite(waypointId)) return badRequest(res, 'invalid waypointId');

      const source = await databaseService.sources.getSource(sourceId);
      if (!source) return res.status(404).json({ error: 'Source not found' });

      const manager = sourceManagerRegistry.getManager(sourceId);
      const callerNodeNum = manager?.getLocalNodeInfo()?.nodeNum ?? 0;

      const body = req.body ?? {};
      const fields: any = {};
      if (body.lat !== undefined || body.latitude !== undefined) {
        fields.latitude = Number(body.lat ?? body.latitude);
      }
      if (body.lon !== undefined || body.longitude !== undefined) {
        fields.longitude = Number(body.lon ?? body.longitude);
      }
      if (body.name !== undefined) fields.name = String(body.name);
      if (body.description !== undefined) fields.description = String(body.description);
      if (body.icon !== undefined) fields.icon = body.icon;
      if (body.expire !== undefined) {
        fields.expireAt = body.expire === null ? null : Number(body.expire);
      }
      if (body.locked_to !== undefined) {
        fields.lockedTo = body.locked_to === null ? null : Number(body.locked_to);
      }
      if (body.rebroadcast_interval_s !== undefined) {
        fields.rebroadcastIntervalS =
          body.rebroadcast_interval_s === null ? null : Number(body.rebroadcast_interval_s);
      }

      let persisted;
      try {
        persisted = await waypointService.update(sourceId, waypointId, callerNodeNum, fields);
      } catch (err: any) {
        if (/locked to/i.test(err?.message ?? '')) {
          return res.status(403).json({ error: err.message, code: 'LOCKED' });
        }
        if (/not found/i.test(err?.message ?? '')) {
          return res.status(404).json({ error: err.message });
        }
        throw err;
      }

      if (!persisted.isVirtual && manager && typeof (manager as any).broadcastWaypoint === 'function') {
        try {
          await (manager as any).broadcastWaypoint({
            id: persisted.waypointId,
            latitude: persisted.latitude,
            longitude: persisted.longitude,
            expire: persisted.expireAt ?? 0,
            lockedTo: persisted.lockedTo ?? 0,
            name: persisted.name,
            description: persisted.description,
            icon: persisted.iconCodepoint ?? 0,
          });
        } catch (err) {
          logger.warn(`Failed to broadcast updated waypoint ${persisted.waypointId}:`, err);
        }
      }

      res.json({ success: true, data: persisted });
    } catch (error) {
      logger.error('Error updating waypoint:', error);
      res.status(500).json({ error: 'Failed to update waypoint' });
    }
  },
);

// DELETE /api/sources/:id/waypoints/:waypointId
router.delete(
  '/:waypointId',
  requirePermission('waypoints', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = getSourceId(req);
      if (!sourceId) return badRequest(res, 'sourceId is required');

      const waypointId = Number(req.params.waypointId);
      if (!Number.isFinite(waypointId)) return badRequest(res, 'invalid waypointId');

      const source = await databaseService.sources.getSource(sourceId);
      if (!source) return res.status(404).json({ error: 'Source not found' });

      const manager = sourceManagerRegistry.getManager(sourceId);
      const callerNodeNum = manager?.getLocalNodeInfo()?.nodeNum ?? 0;

      const existing = await databaseService.waypoints.getAsync(sourceId, waypointId);
      if (!existing) return res.status(404).json({ error: 'Waypoint not found' });

      let removed = false;
      try {
        removed = await waypointService.deleteLocal(sourceId, waypointId, callerNodeNum);
      } catch (err: any) {
        if (/locked to/i.test(err?.message ?? '')) {
          return res.status(403).json({ error: err.message, code: 'LOCKED' });
        }
        throw err;
      }

      if (removed && !existing.isVirtual && manager && typeof (manager as any).broadcastWaypointDelete === 'function') {
        try {
          await (manager as any).broadcastWaypointDelete(waypointId);
        } catch (err) {
          logger.warn(`Failed to broadcast waypoint delete ${waypointId}:`, err);
        }
      }

      res.json({ success: removed });
    } catch (error) {
      logger.error('Error deleting waypoint:', error);
      res.status(500).json({ error: 'Failed to delete waypoint' });
    }
  },
);

export default router;
