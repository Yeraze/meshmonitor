/**
 * ADS-B flight match route (#5374).
 *
 * Mounted at `/api/sources/:id/nodes/:nodeNum/flight-match` via
 * `sourceRoutes.ts`. `GET` returns the node's current match on this source,
 * with the feed's name, a link to the flight on the feed's map and a credit
 * line — or `null` when there is nothing to show.
 *
 * Gated by `nodes:read` on the path's source. A node whose position override
 * is private returns `null` to a user without `nodes_private:read` on that
 * source: the match places the node near a known aircraft, which is a
 * position.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolveAdsbFeed } from '../../utils/adsbFeeds.js';
import type { AircraftFlightMatchRow } from '../../db/repositories/aircraftFlightMatches.js';

const router = Router({ mergeParams: true });

export interface FlightMatchResponse extends Omit<AircraftFlightMatchRow, 'sourceId' | 'lookups' | 'episodeStartedAt' | 'firstLookupAt'> {
  feedName: string;
  flightUrl: string | null;
  attribution: string;
}

export function toFlightMatchResponse(row: AircraftFlightMatchRow): FlightMatchResponse {
  const feed = resolveAdsbFeed(row.feed);
  return {
    nodeNum: row.nodeNum,
    status: row.status,
    feed: feed.id,
    hex: row.hex,
    callsign: row.callsign,
    aircraftType: row.aircraftType,
    registration: row.registration,
    gsKt: row.gsKt,
    trackDeg: row.trackDeg,
    altM: row.altM,
    distanceKm: row.distanceKm,
    matchedAt: row.matchedAt,
    feedName: feed.name,
    flightUrl: row.hex ? feed.flightUrl(row.hex) : null,
    attribution: `Data: ${feed.name}`,
  };
}

function parseNodeNum(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 0xffffffff ? n : null;
}

router.get('/', requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  const sourceId = req.params.id;
  const nodeNum = parseNodeNum(req.params.nodeNum);
  if (nodeNum === null) return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');

  try {
    if ((await databaseService.settings.getSetting('adsbMatchEnabled')) !== 'true') return ok(res, null);

    const node = await databaseService.nodes.getNode(nodeNum, sourceId);
    if (!node) return ok(res, null);

    if (node.positionOverrideIsPrivate === true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5374 req.user's shape isn't exported by authMiddleware (same as sibling routes)
      const user = (req as any).user;
      const canViewPrivate = !!user && await hasPermission(user, 'nodes_private', 'read', sourceId);
      if (!canViewPrivate) return ok(res, null);
    }

    const row = await databaseService.getAircraftFlightMatchAsync(sourceId, nodeNum);
    if (!row || row.status === 'none' || !row.hex) return ok(res, null);
    return ok(res, toFlightMatchResponse(row));
  } catch (error) {
    logger.error('Error fetching flight match:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch flight match');
  }
});

export default router;
