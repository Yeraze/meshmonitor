/**
 * Cross-source "heard here" links API (#5561).
 *
 * Mounted at `/api/analysis/cross-source-links` (server.ts, before the
 * general `/analysis` router). Returns directional edges "source A's radio
 * was heard by source B", aggregated from the hourly `cross_source_links`
 * buckets over the requested window, with both endpoint positions resolved.
 *
 * Permission (the two-source read rule): an edge is returned only when the
 * caller can read `nodes` on BOTH its tx and rx source (admins: all). The
 * permitted list comes from the shared cross-source gate
 * (`resolveCorrelationSourceIds`), and the repository query requires both
 * ends to be in it, so a caller who can read one source gets no edge and no
 * hint that the other exists.
 *
 * Positions go through the same visibility gates as the map
 * (`buildPositionFilter` / `buildMeshCorePositionFilter`): an edge with a
 * hidden, private or unknown endpoint is dropped, never returned with a
 * nulled coordinate.
 *
 * `GET /traceroute-confirmed` (#5580) is the sibling overlay: links next to
 * one of our own radios that a completed traceroute used both ways. It is a
 * per-source reading (our radio and a remote node on the SAME source), so the
 * rule there is `nodes:read` AND `traceroute:read` on that source, plus the
 * same position gates. Computed on read from `traceroutes`; nothing stored.
 *
 * Read-only. No mesh traffic: neither route sends a traceroute or any packet.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { parseSourcesParam, resolvePermittedSourceIds } from '../utils/permittedSources.js';
import { resolveLocalNodeNums } from '../utils/localNodeNums.js';
import { maskTraceroutesByChannel } from '../utils/nodeEnhancer.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { buildConfirmedLinks } from '../services/tracerouteConfirmedLinks.js';
import { resolveCorrelationSourceIds } from '../services/crossSourceCorrelation.js';
import {
  buildPositionFilter, loadNodesBySource,
  buildMeshCorePositionFilter, loadMeshCoreNodesBySource,
} from '../utils/positionVisibility.js';
import { clampCoverageRetentionDays } from '../../utils/coverage.js';
import type { DbCrossSourceLink } from '../../db/repositories/crossSourceLinks.js';
import type {
  CrossSourceLinkDto, CrossSourceLinksResponse,
  TracerouteConfirmedLinkDto, TracerouteConfirmedLinksResponse,
} from '../../types/crossSourceLinks.js';
import type { DbNode } from '../../db/types.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';

const router = Router();
router.use(optionalAuth());

interface Aggregate {
  first: DbCrossSourceLink;
  count: number;
  snrMin: number | null;
  snrMax: number | null;
  snrSum: number;
  snrCount: number;
  rssiSum: number;
  rssiCount: number;
  lastHeardAt: number;
}

/** Fold hourly buckets into one row per edge. Exported for unit tests. */
export function aggregateCrossSourceLinks(rows: DbCrossSourceLink[]): Aggregate[] {
  const map = new Map<string, Aggregate>();
  for (const r of rows) {
    const key = `${r.txSourceId}|${r.txNodeId}|${r.rxSourceId}|${r.rxNodeId}|${r.kind}|${r.transportClass}`;
    let a = map.get(key);
    if (!a) {
      a = { first: r, count: 0, snrMin: null, snrMax: null, snrSum: 0, snrCount: 0, rssiSum: 0, rssiCount: 0, lastHeardAt: 0 };
      map.set(key, a);
    }
    a.count += r.count;
    if (r.snrMin != null) a.snrMin = a.snrMin == null ? r.snrMin : Math.min(a.snrMin, r.snrMin);
    if (r.snrMax != null) a.snrMax = a.snrMax == null ? r.snrMax : Math.max(a.snrMax, r.snrMax);
    if (r.snrAvg != null && r.snrCount > 0) { a.snrSum += r.snrAvg * r.snrCount; a.snrCount += r.snrCount; }
    if (r.rssiAvg != null && r.rssiCount > 0) { a.rssiSum += r.rssiAvg * r.rssiCount; a.rssiCount += r.rssiCount; }
    if (r.lastHeardAt > a.lastHeardAt) a.lastHeardAt = r.lastHeardAt;
  }
  return Array.from(map.values());
}

