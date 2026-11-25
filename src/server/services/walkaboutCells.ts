/**
 * Walkabout map service (#5891 P2, spec §2.7). Skeleton; WP1 fills the bodies.
 * Read-only: no dataEventEmitter, no timers, no writes.
 */
import type {
  DbWalkaboutSession,
  WalkaboutReceptionPoint,
  WalkaboutSamplePoint,
} from '../../db/repositories/coverageWalkabout.js';
import type {
  WalkaboutCellDto,
  WalkaboutCellNodeDto,
  WalkaboutCellNodesResult,
  WalkaboutCellsResult,
  WalkaboutH3Res,
  WalkaboutMapQuery,
  WalkaboutTrackResult,
} from '../../types/walkabout.js';

import databaseService from '../../services/database.js';
import {
  WALKABOUT_MAP_WINDOWS_MS,
  WALKABOUT_MAX_CELLS,
  WALKABOUT_MAX_CELL_NODES,
  WALKABOUT_MAX_RANGE_SESSIONS,
  WALKABOUT_MAX_RX_ROWS,
  WALKABOUT_MAX_SAMPLE_ROWS,
  WALKABOUT_MAX_TRACK_POINTS,
  walkaboutEndsAt,
} from '../../utils/walkabout.js';
import { isMeshCorePubKeyId } from '../../utils/coverage.js';
import {
  buildMeshCorePositionFilter,
  buildPositionFilter,
  loadMeshCoreNodesBySource,
  loadNodesBySource,
} from '../utils/positionVisibility.js';
import { loadSourcePermissions } from '../utils/sourcePermissions.js';
import { walkaboutCellBBox, walkaboutCellOf } from '../utils/walkaboutH3.js';

type Bounds = NonNullable<WalkaboutCellsResult['bounds']>;
type Names = { longName: string | null; shortName: string | null };

const byId = (list: DbWalkaboutSession[]) => new Map(list.map((x) => [x.id, x]));

export interface ResolvedRange {
  sinceMs: number;
  untilMs: number;
  sessions: DbWalkaboutSession[];
  truncated: boolean;
}

/** session: [startedAt, walkaboutEndsAt(s)]. window: [now - W, now].
 *  range: as given. Window/range: listSessionsInRange + exact overlap test.
 *  null = session not found. */
export async function resolveWalkaboutRange(
  sourceId: string,
  q: WalkaboutMapQuery,
  nowMs: number = Date.now(),
): Promise<ResolvedRange | null> {
  const repo = databaseService.coverageWalkabout;
  if (q.kind === 'session') {
    const s = await repo.getSession(sourceId, q.sessionId);
    if (!s) return null;
    return { sinceMs: s.startedAt, untilMs: walkaboutEndsAt(s), sessions: [s], truncated: false };
  }
  const untilMs = q.kind === 'window' ? nowMs : q.untilMs;
  const sinceMs = q.kind === 'window' ? nowMs - WALKABOUT_MAP_WINDOWS_MS[q.window] : q.sinceMs;
  const found = await repo.listSessionsInRange(sourceId, sinceMs, untilMs, WALKABOUT_MAX_RANGE_SESSIONS + 1);
  const truncated = found.length > WALKABOUT_MAX_RANGE_SESSIONS;
  const sessions = found
    .slice(0, WALKABOUT_MAX_RANGE_SESSIONS)
    .filter((s) => s.startedAt <= untilMs && walkaboutEndsAt(s) >= sinceMs);
  return { sinceMs, untilMs, sessions, truncated };
}

/** Keep rows with session.startedAt <= t <= walkaboutEndsAt(session), and
 *  inside [sinceMs, untilMs]. Receptions clip on heardAt, samples on fixAt. */
