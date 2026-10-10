/**
 * MeshCore per-hop trace SNR history (#5722).
 *
 * Mounted under `/api/sources/:id/meshcore` (data routes: valid for any
 * MeshCore source). Read-only, gated by the per-source `traceroute:read`
 * grant, the same grant that covers Meshtastic traceroutes.
 */
import { Router, type Request, type Response } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { summarizeHopSnrLinks } from '../../utils/meshcoreHopSnr.js';

const router = Router({ mergeParams: true });

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 90;

// GET /api/sources/:id/meshcore/hop-snr?publicKey=<64 hex>&hours=<n>
router.get(
  '/hop-snr',
  optionalAuth(),
  requirePermission('traceroute', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = String((req.params as { id?: string }).id ?? '');
      const rawKey = req.query.publicKey;
      if (rawKey !== undefined && (typeof rawKey !== 'string' || !PUBLIC_KEY_RE.test(rawKey))) {
        return fail(res, 400, 'INVALID_PUBLIC_KEY', 'publicKey must be 64 hex characters');
      }
      let hours = DEFAULT_HOURS;
      if (req.query.hours !== undefined) {
        hours = Number(req.query.hours);
        if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
          return fail(res, 400, 'INVALID_HOURS', `hours must be between 1 and ${MAX_HOURS}`);
        }
      }
      const sinceMs = Date.now() - hours * 60 * 60_000;
      const rows = typeof rawKey === 'string'
        ? await databaseService.meshcoreHopSnr.getHistoryForNode(sourceId, rawKey.toLowerCase(), sinceMs)
        : await databaseService.meshcoreHopSnr.getRecent(sourceId, sinceMs);
      return ok(res, { hours, links: summarizeHopSnrLinks(rows) });
    } catch (error) {
      logger.error('Error reading MeshCore hop SNR history:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read trace SNR history');
    }
  },
);

export default router;
