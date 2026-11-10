/**
 * Confirmed new-neighbour tracker (#6274).
 *
 * A MeshCore repeater's neighbour table is replaced on every poll, so it
 * cannot say how long a neighbour has been around. This keeps a per-reporter
 * ledger (`meshcore_neighbor_watch`) of first-seen and last-heard times and
 * emits `neighbor:sighting` for a still-pending newcomer, so
 * `trigger.neighborAdded` can fire once it has stayed for the configured time.
 *
 * Reads the DB and writes the DB only: zero airtime, no timers, no new polls.
 * All state is persisted, so a restart or a settings save re-arms nothing.
 *
 * Callers pass ONLY the rows a poll actually returned, never rows carried over
 * from an earlier read (their ages are extrapolated, not observed).
 */
import type {
  MeshCoreNeighborWatchRow,
  MeshCoreNeighborWatchState,
} from '../../db/repositories/meshcore.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A returned row older than this is not a sighting; it drops a pending row. */
export const STALE_MS = 24 * HOUR_MS;
/** A pending row with no sighting for this long is discarded. */
export const NO_SIGHTING_MS = 7 * DAY_MS;
/** A pending row seen across this span becomes confirmed and stops emitting. */
export const MAX_CONFIRM_MS = 14 * DAY_MS;
/** Baseline and confirmed rows unseen this long are pruned (a return counts as new). */
export const PRUNE_MS = 30 * DAY_MS;
/** Baseline and confirmed rows refresh their lastHeardAt at most this often. */
export const REFRESH_MS = HOUR_MS;

/** One neighbour row from a poll. `heardSecondsAgo` is relative to the reporter's clock. */
export interface FreshNeighbour {
  neighborKey: string;
  heardSecondsAgo: number | null;
  snr: number | null;
}

export interface NeighborSightingEvent {
  reporterPublicKey: string;
  neighborPublicKey: string;
  firstSeenAt: number;
  prevLastHeardAt: number;
  lastHeardAt: number;
  snr: number | null;
  sightings: number;
}

export interface NeighborWatchPlan {
  upserts: MeshCoreNeighborWatchRow[];
  deletes: string[];
  events: Array<Omit<NeighborSightingEvent, 'reporterPublicKey'>>;
}

export interface NeighborWatchOptions {
  pollAtMs: number;
  /** The read was complete and not truncated: absence is evidence. */
  complete: boolean;
  /** The reporter has had its first evaluation. */
  baselined: boolean;
}

/**
 * Pure planner. Given the stored ledger for one reporter and the rows one poll
 * returned, decide what to write, delete and emit.
 */
export function planNeighborWatch(
  prevRows: MeshCoreNeighborWatchRow[],
  fresh: FreshNeighbour[],
  opts: NeighborWatchOptions,
): NeighborWatchPlan {
  const { pollAtMs, complete, baselined } = opts;
  const plan: NeighborWatchPlan = { upserts: [], deletes: [], events: [] };
  const prev = new Map(prevRows.map((r) => [r.neighborPublicKey, r]));

  // Latest reading per key if a poll names one twice.
  const seen = new Map<string, FreshNeighbour>();
  for (const f of fresh) seen.set(f.neighborKey, f);

  const stateRow = (
    key: string,
    state: MeshCoreNeighborWatchState,
    firstSeenAt: number,
    lastHeardAt: number,
    snr: number | null,
    sightings: number,
  ): MeshCoreNeighborWatchRow => ({ neighborPublicKey: key, state, firstSeenAt, lastHeardAt, lastSnr: snr, sightings });

  if (!baselined) {
    // First evaluation: whatever is listed now is the baseline. No events.
    for (const f of seen.values()) {
      const heardAt = heardAtOf(f, pollAtMs);
      plan.upserts.push(stateRow(f.neighborKey, 'baseline', heardAt, heardAt, f.snr, 1));
    }
    return plan;
  }

  for (const f of seen.values()) {
    const key = f.neighborKey;
    const ageMs = ageMsOf(f);
    const heardAt = heardAtOf(f, pollAtMs);
    let row = prev.get(key);

    // A row too old to be a live sighting: drop a pending one, ignore otherwise.
    if (ageMs > STALE_MS) {
      if (row?.state === 'pending') plan.deletes.push(key);
      continue;
    }

    // A stored row that has gone cold counts as gone: a return is new.
    if (row && isCold(row, pollAtMs)) {
      plan.deletes.push(key); // replaced below by the upsert on the same key
      row = undefined;
    }

    if (!row) {
      plan.upserts.push(stateRow(key, 'pending', heardAt, heardAt, f.snr, 1));
      continue;
    }

    if (row.state === 'pending') {
      if (heardAt <= row.lastHeardAt) continue; // the same observation again
      const lastHeardAt = Math.max(row.lastHeardAt, heardAt);
      const sightings = row.sightings + 1;
      plan.events.push({
        neighborPublicKey: key,
        firstSeenAt: row.firstSeenAt,
        prevLastHeardAt: row.lastHeardAt,
        lastHeardAt,
        snr: f.snr,
        sightings,
      });
      const state: MeshCoreNeighborWatchState = lastHeardAt - row.firstSeenAt >= MAX_CONFIRM_MS ? 'confirmed' : 'pending';
      plan.upserts.push(stateRow(key, state, row.firstSeenAt, lastHeardAt, f.snr, sightings));
      continue;
    }

    // baseline / confirmed: keep fresh, but write at most hourly.
    if (heardAt - row.lastHeardAt >= REFRESH_MS) {
      plan.upserts.push(stateRow(key, row.state, row.firstSeenAt, heardAt, f.snr ?? row.lastSnr, row.sightings + 1));
    }
  }

  // Rows the poll did not return.
  for (const row of prevRows) {
    if (seen.has(row.neighborPublicKey)) continue;
    if (row.state === 'pending') {
      // Absence from a partial read is not evidence; absence from a complete one is.
      if (complete || pollAtMs - row.lastHeardAt > NO_SIGHTING_MS) plan.deletes.push(row.neighborPublicKey);
    } else if (pollAtMs - row.lastHeardAt > PRUNE_MS) {
      plan.deletes.push(row.neighborPublicKey);
    }
  }

  return plan;
}