function parseNodeNum(nodeId: string): number | null {
  return /^![0-9a-f]{8}$/i.test(nodeId) ? parseInt(nodeId.slice(1), 16) : null;
}

function nodeLatLon(node: DbNode | undefined): [number, number] | null {
  if (!node) return null;
  const lat = node.positionOverrideEnabled ? node.latitudeOverride : node.latitude;
  const lon = node.positionOverrideEnabled ? node.longitudeOverride : node.longitude;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return [lat, lon];
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const permitted = await resolveCorrelationSourceIds(req, 'nodes');

    const retentionDays = clampCoverageRetentionDays(
      await databaseService.getSettingAsync('coverage_retention_days'),
    );
    const nowMs = Date.now();
    const floorMs = nowMs - retentionDays * 86_400_000;
    let sinceMs = nowMs - 24 * 3_600_000;
    if (req.query.since !== undefined) {
      const n = Number(req.query.since);
      if (typeof req.query.since !== 'string' || req.query.since.trim() === '' || !Number.isFinite(n)) {
        return fail(res, 400, 'INVALID_TIME_RANGE', 'since must be a numeric unix-ms timestamp');
      }
      sinceMs = n;
    }
    sinceMs = Math.max(sinceMs, floorMs);

    const empty: CrossSourceLinksResponse = { links: [], sinceMs, retentionDays };
    if (permitted.length < 2) return ok(res, empty);

    // Optional `?sources=`: keep edges that touch one of these sources. Both
    // ends must still be readable.
    const requested = parseSourcesParam(req.query.sources);

    const rows = await databaseService.crossSourceLinks.getLinks({ sourceIds: permitted, sinceMs });
    const aggregates = aggregateCrossSourceLinks(rows).filter(
      (a) => !requested || requested.includes(a.first.txSourceId) || requested.includes(a.first.rxSourceId),
    );
    if (aggregates.length === 0) return ok(res, empty);

    const involved = Array.from(new Set(aggregates.flatMap((a) => [a.first.txSourceId, a.first.rxSourceId])));
    const mcInvolved = Array.from(new Set(
      aggregates.filter((a) => a.first.protocol === 'meshcore').flatMap((a) => [a.first.txSourceId, a.first.rxSourceId]),
    ));

    const [allSources, nodesBySource, mcNodesBySource] = await Promise.all([
      databaseService.sources.getAllSources(),
      loadNodesBySource(involved),
      mcInvolved.length > 0 ? loadMeshCoreNodesBySource(mcInvolved) : Promise.resolve(new Map<string, DbMeshCoreNode[]>()),
    ]);
    const [posFilter, mcFilter] = await Promise.all([
      buildPositionFilter(req.user, involved, nodesBySource),
      mcInvolved.length > 0 ? buildMeshCorePositionFilter(req.user, mcInvolved, mcNodesBySource) : Promise.resolve(null),
    ]);
    const sourceNameById = new Map(allSources.map((s) => [s.id, s.name] as const));

    const nodeIndex = new Map<string, DbNode>();
    for (const [srcId, nodes] of nodesBySource) {
      for (const n of nodes) nodeIndex.set(`${srcId}:${Number(n.nodeNum)}`, n);
    }
    const mcIndex = new Map<string, DbMeshCoreNode>();
    for (const [srcId, nodes] of mcNodesBySource) {
      for (const n of nodes) mcIndex.set(`${srcId}:${n.publicKey.toLowerCase()}`, n);
    }

    /**
     * One endpoint's visible position + name. Looks on the endpoint's own
     * source first, then on the other end's source (a radio's own row can
     * lack a position its neighbour's table has). Each lookup passes the
     * visibility gate of the source whose table holds the row. The fallback
     * never overrides the owning source: if the radio's own row exists there
     * and its gate says no (hidden, private, no viewOnMap), the endpoint is
     * not shown, whatever the other source's table would allow.
     */
    const resolveEndpoint = (
      protocol: string, nodeId: string, ownSource: string, otherSource: string,
    ): { pos: [number, number]; name: string | null } | null => {
      for (const srcId of [ownSource, otherSource]) {
        if (protocol === 'meshcore') {
          const key = nodeId.toLowerCase();
          const n = mcIndex.get(`${srcId}:${key}`);
          if (n && srcId === ownSource && (!mcFilter || !mcFilter({ sourceId: srcId, publicKey: key }))) return null;
          if (!n || !mcFilter || !mcFilter({ sourceId: srcId, publicKey: key })) continue;
          if (n.latitude == null || n.longitude == null || (n.latitude === 0 && n.longitude === 0)) continue;
          return { pos: [n.latitude, n.longitude], name: n.name ?? null };
        }
        const nodeNum = parseNodeNum(nodeId);
        if (nodeNum === null) return null;
        const n = nodeIndex.get(`${srcId}:${nodeNum}`);
        if (n && srcId === ownSource && !posFilter({ sourceId: srcId, nodeNum })) return null;
        if (!n || !posFilter({ sourceId: srcId, nodeNum })) continue;
        const pos = nodeLatLon(n);
        if (!pos) continue;
        return { pos, name: n.longName || n.shortName || null };
      }
      return null;
    };

    const links: CrossSourceLinkDto[] = [];
    for (const a of aggregates) {
      const r = a.first;
      const tx = resolveEndpoint(r.protocol, r.txNodeId, r.txSourceId, r.rxSourceId);
      const rx = resolveEndpoint(r.protocol, r.rxNodeId, r.rxSourceId, r.txSourceId);
      if (!tx || !rx) continue;
      links.push({
        key: `${r.txSourceId}|${r.txNodeId}|${r.rxSourceId}|${r.rxNodeId}|${r.kind}|${r.transportClass}`,
        protocol: r.protocol,
        kind: r.kind,
        inferred: r.kind === 'relay',
        transportClass: r.transportClass,
        txSourceId: r.txSourceId,
        txSourceName: sourceNameById.get(r.txSourceId) ?? r.txSourceId,
        txNodeId: r.txNodeId,
        txName: tx.name,
        rxSourceId: r.rxSourceId,
        rxSourceName: sourceNameById.get(r.rxSourceId) ?? r.rxSourceId,
        rxNodeId: r.rxNodeId,
        rxName: rx.name,
        count: a.count,
        snrMin: a.snrMin,
        snrAvg: a.snrCount > 0 ? a.snrSum / a.snrCount : null,
        snrMax: a.snrMax,
        rssiAvg: a.rssiCount > 0 ? a.rssiSum / a.rssiCount : null,
        lastHeardAt: a.lastHeardAt,
        from: tx.pos,
        to: rx.pos,
      });
    }
    links.sort((x, y) => y.count - x.count || x.key.localeCompare(y.key));

    const result: CrossSourceLinksResponse = { links, sinceMs, retentionDays };
    ok(res, result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/cross-source-links:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch cross-source links');
  }
});

