/**
 * Aircraft flight matches repository (ADS-B flight matching, #5374).
 *
 * One row per (sourceId, nodeNum) — the current likely-aircraft flagging
 * ("episode") and the ADS-B lookups spent on it. `lookups` is the DB-backed
 * per-episode cap, so every write that spends a lookup is conditional on the
 * lookup count (and episode) it read: two racing writers cannot both spend
 * the same lookup, and a lookup that finishes after a new episode began
 * cannot write into it.
 *
 * `rechecks` (#5876) caps the re-checks that follow the two lookups the same
 * way: `recordRecheck` is conditional on the re-check count and episode it
 * read.
 *
 * Every method is source-scoped via `withSourceScope`.
 */
import { and, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type FlightMatchStatus = 'none' | 'possible' | 'matched';

export interface AircraftFlightMatchRow {
  sourceId: string;
  nodeNum: number;
  episodeStartedAt: number;
  lookups: number;
  firstLookupAt: number | null;
  status: FlightMatchStatus;
  feed: string | null;
  hex: string | null;
  callsign: string | null;
  aircraftType: string | null;
  registration: string | null;
  gsKt: number | null;
  trackDeg: number | null;
  altM: number | null;
  distanceKm: number | null;
  matchedAt: number | null;
  /** ms; the last lookup or re-check that ran (null on rows from before #5876). */
  lastLookupAt: number | null;
  /** The node's position at that lookup. */
  lastLookupLat: number | null;
  lastLookupLon: number | null;
  /** Re-checks spent in this episode. */
  rechecks: number;
  /** Consecutive re-checks with no hit. */
  misses: number;
}

/** Where and when a lookup ran — the baseline the next re-check compares against. */
export interface FlightMatchLookupPoint {
  at: number;
  lat: number;
  lon: number;
}

/** The match fields a lookup writes when it changes the status. */
export interface FlightMatchResultWrite {
  status: FlightMatchStatus;
  feed: string | null;
  hex: string | null;
  callsign: string | null;
  aircraftType: string | null;
  registration: string | null;
  gsKt: number | null;
  trackDeg: number | null;
  altM: number | null;
  distanceKm: number | null;
  matchedAt: number;
}

export interface FlightMatchLookupWrite {
  /** The episode the lookup belongs to; the write is dropped if a new one began. */
  episodeStartedAt: number;
  /** The `lookups` value the caller read; the write is dropped if it changed. */
  lookupsBefore: number;
  /** Set on lookup 1 only. */
  firstLookupAt?: number;
  /** Omit to spend the lookup but keep the previous status and fields. */
  result?: FlightMatchResultWrite;
  /** Where and when this lookup ran. */
  point?: FlightMatchLookupPoint;
}

export interface FlightMatchRecheckWrite {
  /** The episode the re-check belongs to; the write is dropped if a new one began. */
  episodeStartedAt: number;
  /** The `rechecks` value the caller read; the write is dropped if it changed. */
  rechecksBefore: number;
  /** The new consecutive-miss count. */
  misses: number;
  /** Where and when this re-check ran. */
  point: FlightMatchLookupPoint;
  /** Omit to keep the previous status and fields. */
  result?: FlightMatchResultWrite;
}

const EMPTY_MATCH = {
  status: 'none' as FlightMatchStatus,
  feed: null,
  hex: null,
  callsign: null,
  aircraftType: null,
  registration: null,
  gsKt: null,
  trackDeg: null,
  altM: null,
  distanceKm: null,
  matchedAt: null,
};

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStatus(v: unknown): FlightMatchStatus {
  return v === 'possible' || v === 'matched' ? v : 'none';
}

export class AircraftFlightMatchesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private mapRow(r: Record<string, unknown>): AircraftFlightMatchRow {
    return {
      sourceId: String(r.sourceId),
      nodeNum: Number(r.nodeNum),
      episodeStartedAt: Number(r.episodeStartedAt),
      lookups: Number(r.lookups ?? 0),
      firstLookupAt: numOrNull(r.firstLookupAt),
      status: toStatus(r.status),
      feed: (r.feed as string | null) ?? null,
      hex: (r.hex as string | null) ?? null,
      callsign: (r.callsign as string | null) ?? null,
      aircraftType: (r.aircraftType as string | null) ?? null,
      registration: (r.registration as string | null) ?? null,
      gsKt: numOrNull(r.gsKt),
      trackDeg: numOrNull(r.trackDeg),
      altM: numOrNull(r.altM),
      distanceKm: numOrNull(r.distanceKm),
      matchedAt: numOrNull(r.matchedAt),
      lastLookupAt: numOrNull(r.lastLookupAt),
      lastLookupLat: numOrNull(r.lastLookupLat),
      lastLookupLon: numOrNull(r.lastLookupLon),
      rechecks: Number(r.rechecks ?? 0),
      misses: Number(r.misses ?? 0),
    };
  }

  async get(sourceId: string, nodeNum: number): Promise<AircraftFlightMatchRow | null> {
    const t = this.tables.aircraftFlightMatches;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.nodeNum, nodeNum)))
      .limit(1);
    const normalized = this.normalizeBigInts(rows) as Array<Record<string, unknown>>;
    return normalized[0] ? this.mapRow(normalized[0]) : null;
  }

  /**
   * Open a new flagging for the node: upsert the row with `lookups` 0, status
   * `'none'` and every match field cleared.
   */
  async startEpisode(sourceId: string, nodeNum: number, episodeStartedAt: number): Promise<void> {
    if (!sourceId) throw new Error('startEpisode: sourceId is required');
    const t = this.tables.aircraftFlightMatches;
    const reset = {
      episodeStartedAt,
      lookups: 0,
      firstLookupAt: null,
      ...EMPTY_MATCH,
      lastLookupAt: null,
      lastLookupLat: null,
      lastLookupLon: null,
      rechecks: 0,
      misses: 0,
    };
    await this.upsert(t, { sourceId, nodeNum, ...reset }, [t.sourceId, t.nodeNum], reset);
  }

  /**
   * Spend one lookup. Returns false (and writes nothing) when the row's
   * episode or lookup count no longer match what the caller read.
   */
  async recordLookup(sourceId: string, nodeNum: number, write: FlightMatchLookupWrite): Promise<boolean> {
    const t = this.tables.aircraftFlightMatches;
    const set: Record<string, unknown> = { lookups: write.lookupsBefore + 1 };
    if (write.firstLookupAt !== undefined) set.firstLookupAt = write.firstLookupAt;
    if (write.result) Object.assign(set, write.result);
    if (write.point) {
      set.lastLookupAt = write.point.at;
      set.lastLookupLat = write.point.lat;
      set.lastLookupLon = write.point.lon;
    }
    const result = await this.db
      .update(t)
      .set(set)
      .where(and(
        this.withSourceScope(t, sourceId),
        eq(t.nodeNum, nodeNum),
        eq(t.episodeStartedAt, write.episodeStartedAt),
        eq(t.lookups, write.lookupsBefore),
      ));
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Spend one re-check (#5876). Returns false (and writes nothing) when the
   * row's episode or re-check count no longer match what the caller read.
   */
  async recordRecheck(sourceId: string, nodeNum: number, write: FlightMatchRecheckWrite): Promise<boolean> {
    const t = this.tables.aircraftFlightMatches;
    const set: Record<string, unknown> = {
      rechecks: write.rechecksBefore + 1,
      misses: write.misses,
      lastLookupAt: write.point.at,
      lastLookupLat: write.point.lat,
      lastLookupLon: write.point.lon,
    };
    if (write.result) Object.assign(set, write.result);
    const result = await this.db
      .update(t)
      .set(set)
      .where(and(
        this.withSourceScope(t, sourceId),
        eq(t.nodeNum, nodeNum),
        eq(t.episodeStartedAt, write.episodeStartedAt),
        eq(t.rechecks, write.rechecksBefore),
      ));
    return this.getAffectedRows(result) > 0;
  }

  async deleteForNode(sourceId: string, nodeNum: number): Promise<number> {
    const t = this.tables.aircraftFlightMatches;
    const result = await this.db
      .delete(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.nodeNum, nodeNum)));
    return this.getAffectedRows(result);
  }
}