function ageMsOf(f: FreshNeighbour): number {
  const secs = f.heardSecondsAgo;
  return secs != null && Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

function heardAtOf(f: FreshNeighbour, pollAtMs: number): number {
  return pollAtMs - ageMsOf(f);
}

function isCold(row: MeshCoreNeighborWatchRow, pollAtMs: number): boolean {
  const idle = pollAtMs - row.lastHeardAt;
  return row.state === 'pending' ? idle > NO_SIGHTING_MS : idle > PRUNE_MS;
}

/** The repository slice the adapter needs. */
export interface NeighborWatchRepo {
  getNeighborWatch(sourceId: string, reporter: string): Promise<MeshCoreNeighborWatchRow[]>;
  applyNeighborWatchChanges(
    sourceId: string,
    reporter: string,
    upserts: MeshCoreNeighborWatchRow[],
    deleteKeys: string[],
  ): Promise<void>;
  getNeighborWatchBaselinedAt(sourceId: string, reporter: string): Promise<number | null>;
  setNeighborWatchBaselined(sourceId: string, reporter: string, atMs: number): Promise<void>;
  pruneNeighborWatch(sourceId: string, olderThanMs: number): Promise<number>;
  /** Optional: resolves the reporter's name for the event. */
  getNodeByPublicKeyAndSource?(publicKey: string, sourceId: string): Promise<{ name?: string | null } | null>;
}

const lastPruneAt = new Map<string, number>();

/**
 * Observe one poll of a reporter's neighbour table. Never throws: a tracker
 * failure must not break neighbour storage.
 */
export async function observeNeighbours(
  repo: NeighborWatchRepo,
  sourceId: string,
  reporterKey: string,
  fresh: FreshNeighbour[],
  opts: { complete: boolean; pollAtMs: number },
): Promise<void> {
  try {
    if (!sourceId || !reporterKey) return;
    const baselinedAt = await repo.getNeighborWatchBaselinedAt(sourceId, reporterKey);
    const prevRows = await repo.getNeighborWatch(sourceId, reporterKey);
    const plan = planNeighborWatch(prevRows, fresh, {
      pollAtMs: opts.pollAtMs,
      complete: opts.complete,
      baselined: baselinedAt != null,
    });
    // A key replaced in place (cold row, returning neighbour) is upserted, not deleted.
    const upsertKeys = new Set(plan.upserts.map((u) => u.neighborPublicKey));
    const deletes = plan.deletes.filter((k) => !upsertKeys.has(k));
    if (plan.upserts.length > 0 || deletes.length > 0) {
      await repo.applyNeighborWatchChanges(sourceId, reporterKey, plan.upserts, deletes);
    }
    if (baselinedAt == null) await repo.setNeighborWatchBaselined(sourceId, reporterKey, opts.pollAtMs);

    if (plan.events.length > 0) {
      let reporterName: string | null = null;
      try {
        reporterName = (await repo.getNodeByPublicKeyAndSource?.(reporterKey, sourceId))?.name ?? null;
      } catch {
        // the name is a nicety; the event goes out without it
      }
      for (const e of plan.events) {
        dataEventEmitter.emitNeighborSighting({ ...e, reporterPublicKey: reporterKey, reporterName }, sourceId);
      }
    }

    // Hourly sweep of rows no reporter has refreshed for 30 days.
    const last = lastPruneAt.get(sourceId) ?? 0;
    if (opts.pollAtMs - last >= HOUR_MS) {
      lastPruneAt.set(sourceId, opts.pollAtMs);
      await repo.pruneNeighborWatch(sourceId, opts.pollAtMs - PRUNE_MS);
    }
  } catch (e) {
    logger.warn(
      `Neighbour watch failed for ${reporterKey.substring(0, 12)}… (source ${sourceId}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
