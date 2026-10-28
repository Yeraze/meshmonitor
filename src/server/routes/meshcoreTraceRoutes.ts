/**
 * MeshCore per-hop trace SNR history (#5722).
 *
 * Mounted under `/api/sources/:id/meshcore` (data routes: valid for any
 * MeshCore source). Reads are gated by the per-source `traceroute:read`
 * grant, the same grant that covers Meshtastic traceroutes; clearing one
 * link's history (#5970) needs `traceroute:write` on that source.
 */
import { Router, type Request, type Response } from 'express';
import { optionalAuth, requireAuth, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  summarizeHopSnrLinks, hopSnrEndParam, parseHopSnrEndParam, HOP_SNR_POINTS_PER_LINK, HOP_SNR_MAX_POINTS_PER_LINK,
} from '../../utils/meshcoreHopSnr.js';
import { HOP_SNR_HISTORY_LIMIT, HOP_SNR_HISTORY_MAX_LIMIT } from '../../db/repositories/meshcoreHopSnr.js';

const router = Router({ mergeParams: true });

const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 90;

// GET /api/sources/:id/meshcore/hop-snr?publicKey=<64 hex>&hours=<n>&points=<n>
// `points` caps the samples per link (newest kept). Default 120 serves the
// summary card; the charts ask for more (#5765).
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
      let points = HOP_SNR_POINTS_PER_LINK;
      if (req.query.points !== undefined) {
        points = Number(req.query.points);
        if (!Number.isInteger(points) || points <= 0 || points > HOP_SNR_MAX_POINTS_PER_LINK) {
          return fail(res, 400, 'INVALID_POINTS', `points must be a whole number between 1 and ${HOP_SNR_MAX_POINTS_PER_LINK}`);
        }
      }
      const sinceMs = Date.now() - hours * 60 * 60_000;
      // The row limit spans every link of the read, so a larger point cap
      // needs more rows or busy contacts would starve their quieter links.
      const rowLimit = Math.min(HOP_SNR_HISTORY_MAX_LIMIT, Math.max(HOP_SNR_HISTORY_LIMIT, points * 10));
      const rows = typeof rawKey === 'string'
        ? await databaseService.meshcoreHopSnr.getHistoryForNode(sourceId, rawKey.toLowerCase(), sinceMs, rowLimit)
        : await databaseService.meshcoreHopSnr.getRecent(sourceId, sinceMs, rowLimit);
      return ok(res, { hours, links: summarizeHopSnrLinks(rows, points) });
    } catch (error) {
      logger.error('Error reading MeshCore hop SNR history:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to read trace SNR history');
    }
  },
);

// DELETE /api/sources/:id/meshcore/hop-snr?from=<end>&to=<end>
// Clears one directional link (#5970): every stored sample where `to` heard
// `from`, on this source only and at any age. That is the set one graph of
// the Trace SNR history card draws; the reverse direction is its own graph
// and is kept. An end is a 64-hex key, `h:<hash>` or `unknown`
// (`hopSnrEndParam`); one end must be a key. Sends nothing over the radio.
// Like every MeshCore write, it needs a signed-in user.
router.delete(
  '/hop-snr',
  requireAuth(),
  requirePermission('traceroute', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = String((req.params as { id?: string }).id ?? '');
      const sender = parseHopSnrEndParam(req.query.from);
      const receiver = parseHopSnrEndParam(req.query.to);
      if (!sender || !receiver) {
        return fail(res, 400, 'INVALID_LINK', 'from and to must each be a 64-hex public key, h:<hash> or unknown');
      }
      if (!sender.publicKey && !receiver.publicKey) {
        return fail(res, 400, 'INVALID_LINK', 'from or to must be a 64-hex public key');
      }
      const deleted = await databaseService.meshcoreHopSnr.deleteLink(sourceId, sender, receiver);
      logger.info(`Cleared ${deleted} MeshCore trace SNR row(s) for link ${hopSnrEndParam(sender).slice(0, 12)} -> ${hopSnrEndParam(receiver).slice(0, 12)} on source ${sourceId}`);
      return ok(res, { deleted });
    } catch (error) {
      logger.error('Error clearing MeshCore hop SNR link history:', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Failed to clear trace SNR history');
    }
  },
);

export default router;
