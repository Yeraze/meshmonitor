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
 * Read-only. No mesh traffic.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from '../utils/apiResponse.js';
import { parseSourcesParam } from '../utils/permittedSources.js';
import { resolveCorrelationSourceIds } from '../services/crossSourceCorrelation.js';
import {
  buildPositionFilter, loadNodesBySource,
  buildMeshCorePositionFilter, loadMeshCoreNodesBySource,
} from '../utils/positionVisibility.js';
import { clampCoverageRetentionDays } from '../../utils/coverage.js';
import type { DbCrossSourceLink } from '../../db/repositories/crossSourceLinks.js';
import type { CrossSourceLinkDto, CrossSourceLinksResponse } from '../../types/crossSourceLinks.js';
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
     * lack a position its neighbour's table has). Each lookup passes that
     * source's own visibility gate.
     */
    const resolveEndpoint = (
      protocol: string, nodeId: string, ownSource: string, otherSource: string,
    ): { pos: [number, number]; name: string | null } | null => {
      for (const srcId of [ownSource, otherSource]) {
        if (protocol === 'meshcore') {
          const key = nodeId.toLowerCase();
          const n = mcIndex.get(`${srcId}:${key}`);
          if (!n || !mcFilter || !mcFilter({ sourceId: srcId, publicKey: key })) continue;
          if (n.latitude == null || n.longitude == null || (n.latitude === 0 && n.longitude === 0)) continue;
          return { pos: [n.latitude, n.longitude], name: n.name ?? null };
        }
        const nodeNum = parseNodeNum(nodeId);
        if (nodeNum === null) return null;
        const n = nodeIndex.get(`${srcId}:${nodeNum}`);
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

export default router;