export function clipToSessions<T extends { sessionId: string }>(
  rows: T[],
  sessions: DbWalkaboutSession[],
  at: (r: T) => number,
  sinceMs: number,
  untilMs: number,
): T[] {
  const map = byId(sessions);
  return rows.filter((r) => {
    const s = map.get(r.sessionId);
    if (!s) return false;
    const t = at(r);
    return t >= s.startedAt && t <= walkaboutEndsAt(s) && t >= sinceMs && t <= untilMs;
  });
}

/** Bin with walkaboutCellOf. Per cell: max non-null snr, count, distinct
 *  creditedKey, sample count. Sort receptionCount desc, then sampleCount
 *  desc, then cell; cut at WALKABOUT_MAX_CELLS (truncated). */
export function binWalkaboutCells(
  rx: WalkaboutReceptionPoint[],
  samples: WalkaboutSamplePoint[],
  res: WalkaboutH3Res,
): { cells: WalkaboutCellDto[]; truncated: boolean } {
  const acc = new Map<string, { bestSnr: number | null; receptionCount: number; keys: Set<string>; sampleCount: number }>();
  const get = (cell: string) => {
    let a = acc.get(cell);
    if (!a) acc.set(cell, (a = { bestSnr: null, receptionCount: 0, keys: new Set(), sampleCount: 0 }));
    return a;
  };
  for (const r of rx) {
    const a = get(walkaboutCellOf(r.latitude, r.longitude, res));
    a.receptionCount++;
    a.keys.add(r.creditedKey);
    if (r.snr != null && (a.bestSnr == null || r.snr > a.bestSnr)) a.bestSnr = r.snr;
  }
  for (const sm of samples) get(walkaboutCellOf(sm.latitude, sm.longitude, res)).sampleCount++;
  const all: WalkaboutCellDto[] = [...acc].map(([cell, a]) => ({
    cell,
    bestSnr: a.bestSnr,
    receptionCount: a.receptionCount,
    nodeCount: a.keys.size,
    sampleCount: a.sampleCount,
  }));
  all.sort(
    (x, y) =>
      y.receptionCount - x.receptionCount || y.sampleCount - x.sampleCount || (x.cell < y.cell ? -1 : x.cell > y.cell ? 1 : 0),
  );
  const truncated = all.length > WALKABOUT_MAX_CELLS;
  return { cells: truncated ? all.slice(0, WALKABOUT_MAX_CELLS) : all, truncated };
}

/** Rows of one cell grouped by creditedKey. Sort bestSnr desc (nulls last),
 *  then receptionCount desc; cut at WALKABOUT_MAX_CELL_NODES. */
export function groupCellNodes(
  rx: WalkaboutReceptionPoint[],
  cell: string,
  res: WalkaboutH3Res,
  names: (row: WalkaboutReceptionPoint) => Names,
): { nodes: WalkaboutCellNodeDto[]; truncated: boolean } {
  const groups = new Map<string, WalkaboutCellNodeDto>();
  for (const r of rx) {
    if (walkaboutCellOf(r.latitude, r.longitude, res) !== cell) continue;
    let g = groups.get(r.creditedKey);
    if (!g) {
      const n = names(r);
      const mc = r.protocol === 'meshcore';
      g = {
        protocol: r.protocol,
        nodeId: mc ? null : r.creditedKey,
        nodeNum: mc ? null : r.creditedNodeNum,
        publicKey: mc ? r.creditedKey : null,
        longName: n.longName,
        shortName: n.shortName,
        bestSnr: null,
        receptionCount: 0,
        lastHeardAt: 0,
      };
      groups.set(r.creditedKey, g);
    }
    g.receptionCount++;
    if (r.snr != null && (g.bestSnr == null || r.snr > g.bestSnr)) g.bestSnr = r.snr;
    if (r.heardAt > g.lastHeardAt) g.lastHeardAt = r.heardAt;
  }
  const all = [...groups.values()].sort((a, b) => {
    if (a.bestSnr !== b.bestSnr) {
      if (a.bestSnr == null) return 1;
      if (b.bestSnr == null) return -1;
      return b.bestSnr - a.bestSnr;
    }
    return b.receptionCount - a.receptionCount;
  });
  const truncated = all.length > WALKABOUT_MAX_CELL_NODES;
  return { nodes: truncated ? all.slice(0, WALKABOUT_MAX_CELL_NODES) : all, truncated };
}

