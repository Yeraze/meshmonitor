/**
 * GET /api/sources/:id/meshcore/hop-candidates?prefixes=a3,7f01 (#5909)
 *
 * Names for route hop hashes from the OTHER MeshCore sources the viewer may
 * read, for the message route view's fallback when the receiving source's
 * own contacts don't match. Read-only and display-only.
 *
 * Response: `{ success: true, data: { enabled, candidates } }`, where
 * `candidates` maps each requested hash to `HopCandidate[]`. With the global
 * toggle off, `enabled` is false and `candidates` is empty, and no other
 * source is read.
 *
 * Gate: `nodes:read` on the requesting source. The pool is then limited to
 * sources the viewer can read; see `meshcoreHopCandidates.ts` for the rules.
 */
import { Router, type Request, type Response } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import {
  buildHopCandidatePool,
  isCrossSourceHopResolutionEnabled,
  parseHopPrefixes,
} from '../services/meshcoreHopCandidates.js';

const router = Router({ mergeParams: true });

router.get(
  '/hop-candidates',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      if (!(await isCrossSourceHopResolutionEnabled())) {
        return ok(res, { enabled: false, candidates: {} });
      }
      const prefixes = parseHopPrefixes(req.query.prefixes);
      const candidates = await buildHopCandidatePool(req, req.params.id, prefixes);
      return ok(res, { enabled: true, candidates });
    } catch (error) {
      logger.error('[API] Error building MeshCore hop candidates:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to load hop candidates');
    }
  },
);

export default router;
