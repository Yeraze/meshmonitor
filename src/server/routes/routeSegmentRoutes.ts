import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES, type SourceScope } from '../../db/repositories/index.js';
import { ok, fail } from '../utils/apiResponse.js';
import { classifyNodeTransport, type NodeTransportClass } from '../../utils/nodeTransport.js';
import type { DbRouteSegment } from '../../db/types.js';
import type { RouteSegmentView, RouteSegmentRecords } from '../../services/api.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const TRANSPORT_CLASSES: readonly NodeTransportClass[] = ['rf', 'udp', 'mqtt'];

/*
 * Permission resource (#5101 §10.3, finding 3): these routes gate on
 * `traceroute`, not `info`. Route segments are traceroute-derived data
 * (each one is a hop of a stored traceroute), and `traceroute` is already a
 * per-source ("sourcey") resource — `SOURCEY_RESOURCES` in
 * `src/types/permission.ts` — so `checkPermissionAsync` does the real
 * exact-match scoping itself: a grant on one source does not authorize
 * reading or clearing another's records (the #3745 class of bug this fix
 * closes). `info` stays a deliberately cross-source nav-gate resource
 * everywhere else in the app and was the wrong gate for this endpoint; no
 * route-local permission shim is needed once the resource is sourcey.
 * Mirrors `requirePermission('traceroute', 'read', { sourceIdFrom: 'query' })`
 * at `tracerouteRoutes.ts:58`.
 */

/**
 * Enrich one stored segment with node names and its classified transport
 * (#5101). `sourceId` undefined keeps the legacy cross-source `getNode`
 * fallback behaviour.
 */
async function enrichSegment(
  segment: DbRouteSegment,
  sourceId: string | undefined,
): Promise<RouteSegmentView> {
  const [fromNode, toNode] = await Promise.all([
    databaseService.nodes.getNode(segment.fromNodeNum, sourceId),
    databaseService.nodes.getNode(segment.toNodeNum, sourceId),
  ]);

  return {
    ...segment,
    fromNodeName: fromNode?.longName || segment.fromNodeId,
    toNodeName: toNode?.longName || segment.toNodeId,
    transportMechanism: segment.transportMechanism ?? null,
    transport: classifyNodeTransport({ transportMechanism: segment.transportMechanism }),
  } as RouteSegmentView;
}

/**
 * Fetch and enrich one record per transport class in parallel, then build
 * the response body per §4.5 of the Phase 2 spec: the legacy top-level
 * fields equal the entry with the largest `distanceKm` (the three classes
 * partition the underlying rows, so this equals today's unfiltered query),
 * with `byTransport` added alongside. `null` when no class has a segment.
 */
async function buildRecords(
  sourceId: string | undefined,
  fetchOne: (scope: SourceScope, cls: NodeTransportClass) => Promise<DbRouteSegment | null>,
): Promise<RouteSegmentRecords | null> {
  const scope: SourceScope = sourceId ?? ALL_SOURCES;
  const raw = await Promise.all(TRANSPORT_CLASSES.map((cls) => fetchOne(scope, cls)));

  const present = TRANSPORT_CLASSES.filter((_cls, i) => raw[i] !== null);
  if (present.length === 0) return null;

  const enriched: Record<NodeTransportClass, RouteSegmentView | null> = {
    rf: null,
    udp: null,
    mqtt: null,
  };
  await Promise.all(
    TRANSPORT_CLASSES.map(async (cls, i) => {
      const row = raw[i];
      if (row) enriched[cls] = await enrichSegment(row, sourceId);
    }),
  );

  const top = present.reduce((best, cls) =>
    enriched[cls]!.distanceKm > enriched[best]!.distanceKm ? cls : best,
  present[0]);

  return {
    ...enriched[top]!,
    byTransport: enriched,
  };
}

router.get(
  '/longest-active',
  requirePermission('traceroute', 'read', { sourceIdFrom: 'query' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.query.sourceId as string | undefined;
      const records = await buildRecords(sourceId, (scope, cls) =>
        databaseService.traceroutes.getLongestActiveRouteSegment(scope, cls),
      );
      res.json(records);
    } catch (error) {
      logger.error('Error fetching longest active route segment:', error);
      fail(res, 500, 'ROUTE_SEGMENT_FETCH_FAILED', 'Failed to fetch longest active route segment');
    }
  },
);

router.get(
  '/record-holder',
  requirePermission('traceroute', 'read', { sourceIdFrom: 'query' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.query.sourceId as string | undefined;
      const records = await buildRecords(sourceId, (scope, cls) =>
        databaseService.traceroutes.getRecordHolderRouteSegment(scope, cls),
      );
      res.json(records);
    } catch (error) {
      logger.error('Error fetching record holder route segment:', error);
      fail(res, 500, 'ROUTE_SEGMENT_FETCH_FAILED', 'Failed to fetch record holder route segment');
    }
  },
);

router.delete(
  '/record-holder',
  requirePermission('traceroute', 'write', { sourceIdFrom: 'query', requireSourceId: true }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = req.query.sourceId as string;
      const transportRaw = req.query.transport as string | undefined;
      if (transportRaw !== undefined && !TRANSPORT_CLASSES.includes(transportRaw as NodeTransportClass)) {
        fail(res, 400, 'INVALID_TRANSPORT', `Invalid transport: ${transportRaw}`);
        return;
      }
      const transport = transportRaw as NodeTransportClass | undefined;
      await databaseService.clearRecordHolderSegmentAsync(sourceId, transport);
      ok(res);
    } catch (error) {
      logger.error('Error clearing record holder:', error);
      fail(res, 500, 'RECORD_HOLDER_CLEAR_FAILED', 'Failed to clear record holder');
    }
  },
);

export default router;
