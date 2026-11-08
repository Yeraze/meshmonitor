/**
 * MeshCore estimated positions (#6260 WP5). Computed on read for one source
 * and never stored. Data route: valid for any MeshCore source.
 */
import { Router, type Request, type Response } from 'express';
import { optionalAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { estimateMeshCorePositions } from '../services/meshcorePositionEstimator.js';

const router = Router({ mergeParams: true });

// GET /api/sources/:id/meshcore/estimated-positions
// `nodes:read` opens the route; `nodes:viewOnMap` pays for the positions.
router.get(
  '/estimated-positions',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = String((req.params as { id?: string }).id ?? '');
      if (!req.user || !(await hasPermission(req.user, 'nodes', 'viewOnMap', sourceId))) {
        return ok(res, { items: [] });
      }
      return ok(res, { items: await estimateMeshCorePositions(sourceId, req.user) });
    } catch (error) {
      logger.error('Error estimating MeshCore positions:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to estimate positions');
    }
  },
);

export default router;
