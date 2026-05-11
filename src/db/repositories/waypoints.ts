/**
 * Waypoints Repository
 *
 * Per-source storage for Meshtastic waypoints (PortNum.WAYPOINT_APP).
 * Composite primary key (sourceId, waypointId).
 */
import { and, asc, eq, gte, lte, lt, isNull, or, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface Waypoint {
  sourceId: string;
  waypointId: number;
  ownerNodeNum: number | null;
  latitude: number;
  longitude: number;
  expireAt: number | null;
  lockedTo: number | null;
  name: string;
  description: string;
  iconCodepoint: number | null;
  iconEmoji: string | null;
  isVirtual: boolean;
  rebroadcastIntervalS: number | null;
  lastBroadcastAt: number | null;
  firstSeenAt: number;
  lastUpdatedAt: number;
}

export interface WaypointUpsertInput {
  sourceId: string;
  waypointId: number;
  ownerNodeNum?: number | null;
  latitude: number;
  longitude: number;
  expireAt?: number | null;
  lockedTo?: number | null;
  name?: string;
  description?: string;
  iconCodepoint?: number | null;
  iconEmoji?: string | null;
  isVirtual?: boolean;
  rebroadcastIntervalS?: number | null;
  lastBroadcastAt?: number | null;
}

export interface WaypointListOptions {
  includeExpired?: boolean;
  bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

function deserializeRow(row: any): Waypoint {
  return {
    sourceId: String(row.sourceId),
    waypointId: Number(row.waypointId),
    ownerNodeNum: row.ownerNodeNum == null ? null : Number(row.ownerNodeNum),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    expireAt: row.expireAt == null ? null : Number(row.expireAt),
    lockedTo: row.lockedTo == null ? null : Number(row.lockedTo),
    name: row.name ?? '',
    description: row.description ?? '',
    iconCodepoint: row.iconCodepoint == null ? null : Number(row.iconCodepoint),
    iconEmoji: row.iconEmoji ?? null,
    isVirtual: Boolean(row.isVirtual),
    rebroadcastIntervalS: row.rebroadcastIntervalS == null ? null : Number(row.rebroadcastIntervalS),
    lastBroadcastAt: row.lastBroadcastAt == null ? null : Number(row.lastBroadcastAt),
    firstSeenAt: Number(row.firstSeenAt),
    lastUpdatedAt: Number(row.lastUpdatedAt),
  };
}

export class WaypointsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert or update a waypoint, keyed on (sourceId, waypointId).
   * Returns the persisted row.
   */
  async upsertAsync(input: WaypointUpsertInput): Promise<Waypoint> {
    const { waypoints } = this.tables;
    const now = this.now();

    // Look up the existing row to preserve firstSeenAt and merge optional fields
    const existing = await this.getAsync(input.sourceId, input.waypointId);
    const firstSeenAt = existing?.firstSeenAt ?? now;

    const values = {
      sourceId: input.sourceId,
      waypointId: input.waypointId,
      ownerNodeNum: input.ownerNodeNum ?? existing?.ownerNodeNum ?? null,
      latitude: input.latitude,
      longitude: input.longitude,
      expireAt: input.expireAt === undefined ? existing?.expireAt ?? null : input.expireAt,
      lockedTo: input.lockedTo === undefined ? existing?.lockedTo ?? null : input.lockedTo,
      name: input.name ?? existing?.name ?? '',
      description: input.description ?? existing?.description ?? '',
      iconCodepoint:
        input.iconCodepoint === undefined ? existing?.iconCodepoint ?? null : input.iconCodepoint,
      iconEmoji: input.iconEmoji === undefined ? existing?.iconEmoji ?? null : input.iconEmoji,
      isVirtual: (input.isVirtual ?? existing?.isVirtual ?? false) ? 1 : 0,
      rebroadcastIntervalS:
        input.rebroadcastIntervalS === undefined
          ? existing?.rebroadcastIntervalS ?? null
          : input.rebroadcastIntervalS,
      lastBroadcastAt:
        input.lastBroadcastAt === undefined
          ? existing?.lastBroadcastAt ?? null
          : input.lastBroadcastAt,
      firstSeenAt,
      lastUpdatedAt: now,
    };

    if (existing) {
      await this.db
        .update(waypoints)
        .set(values)
        .where(and(eq(waypoints.sourceId, input.sourceId), eq(waypoints.waypointId, input.waypointId)));
    } else {
      await this.db.insert(waypoints).values(values);
    }

    const row = await this.getAsync(input.sourceId, input.waypointId);
    if (!row) throw new Error('Failed to persist waypoint');
    return row;
  }

  /**
   * Fetch a single waypoint by composite key.
   */
  async getAsync(sourceId: string, waypointId: number): Promise<Waypoint | null> {
    const { waypoints } = this.tables;
    const rows = await this.db
      .select()
      .from(waypoints)
      .where(and(eq(waypoints.sourceId, sourceId), eq(waypoints.waypointId, waypointId)))
      .limit(1);
    return rows.length > 0 ? deserializeRow(rows[0]) : null;
  }

  /**
   * List waypoints for a source. Excludes expired rows by default
   * (expireAt < now); pass includeExpired to keep them.
   */
  async listAsync(sourceId: string, options: WaypointListOptions = {}): Promise<Waypoint[]> {
    const { waypoints } = this.tables;
    const conditions = [eq(waypoints.sourceId, sourceId)];

    if (!options.includeExpired) {
      const now = Math.floor(Date.now() / 1000);
      // expireAt is in epoch seconds; null/0 means "never expires"
      conditions.push(
        or(
          isNull(waypoints.expireAt),
          eq(waypoints.expireAt, 0),
          gte(waypoints.expireAt, now),
        )!,
      );
    }

    if (options.bbox) {
      const { minLat, maxLat, minLon, maxLon } = options.bbox;
      conditions.push(gte(waypoints.latitude, minLat));
      conditions.push(lte(waypoints.latitude, maxLat));
      conditions.push(gte(waypoints.longitude, minLon));
      conditions.push(lte(waypoints.longitude, maxLon));
    }

    const rows = await this.db.select().from(waypoints).where(and(...conditions));
    return rows.map(deserializeRow);
  }

  /**
   * Delete a single waypoint. Returns true if a row was removed.
   */
  async deleteAsync(sourceId: string, waypointId: number): Promise<boolean> {
    const { waypoints } = this.tables;
    const result = await this.executeRun(
      this.db
        .delete(waypoints)
        .where(and(eq(waypoints.sourceId, sourceId), eq(waypoints.waypointId, waypointId))),
    );
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Find waypoint ids that exist for a source. Used to generate non-colliding
   * local ids without round-tripping the full row payload.
   */
  async getExistingIdsAsync(sourceId: string): Promise<Set<number>> {
    const { waypoints } = this.tables;
    const rows = await this.db
      .select({ id: waypoints.waypointId })
      .from(waypoints)
      .where(eq(waypoints.sourceId, sourceId));
    return new Set(rows.map((r: any) => Number(r.id)));
  }

  /**
   * Pick the single oldest waypoint that is eligible to be rebroadcast right
   * now. Eligibility:
   *   - `rebroadcastIntervalS` is non-null and > 0
   *   - `isVirtual` is false (virtual waypoints never go out on the mesh)
   *   - waypoint is not expired (`expireAt` null/0, or in the future)
   *   - either `lastBroadcastAt` is NULL, or
   *     `now - lastBroadcastAt >= rebroadcastIntervalS`
   *
   * Ordering: NULL `lastBroadcastAt` first (never broadcast = highest priority),
   * then by ascending `lastBroadcastAt` so rotation is fair. `LIMIT 1` keeps
   * the airtime floor strict — the scheduler picks at most one per tick.
   *
   * Times are in epoch seconds to match `rebroadcastIntervalS` and `expireAt`.
   */
  async findOldestEligibleForRebroadcastAsync(nowSec: number): Promise<Waypoint | null> {
    const { waypoints } = this.tables;

    const rows = await this.db
      .select()
      .from(waypoints)
      .where(
        and(
          eq(waypoints.isVirtual, 0),
          sql`${waypoints.rebroadcastIntervalS} IS NOT NULL`,
          sql`${waypoints.rebroadcastIntervalS} > 0`,
          or(
            isNull(waypoints.expireAt),
            eq(waypoints.expireAt, 0),
            gte(waypoints.expireAt, nowSec),
          )!,
          or(
            isNull(waypoints.lastBroadcastAt),
            sql`${nowSec} - ${waypoints.lastBroadcastAt} >= ${waypoints.rebroadcastIntervalS}`,
          )!,
        ),
      )
      // NULL lastBroadcastAt sorts first in SQLite/PostgreSQL by default;
      // MySQL also puts NULLs first under ASC. Then fall back to oldest.
      .orderBy(asc(waypoints.lastBroadcastAt))
      .limit(1);

    return rows.length > 0 ? deserializeRow(rows[0]) : null;
  }

  /**
   * Stamp `lastBroadcastAt = nowSec` for a single waypoint. Returns true if a
   * row was updated. Used by the rebroadcast scheduler immediately after a
   * successful mesh send so the same waypoint is not picked again on the next
   * tick.
   */
  async markRebroadcastedAsync(sourceId: string, waypointId: number, nowSec: number): Promise<boolean> {
    const { waypoints } = this.tables;
    const result = await this.executeRun(
      this.db
        .update(waypoints)
        .set({ lastBroadcastAt: nowSec })
        .where(and(eq(waypoints.sourceId, sourceId), eq(waypoints.waypointId, waypointId))),
    );
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Delete every row whose expireAt is non-null and older than (now - graceSeconds).
   * Returns the deleted rows so callers can emit per-source cleanup events.
   */
  async sweepExpiredAsync(graceSeconds = 86400): Promise<Waypoint[]> {
    const { waypoints } = this.tables;
    const cutoff = Math.floor(Date.now() / 1000) - graceSeconds;

    const stale = await this.db
      .select()
      .from(waypoints)
      .where(and(sql`${waypoints.expireAt} IS NOT NULL`, lt(waypoints.expireAt, cutoff)));

    if (stale.length === 0) return [];

    await this.executeRun(
      this.db
        .delete(waypoints)
        .where(and(sql`${waypoints.expireAt} IS NOT NULL`, lt(waypoints.expireAt, cutoff))),
    );

    return stale.map(deserializeRow);
  }
}
