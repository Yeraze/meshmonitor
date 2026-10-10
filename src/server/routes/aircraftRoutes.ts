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
 *
 * POST /api/aircraft/mark  { sourceId, nodeNum, mode }   (#5715)
 *
 * A person overrides the classifier for one node on one source:
 * `mode` is 'not_aircraft', 'aircraft' or 'clear'. Needs `nodes:write` on
 * THAT source. Database-only: sends no packet and fires no automation event.
 * Every accepted change is audit-logged (who, node, source, mode).
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { buildPositionFilter } from '../utils/positionVisibility.js';
import { buildAircraftTrails, clampTrailHours } from '../utils/aircraftTrails.js';
import {
  aircraftClassificationService,
  AIRCRAFT_MANUAL_MARK_MODES,
  type AircraftManualMarkMode,
} from '../services/aircraftClassificationService.js';

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

router.post(
  '/mark',
  requirePermission('nodes', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
  async (req: Request, res: Response) => {
    const sourceId = req.body?.sourceId as string;
    const nodeNum = req.body?.nodeNum;
    const mode = req.body?.mode;
    if (typeof nodeNum !== 'number' || !Number.isInteger(nodeNum) || nodeNum < 0 || nodeNum > 0xffffffff) {
      return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');
    }
    if (typeof mode !== 'string' || !(AIRCRAFT_MANUAL_MARK_MODES as readonly string[]).includes(mode)) {
      return fail(res, 400, 'INVALID_MODE', `mode must be one of ${AIRCRAFT_MANUAL_MARK_MODES.join(', ')}`);
    }
    try {
      const result = await aircraftClassificationService.applyManualMark(
        sourceId,
        nodeNum,
        mode as AircraftManualMarkMode,
        req.user?.id ?? null,
      );
      if (!result.ok) {
        return fail(res, result.status, result.code, result.message);
      }
      // No coordinates in the audit row: the anchor may be a private position.
      void databaseService.auditLogAsync(
        req.user?.id ?? null,
        'aircraft_manual_mark',
        'nodes',
        JSON.stringify({ sourceId, nodeNum, mode, previousMark: result.previousMark }),
        req.ip || null,
      );
      logger.info(`✈️ Node ${nodeNum} on source ${sourceId}: manual aircraft mark '${mode}' by user ${req.user?.id ?? 'unknown'}`);
      return ok(res, { sourceId, nodeNum, mode });
    } catch (error) {
      logger.error('Error in POST /api/aircraft/mark:', error);
      return fail(res, 500, 'AIRCRAFT_MARK_FAILED', 'Failed to update the aircraft mark');
    }
  },
);

export default router;