/** One loader per request: nodes for [sourceId] (both protocols), the two
 *  position filters with one shared grants object, and name lookups. */
export async function loadWalkaboutVisibility(
  user: unknown,
  sourceId: string,
): Promise<{
  visible: (r: WalkaboutReceptionPoint) => boolean;
  names: (r: WalkaboutReceptionPoint) => Names;
}> {
  const ids = [sourceId];
  const [nodesBySource, mcBySource, grants] = await Promise.all([
    loadNodesBySource(ids),
    loadMeshCoreNodesBySource(ids),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5891 req.user has no exported type
    loadSourcePermissions((user as any) ?? null),
  ]);
  const [posFilter, mcFilter] = await Promise.all([
    buildPositionFilter(user, ids, nodesBySource, grants),
    buildMeshCorePositionFilter(user, ids, mcBySource, grants),
  ]);
  const mtNames = new Map<number, Names>();
  for (const n of nodesBySource.get(sourceId) ?? []) {
    mtNames.set(Number(n.nodeNum), { longName: n.longName ?? null, shortName: n.shortName ?? null });
  }
  const mcNames = new Map<string, Names>();
  for (const n of mcBySource.get(sourceId) ?? []) {
    mcNames.set(n.publicKey.toLowerCase(), { longName: n.name ?? null, shortName: null });
  }
  const none: Names = { longName: null, shortName: null };
  return {
    visible: (r) =>
      r.protocol === 'meshcore'
        ? mcFilter({ sourceId, publicKey: r.creditedKey })
        : r.creditedNodeNum != null && posFilter({ sourceId, nodeNum: Number(r.creditedNodeNum) }),
    names: (r) =>
      (r.protocol === 'meshcore'
        ? mcNames.get(r.creditedKey.toLowerCase())
        : r.creditedNodeNum != null
          ? mtNames.get(Number(r.creditedNodeNum))
          : undefined) ?? none,
  };
}

/** A probe row for `node=X`, so the gate runs on the node itself even when it has no rows. */
function probeFor(node: string): WalkaboutReceptionPoint {
  const mc = isMeshCorePubKeyId(node);
  const num = !mc && /^![0-9a-f]{8}$/i.test(node) ? parseInt(node.slice(1), 16) : null;
  return {
    sessionId: '', protocol: mc ? 'meshcore' : 'meshtastic', creditedKey: node, creditedNodeNum: num,
    snr: null, heardAt: 0, latitude: 0, longitude: 0,
  };
}

/** Steps 1-3 of the read order: resolve, read at limit + 1, clip. */
async function readClipped(
  sourceId: string,
  q: WalkaboutMapQuery,
  opts: { bbox?: ReturnType<typeof walkaboutCellBBox>; samples: boolean },
) {
  const range = await resolveWalkaboutRange(sourceId, q);
  if (!range) return null;
  const repo = databaseService.coverageWalkabout;
  const sessionIds = range.sessions.map((s) => s.id);
  const base = { sessionIds, sinceMs: range.sinceMs, untilMs: range.untilMs, ...(opts.bbox ? { bbox: opts.bbox } : {}) };
  const [rxRaw, smRaw] = await Promise.all([
    repo.getReceptionPoints(sourceId, {
      ...base, ...(q.node !== undefined ? { creditedKey: q.node } : {}), limit: WALKABOUT_MAX_RX_ROWS + 1,
    }),
    opts.samples
      ? repo.getSamplePoints(sourceId, { ...base, limit: WALKABOUT_MAX_SAMPLE_ROWS + 1 })
      : Promise.resolve([] as WalkaboutSamplePoint[]),
  ]);
  const rxCut = rxRaw.length > WALKABOUT_MAX_RX_ROWS;
  const smCut = smRaw.length > WALKABOUT_MAX_SAMPLE_ROWS;
  const rx = clipToSessions(rxCut ? rxRaw.slice(0, WALKABOUT_MAX_RX_ROWS) : rxRaw, range.sessions, (r) => r.heardAt, range.sinceMs, range.untilMs);
  const samples = clipToSessions(smCut ? smRaw.slice(0, WALKABOUT_MAX_SAMPLE_ROWS) : smRaw, range.sessions, (r) => r.fixAt, range.sinceMs, range.untilMs);
  return { range, rx, samples, truncated: range.truncated || rxCut || smCut };
}

