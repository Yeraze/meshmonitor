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
 * POST /api/aircraft/mark  { sourceId, nodeNum, mode, allSources? }   (#5715, #6046)
 *
 * A person overrides the classifier for one node on one source:
 * `mode` is 'not_aircraft', 'aircraft' or 'clear'. Needs `nodes:write` on
 * THAT source. Database-only: sends no packet and fires no automation event.
 * Every accepted change is audit-logged (who, node, source, mode).
 *
 * Opt-in `allSources: true` (#6046) applies the mark to EVERY source that
 * carries the node and that the caller may `nodes:write`. Classification runs
 * per source, so a node heard by several sources keeps firing alerts on the
 * ones left unmarked — this clears them in one call. Sources the caller cannot
 * write are skipped and reported. One shared anchor (the acted-on source's
 * position) is written to every `not_aircraft` row. The response carries
 * `{ applied, skipped }` as `{ sourceId, sourceName }` lists.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import type { DbNode } from '../../db/types.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolvePermittedSourceIds, parseSourcesParam } from '../utils/permittedSources.js';
import { listPermittedSourceIds } from '../utils/sourceScopedAccess.js';
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

    // The filter only ever sees flagged pairs (`wanted` is checked first), so
    // it needs just those nodes' rows, not every node on each source.
    const nodesBySource = new Map<string, DbNode[]>(
      await Promise.all(
        trailSourceIds.map(async (sourceId): Promise<[string, DbNode[]]> => {
          const nums = pairs.filter((p) => p.sourceId === sourceId).map((p) => p.nodeNum);
          return [sourceId, [...(await databaseService.nodes.getNodesByNums(nums, sourceId)).values()]];
        }),
      ),
    );
    const posFilter = await buildPositionFilter(req.user, trailSourceIds, nodesBySource);
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
    const allSources = req.body?.allSources;
    if (typeof nodeNum !== 'number' || !Number.isInteger(nodeNum) || nodeNum < 0 || nodeNum > 0xffffffff) {
      return fail(res, 400, 'INVALID_NODE_NUM', 'nodeNum must be an unsigned 32-bit integer');
    }
    if (typeof mode !== 'string' || !(AIRCRAFT_MANUAL_MARK_MODES as readonly string[]).includes(mode)) {
      return fail(res, 400, 'INVALID_MODE', `mode must be one of ${AIRCRAFT_MANUAL_MARK_MODES.join(', ')}`);
    }
    // `allSources` is optional, but a stray non-boolean (e.g. the string
    // "true") would silently fall through to the single-source path, so reject
    // the ambiguity rather than guess — mirrors the hide-from-map route.
    if (allSources !== undefined && typeof allSources !== 'boolean') {
      return fail(res, 400, 'INVALID_PARAMETER_TYPE', 'allSources must be a boolean');
    }
    try {
      if (allSources === true) {
        // Fan out to every source that carries the node AND that the caller may
        // write. `sourceId` (the acted-on source) is the anchor and is always a
        // target — it already passed the per-source nodes:write gate above. The
        // other carrying sources are intersected with the caller's write grants;
        // those they cannot write are reported, never written. The gate's own
        // source is the one whose position anchors every not_aircraft row.
        const writable = await listPermittedSourceIds(req.user, 'nodes', 'write');
        const carrying = (await databaseService.nodes.getSourcesForNode(nodeNum)).map((r) => r.sourceId);
        const isWritable = (id: string) => writable === 'all' || writable.includes(id);
        const targets = Array.from(new Set([sourceId, ...carrying.filter(isWritable)]));
        const permissionSkipped = carrying.filter((id) => id !== sourceId && !isWritable(id));

        const result = await aircraftClassificationService.applyManualMarkMany(
          sourceId,
          nodeNum,
          mode as AircraftManualMarkMode,
          req.user?.id ?? null,
          targets,
        );
        if (!result.ok) {
          return fail(res, result.status, result.code, result.message);
        }

        // Turn source ids into names for the UI (so it can name who got the
        // mark and who was skipped). Unknown ids fall back to the raw id.
        const sourceNames = new Map(
          (await databaseService.sources.getAllSources()).map((s) => [s.id, s.name] as const),
        );
        const nameOf = (id: string) => sourceNames.get(id) ?? id;
        const skipped = [
          ...result.skipped.map((s) => ({ sourceId: s.sourceId, sourceName: nameOf(s.sourceId), code: s.code, message: s.message })),
          ...permissionSkipped.map((id) => ({
            sourceId: id,
            sourceName: nameOf(id),
            code: 'NO_WRITE_PERMISSION',
            message: 'You do not have nodes:write on this source',
          })),
        ];
        const applied = result.applied.map((id) => ({ sourceId: id, sourceName: nameOf(id) }));

        // No coordinates in the audit row: the anchor may be a private position.
        void databaseService.auditLogAsync(
          req.user?.id ?? null,
          'aircraft_manual_mark',
          'nodes',
          JSON.stringify({
            sourceId, nodeNum, mode, allSources: true, previousMark: result.previousMark,
            applied: result.applied, skipped: skipped.map((s) => s.sourceId),
          }),
          req.ip || null,
        );
        logger.info(
          `✈️ Node ${nodeNum}: all-sources aircraft mark '${mode}' applied to [${result.applied.join(', ')}]` +
          `${skipped.length ? `, skipped [${skipped.map((s) => s.sourceId).join(', ')}]` : ''} by user ${req.user?.id ?? 'unknown'}`,
        );
        return ok(res, { nodeNum, mode, allSources: true, applied, skipped });
      }

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
