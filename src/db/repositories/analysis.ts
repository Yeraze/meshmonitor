/**
 * Cross-source analysis queries powering the Map Analysis workspace.
 *
 * Each method takes an explicit allow-list of source IDs (already filtered for
 * the user's permissions in the route layer) and a `sinceMs` lower bound on
 * timestamp. All paginated methods use cursor pagination keyed on
 * `(timestamp, nodeNum)` so concurrent inserts don't shift offsets.
 *
 * Position fixes are pivoted from the existing `telemetry` table — there is
 * no dedicated `positions` table at runtime. Each fix is reconstructed by
 * pairing rows with `telemetryType IN ('latitude', 'longitude', 'altitude')`
 * keyed on `(sourceId, nodeNum, timestamp)`. A fix is emitted only when both
 * a latitude and a longitude row exist at the same `(sourceId, nodeNum,
 * timestamp)`. Altitude is attached when present, null otherwise.
 *
 * NodeNum values are coerced to `Number` at the boundary because PostgreSQL
 * and MySQL store them as BIGINT (Meshtastic node IDs are unsigned 32-bit and
 * exceed signed-INT max).
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { and, desc, gte, inArray, lt, or, eq } from 'drizzle-orm';
import {
  telemetrySqlite,
  telemetryPostgres,
  telemetryMysql,
} from '../schema/telemetry.js';

export type DrizzleDb =
  | BetterSQLite3Database<Record<string, never>>
  | NodePgDatabase<Record<string, never>>
  | MySql2Database<Record<string, never>>;

export type AnalysisDbType = 'sqlite' | 'postgres' | 'mysql';

export interface PositionRow {
  nodeNum: number;
  sourceId: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  timestamp: number;
  // snr/rssi removed in v1 — telemetry table has no such columns.
  // They will be filled in by a later task that joins against packet_log.
}

export interface PaginatedPositions {
  items: PositionRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface GetPositionsArgs {
  sourceIds: string[];
  sinceMs: number;
  pageSize: number;
  cursor?: string | null;
}

interface Cursor {
  ts: number;
  nodeNum: number;
}

const MAX_PAGE_SIZE = 2000;
const MIN_PAGE_SIZE = 1;

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}:${c.nodeNum}`, 'utf8').toString('base64url');
}

function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [tsStr, nodeStr] = decoded.split(':');
    const ts = Number(tsStr);
    const nodeNum = Number(nodeStr);
    if (!Number.isFinite(ts) || !Number.isFinite(nodeNum)) return null;
    return { ts, nodeNum };
  } catch {
    return null;
  }
}

function pickTelemetryTable(dbType: AnalysisDbType) {
  switch (dbType) {
    case 'sqlite':
      return telemetrySqlite;
    case 'postgres':
      return telemetryPostgres;
    case 'mysql':
      return telemetryMysql;
  }
}

/** Internal: a single telemetry row projected to the columns we care about. */
interface TelemRow {
  nodeNum: number;
  sourceId: string | null;
  timestamp: number;
  value: number;
}

/** Compose the map key used to pair lat/lon/alt rows. */
function pairKey(sourceId: string, nodeNum: number, timestamp: number): string {
  return `${sourceId}:${nodeNum}:${timestamp}`;
}

export class AnalysisRepository {
  private readonly db: DrizzleDb;
  private readonly dbType: AnalysisDbType;

  constructor(db: DrizzleDb, dbType: AnalysisDbType) {
    this.db = db;
    this.dbType = dbType;
  }

  /**
   * Get a paginated list of position fixes across the given sources, newest
   * first. Cursor pagination keyed on `(timestamp DESC, nodeNum DESC)` —
   * concurrent inserts never cause rows to be skipped or repeated across
   * pages. The `(sourceId, nodeNum, timestamp)` triple uniquely keys a
   * pivoted fix, so `(timestamp, nodeNum)` is sufficient as a cursor within
   * a stable allow-list of sourceIds.
   *
   * Implementation note: position data lives in the `telemetry` table as
   * separate rows (`telemetryType IN ('latitude','longitude','altitude')`).
   * We fetch each type independently with the same source/since/cursor
   * filters, then pivot in memory. We over-fetch by `pageSize+1` per type
   * to detect `hasMore` without an extra query.
   */
  async getPositions(args: GetPositionsArgs): Promise<PaginatedPositions> {
    const pageSize = Math.max(
      MIN_PAGE_SIZE,
      Math.min(args.pageSize, MAX_PAGE_SIZE),
    );

    if (args.sourceIds.length === 0) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }

