/**
 * Aircraft routes (#5364/#5365 Phase 3).
 *
 * GET /api/aircraft/trails?hours=&sources=a,b
 *
 * Flight trails for nodes the map may draw as likely aircraft: flagged
 * `likelyAircraft`, or aged out by the sweep. Reads stored position telemetry
 * only, so it costs no airtime.
 *
 *  1. Sources: every source the caller can `nodes:read`, intersected with
 *     `sources` when given.
 *  2. Nodes: `listAircraftTrailNodeNums`, scoped by those sources.
 *  3. Positions: pivoted lat/lon/alt fixes since `now - hours`.
 *  4. Privacy: `buildPositionFilter`, exactly as `/api/analysis/positions`
 *     applies it (orphans, `hideFromMap`, private overrides, channel
 *     `viewOnMap`).
 *  5. Shape: one trail per `(sourceId, nodeNum)`, at most 500 points each,
 *     at most 200 trails, newest last fix first.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { buildPositionFilter } from '../utils/positionVisibility.js';
import { buildAircraftTrails, clampTrailHours } from '../utils/aircraftTrails.js';

const router = Router();
router.use(optionalAuth());

router.get('/trails', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;

    const hours = clampTrailHours(req.query.hours);
    if (sourceIds.length === 0) {
      return ok(res, { trails: [] });
    }

    const pairs = await databaseService.nodes.listAircraftTrailNodeNums(sourceIds);
    if (pairs.length === 0) {
      return ok(res, { trails: [] });
    }

    // Two steps on purpose: the query below takes source ids and node numbers
    // as separate lists, so it can return a node number from a source where
    // that node is NOT flagged. `wanted` keeps only the flagged pairs.
    const wanted = new Set(pairs.map((p) => `${p.sourceId}:${p.nodeNum}`));
    const trailSourceIds = Array.from(new Set(pairs.map((p) => p.sourceId)));
    const rows = await databaseService.analysis.getPositionsForNodes({
      sourceIds: trailSourceIds,
      nodeNums: pairs.map((p) => p.nodeNum),
      sinceMs: Date.now() - hours * 3_600_000,
    });

    const posFilter = await buildPositionFilter(req.user, trailSourceIds);
    const visible = rows.filter((r) => wanted.has(`${r.sourceId}:${r.nodeNum}`) && posFilter(r));

    return ok(res, { trails: buildAircraftTrails(visible) });
  } catch (error) {
    logger.error('Error in GET /api/aircraft/trails:', error);
    return fail(res, 500, 'AIRCRAFT_TRAILS_FAILED', 'Failed to fetch aircraft trails');
  }
});

export default router;