/** Rows read per request before the response is marked `truncated`. */
export const CONFIRMED_LINKS_SCAN_LIMIT = 20000;

const nodeIdFor = (nodeNum: number): string => `!${nodeNum.toString(16).padStart(8, '0')}`;

/**
 * GET /traceroute-confirmed?sources=a,b&since=<unix-ms>
 *
 * Reciprocal links confirmed by traceroute (#5580). See
 * `services/tracerouteConfirmedLinks.ts` for the rule.
 *
 * Permission: a source contributes only when the caller can read BOTH `nodes`
 * and `traceroute` on it (admins: every enabled source). Runs are then
 * channel-masked exactly as the traceroute routes mask them, and both
 * endpoints must pass the map's position gates: a hidden or private node
 * yields no line.
 */
router.get('/traceroute-confirmed', async (req: Request, res: Response) => {
  try {
    const nowMs = Date.now();
    let sinceMs = nowMs - 24 * 3_600_000;
    if (req.query.since !== undefined) {
      const n = Number(req.query.since);
      if (typeof req.query.since !== 'string' || req.query.since.trim() === '' || !Number.isFinite(n)) {
        return fail(res, 400, 'INVALID_TIME_RANGE', 'since must be a numeric unix-ms timestamp');
      }
      sinceMs = Math.max(0, n);
    }
    const historyLimitPerPair = getEnvironmentConfig().tracerouteHistoryLimit;
    const empty: TracerouteConfirmedLinksResponse = { links: [], sinceMs, truncated: false, historyLimitPerPair };

    const allSources = await databaseService.sources.getAllSources();
    // A per-source reading, so this is the plain read gate on each resource,
    // not the two-source correlation rule the route above applies.
    const [nodeSources, tracerouteSources] = await Promise.all([
      resolvePermittedSourceIds(req, 'nodes', allSources),
      resolvePermittedSourceIds(req, 'traceroute', allSources),
    ]);
    const tracerouteSet = new Set(tracerouteSources);
    const requested = parseSourcesParam(req.query.sources);
    const permitted = nodeSources.filter(
      (id) => tracerouteSet.has(id) && (!requested || requested.includes(id)),
    );
    if (permitted.length === 0) return ok(res, empty);

    // Only a source with its own radio has a "leg next to our radio".
    const localNodeNums = await resolveLocalNodeNums(permitted);
    const sourceIds = permitted.filter((id) => localNodeNums.has(id));
    if (sourceIds.length === 0) return ok(res, empty);

    const rows = await databaseService.traceroutes.getTraceroutesForSources({
      sourceIds,
      sinceTimestamp: sinceMs,
      // One extra row tells "exactly the cap" apart from "more than the cap".
      limit: CONFIRMED_LINKS_SCAN_LIMIT + 1,
    });
    const truncated = rows.length > CONFIRMED_LINKS_SCAN_LIMIT;
    if (truncated) rows.length = CONFIRMED_LINKS_SCAN_LIMIT;

    const user = req.user ?? null;
    const bySource = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = bySource.get(row.sourceId);
      if (list) list.push(row);
      else bySource.set(row.sourceId, [row]);
    }
    const visibleRows: typeof rows = [];
    for (const [sid, list] of bySource) {
      visibleRows.push(...(await maskTraceroutesByChannel(list, user, sid)));
    }

    const aggregates = buildConfirmedLinks(visibleRows, localNodeNums);
    if (aggregates.length === 0) return ok(res, { ...empty, truncated });

    const involved = Array.from(new Set(aggregates.map((a) => a.sourceId)));
    const nodesBySource = await loadNodesBySource(involved);
    const posFilter = await buildPositionFilter(req.user, involved, nodesBySource);
    const nodeIndex = new Map<string, DbNode>();
    for (const [srcId, nodes] of nodesBySource) {
      for (const n of nodes) nodeIndex.set(`${srcId}:${Number(n.nodeNum)}`, n);
    }
    const sourceNameById = new Map(allSources.map((s) => [s.id, s.name] as const));

    // Both ends are looked up on the link's OWN source only: there is no
    // second source to fall back to, and no other source's table may stand in
    // for a position this one hides.
    const resolveEndpoint = (sourceId: string, nodeNum: number) => {
      if (!posFilter({ sourceId, nodeNum })) return null;
      const node = nodeIndex.get(`${sourceId}:${nodeNum}`);
      const pos = nodeLatLon(node);
      if (!node || !pos) return null;
      return { pos, name: node.longName || node.shortName || null };
    };

    const links: TracerouteConfirmedLinkDto[] = [];
    for (const a of aggregates) {
      const local = resolveEndpoint(a.sourceId, a.localNodeNum);
      const neighbor = resolveEndpoint(a.sourceId, a.neighborNodeNum);
      if (!local || !neighbor) continue;
      links.push({
        key: `${a.sourceId}|${nodeIdFor(a.localNodeNum)}|${nodeIdFor(a.neighborNodeNum)}|${a.transportClass}`,
        sourceId: a.sourceId,
        sourceName: sourceNameById.get(a.sourceId) ?? a.sourceId,
        localNodeNum: a.localNodeNum,
        localNodeId: nodeIdFor(a.localNodeNum),
        localName: local.name,
        neighborNodeNum: a.neighborNodeNum,
        neighborNodeId: nodeIdFor(a.neighborNodeNum),
        neighborName: neighbor.name,
        transportClass: a.transportClass,
        count: a.count,
        directCount: a.directCount,
        snrOutAvg: a.snrOutAvg,
        snrBackAvg: a.snrBackAvg,
        lastConfirmedAt: a.lastConfirmedAt,
        from: local.pos,
        to: neighbor.pos,
      });
    }
    links.sort((x, y) => y.count - x.count || x.key.localeCompare(y.key));

    const result: TracerouteConfirmedLinksResponse = { links, sinceMs, truncated, historyLimitPerPair };
    ok(res, result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/cross-source-links/traceroute-confirmed:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch traceroute-confirmed links');
  }
});

export default router;
