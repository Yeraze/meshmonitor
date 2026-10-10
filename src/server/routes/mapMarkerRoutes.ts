/**
 * Local map marker routes (issue #5686).
 *
 * Mounted at `/api/sources/:id/markers` via `sourceRoutes.ts`. A marker is a
 * planning note stored in MeshMonitor and NEVER transmitted. This module
 * deliberately imports no source manager, registry or send service: there is
 * no path from here to a radio (`mapMarkerRoutes.noTransmit.test.ts` pins it).
 *
 * Permissions reuse the per-source `waypoints` resource — markers sit beside
 * waypoints on the same map: read to see them, write to create, edit or
 * delete. Each check is scoped to the path's `:id`.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { MAP_MARKERS_PER_SOURCE_MAX, parseMapMarkerInput } from '../../types/mapMarker.js';

// `mergeParams` lets us read `:id` from the parent (sourceRoutes) router.
const router = Router({ mergeParams: true });

const canRead = requirePermission('waypoints', 'read', { sourceIdFrom: 'params.id' });
const canWrite = requirePermission('waypoints', 'write', { sourceIdFrom: 'params.id' });

/** Resolve `:id` to an existing source, or answer 404 and return null. */
async function requireSource(req: Request, res: Response): Promise<string | null> {
  const sourceId = typeof req.params?.id === 'string' ? req.params.id : '';
  const source = sourceId ? await databaseService.sources.getSource(sourceId) : null;
  if (!source) {
    fail(res, 404, 'SOURCE_NOT_FOUND', 'Source not found');
    return null;
  }
  return sourceId;
}

function markerId(req: Request): number | null {
  const n = Number(req.params.markerId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function userId(req: Request): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5686 matches the sibling handlers' (req as any).user
  const id = (req as any).user?.id;
  return typeof id === 'number' ? id : null;
}

// GET /api/sources/:id/markers
router.get('/', canRead, async (req: Request, res: Response) => {
  try {
    const sourceId = await requireSource(req, res);
    if (!sourceId) return;
    ok(res, await databaseService.mapMarkers.listBySource(sourceId));
  } catch (error) {
    logger.error('Error listing map markers:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to list map markers');
  }
});

// POST /api/sources/:id/markers
router.post('/', canWrite, async (req: Request, res: Response) => {
  try {
    const sourceId = await requireSource(req, res);
    if (!sourceId) return;
    const parsed = parseMapMarkerInput(req.body);
    if ('error' in parsed) return fail(res, 400, parsed.code, parsed.error);
    if (await databaseService.mapMarkers.countBySource(sourceId) >= MAP_MARKERS_PER_SOURCE_MAX) {
      return fail(res, 409, 'MARKER_LIMIT_REACHED',
        `This source already has ${MAP_MARKERS_PER_SOURCE_MAX} local markers. Delete some before adding more.`);
    }
    const created = await databaseService.mapMarkers.create(sourceId, parsed.value, userId(req));
    res.status(201);
    ok(res, created);
  } catch (error) {
    logger.error('Error creating map marker:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to create map marker');
  }
});

// PUT /api/sources/:id/markers/:markerId
router.put('/:markerId', canWrite, async (req: Request, res: Response) => {
  try {
    const sourceId = await requireSource(req, res);
    if (!sourceId) return;
    const id = markerId(req);
    if (id === null) return fail(res, 400, 'INVALID_ID', 'invalid marker id');
    const parsed = parseMapMarkerInput(req.body);
    if ('error' in parsed) return fail(res, 400, parsed.code, parsed.error);
    const updated = await databaseService.mapMarkers.update(sourceId, id, parsed.value);
    if (!updated) return fail(res, 404, 'MARKER_NOT_FOUND', 'Marker not found');
    ok(res, updated);
  } catch (error) {
    logger.error('Error updating map marker:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to update map marker');
  }
});

// DELETE /api/sources/:id/markers/:markerId
router.delete('/:markerId', canWrite, async (req: Request, res: Response) => {
  try {
    const sourceId = await requireSource(req, res);
    if (!sourceId) return;
    const id = markerId(req);
    if (id === null) return fail(res, 400, 'INVALID_ID', 'invalid marker id');
    const removed = await databaseService.mapMarkers.delete(sourceId, id);
    if (!removed) return fail(res, 404, 'MARKER_NOT_FOUND', 'Marker not found');
    ok(res);
  } catch (error) {
    logger.error('Error deleting map marker:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to delete map marker');
  }
});

export default router;