function boundsOf(points: Array<{ latitude: number; longitude: number }>): Bounds | null {
  if (points.length === 0) return null;
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const p of points) {
    if (p.latitude < s) s = p.latitude;
    if (p.latitude > n) n = p.latitude;
    if (p.longitude < w) w = p.longitude;
    if (p.longitude > e) e = p.longitude;
  }
  return { bboxSouth: s, bboxNorth: n, bboxWest: w, bboxEast: e };
}

export async function getWalkaboutCells(
  user: unknown,
  sourceId: string,
  q: WalkaboutMapQuery,
  res: WalkaboutH3Res,
): Promise<WalkaboutCellsResult | null> {
  const read = await readClipped(sourceId, q, { samples: true });
  if (!read) return null;
  const { range, rx, samples } = read;
  const vis = await loadWalkaboutVisibility(user, sourceId);
  const out = { res, windowStartAt: range.sinceMs, windowEndAt: range.untilMs };
  if (q.node !== undefined && !vis.visible(probeFor(q.node))) {
    return { ...out, cells: [], truncated: read.truncated, hiddenReceptionCount: 0, bounds: null };
  }
  const shown = rx.filter(vis.visible);
  const { cells, truncated } = binWalkaboutCells(shown, samples, res);
  return {
    ...out,
    cells,
    truncated: read.truncated || truncated,
    hiddenReceptionCount: rx.length - shown.length,
    bounds: boundsOf([...shown, ...samples]),
  };
}

export async function getWalkaboutCellNodes(
  user: unknown,
  sourceId: string,
  q: WalkaboutMapQuery,
  cell: string,
  res: WalkaboutH3Res,
): Promise<WalkaboutCellNodesResult | null> {
  const read = await readClipped(sourceId, q, { bbox: walkaboutCellBBox(cell), samples: false });
  if (!read) return null;
  const vis = await loadWalkaboutVisibility(user, sourceId);
  if (q.node !== undefined && !vis.visible(probeFor(q.node))) {
    return { cell, nodes: [], truncated: false };
  }
  const { nodes, truncated } = groupCellNodes(read.rx.filter(vis.visible), cell, res, vis.names);
  return { cell, nodes, truncated: read.truncated || truncated };
}

export async function getWalkaboutTrack(sourceId: string, sessionId: string): Promise<WalkaboutTrackResult | null> {
  const repo = databaseService.coverageWalkabout;
  const s = await repo.getSession(sourceId, sessionId);
  if (!s) return null;
  const sinceMs = s.startedAt;
  const untilMs = walkaboutEndsAt(s);
  const raw = await repo.getSamplePoints(sourceId, { sessionIds: [s.id], sinceMs, untilMs, limit: WALKABOUT_MAX_TRACK_POINTS + 1 });
  const truncated = raw.length > WALKABOUT_MAX_TRACK_POINTS;
  const clipped = clipToSessions(truncated ? raw.slice(0, WALKABOUT_MAX_TRACK_POINTS) : raw, [s], (r) => r.fixAt, sinceMs, untilMs);
  clipped.sort((a, b) => a.fixAt - b.fixAt);
  return { sessionId: s.id, positions: clipped.map((p) => [p.latitude, p.longitude] as [number, number]), truncated };
}
