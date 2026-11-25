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
  _sourceId: string,
  _q: WalkaboutMapQuery,
  _nowMs?: number,
): Promise<ResolvedRange | null> {
  throw new Error('not implemented');
}

/** Keep rows with session.startedAt <= t <= walkaboutEndsAt(session), and
 *  inside [sinceMs, untilMs]. Receptions clip on heardAt, samples on fixAt. */
export function clipToSessions<T extends { sessionId: string }>(
  _rows: T[],
  _sessions: DbWalkaboutSession[],
  _at: (r: T) => number,
  _sinceMs: number,
  _untilMs: number,
): T[] {
  throw new Error('not implemented');
}

/** Bin with walkaboutCellOf. Per cell: max non-null snr, count, distinct
 *  creditedKey, sample count. Sort receptionCount desc, then sampleCount
 *  desc, then cell; cut at WALKABOUT_MAX_CELLS (truncated). */
export function binWalkaboutCells(
  _rx: WalkaboutReceptionPoint[],
  _samples: WalkaboutSamplePoint[],
  _res: WalkaboutH3Res,
): { cells: WalkaboutCellDto[]; truncated: boolean } {
  throw new Error('not implemented');
}

/** Rows of one cell grouped by creditedKey. Sort bestSnr desc (nulls last),
 *  then receptionCount desc; cut at WALKABOUT_MAX_CELL_NODES. */
export function groupCellNodes(
  _rx: WalkaboutReceptionPoint[],
  _cell: string,
  _res: WalkaboutH3Res,
  _names: (row: WalkaboutReceptionPoint) => { longName: string | null; shortName: string | null },
): { nodes: WalkaboutCellNodeDto[]; truncated: boolean } {
  throw new Error('not implemented');
}

/** One loader per request: nodes for [sourceId] (both protocols), the two
 *  position filters with one shared grants object, and name lookups. */
export async function loadWalkaboutVisibility(
  _user: unknown,
  _sourceId: string,
): Promise<{
  visible: (r: WalkaboutReceptionPoint) => boolean;
  names: (r: WalkaboutReceptionPoint) => { longName: string | null; shortName: string | null };
}> {
  throw new Error('not implemented');
}

export async function getWalkaboutCells(
  _user: unknown,
  _sourceId: string,
  _q: WalkaboutMapQuery,
  _res: WalkaboutH3Res,
): Promise<WalkaboutCellsResult | null> {
  throw new Error('not implemented');
}

export async function getWalkaboutCellNodes(
  _user: unknown,
  _sourceId: string,
  _q: WalkaboutMapQuery,
  _cell: string,
  _res: WalkaboutH3Res,
): Promise<WalkaboutCellNodesResult | null> {
  throw new Error('not implemented');
}

export async function getWalkaboutTrack(_sourceId: string, _sessionId: string): Promise<WalkaboutTrackResult | null> {
  throw new Error('not implemented');
}