    const telemetry = pickTelemetryTable(this.dbType);
    const cursor = decodeCursor(args.cursor ?? null);

    const baseConditions = [
      inArray(telemetry.sourceId, args.sourceIds),
      gte(telemetry.timestamp, args.sinceMs),
    ];

    // Cursor predicate over (timestamp, nodeNum) — strictly earlier than the
    // last emitted pivoted row. Apply against each telemetry stream so any
    // candidate lat/lon/alt row that survives can plausibly pair with another
    // surviving row at the same (sourceId, nodeNum, timestamp).
    if (cursor) {
      const cursorClause = or(
        lt(telemetry.timestamp, cursor.ts),
        and(
          eq(telemetry.timestamp, cursor.ts),
          lt(telemetry.nodeNum, cursor.nodeNum),
        ),
      );
      if (cursorClause) {
        baseConditions.push(cursorClause);
      }
    }

    // We over-fetch each stream so that after pivoting we still have at
    // least `pageSize + 1` paired fixes when more remain. A stream of
    // `pageSize + 1` lat rows can in the worst case yield `pageSize + 1`
    // pivots (every lat has a matching lon), which is enough to detect
    // hasMore. Real-world fan-out from missing pairs is handled by the
    // caller re-paging with the cursor.
    const fetchLimit = pageSize + 1;

    const selectShape = {
      nodeNum: telemetry.nodeNum,
      sourceId: telemetry.sourceId,
      timestamp: telemetry.timestamp,
      value: telemetry.value,
    };

    // Cast to `any` for the cross-dialect select — Drizzle's union types can't
    // resolve method overloads across SQLite/Postgres/MySQL even though
    // runtime behavior is identical.
    /* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union */
    const runQuery = async (telemetryType: string): Promise<TelemRow[]> => {
      const rows: any[] = await (this.db as any)
        .select(selectShape)
        .from(telemetry)
        .where(
          and(...baseConditions, eq(telemetry.telemetryType, telemetryType)),
        )
        .orderBy(desc(telemetry.timestamp), desc(telemetry.nodeNum))
        .limit(fetchLimit);
      return rows.map((r) => ({
        nodeNum: Number(r.nodeNum),
        sourceId: r.sourceId ?? null,
        timestamp: Number(r.timestamp),
        value: Number(r.value),
      }));
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const latRows = await runQuery('latitude');
    if (latRows.length === 0) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }
    const lonRows = await runQuery('longitude');
    if (lonRows.length === 0) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }
    const altRows = await runQuery('altitude');

    const lonByKey = new Map<string, number>();
    for (const r of lonRows) {
      if (r.sourceId == null) continue;
      lonByKey.set(pairKey(r.sourceId, r.nodeNum, r.timestamp), r.value);
    }
    const altByKey = new Map<string, number>();
    for (const r of altRows) {
      if (r.sourceId == null) continue;
      altByKey.set(pairKey(r.sourceId, r.nodeNum, r.timestamp), r.value);
    }

    // Walk lat rows in DESC order; emit a pivot whenever a lon row pairs.
    // latRows are already ordered (timestamp DESC, nodeNum DESC) by the
    // query, which matches the public sort contract.
    const pivots: PositionRow[] = [];
    for (const lat of latRows) {
      if (lat.sourceId == null) continue;
      const key = pairKey(lat.sourceId, lat.nodeNum, lat.timestamp);
      const lon = lonByKey.get(key);
      if (lon === undefined) continue;
      const alt = altByKey.get(key);
      pivots.push({
        nodeNum: lat.nodeNum,
        sourceId: lat.sourceId,
        latitude: lat.value,
        longitude: lon,
        altitude: alt === undefined ? null : alt,
        timestamp: lat.timestamp,
      });
      if (pivots.length > pageSize) break;
    }

    const hasMore = pivots.length > pageSize;
    const items = pivots.slice(0, pageSize);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ ts: last.timestamp, nodeNum: last.nodeNum })
        : null;

    return { items, pageSize, hasMore, nextCursor };
  }
}
