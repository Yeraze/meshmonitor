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
import {
  traceroutesSqlite,
  traceroutesPostgres,
  traceroutesMysql,
} from '../schema/traceroutes.js';
import {
  neighborInfoSqlite,
  neighborInfoPostgres,
  neighborInfoMysql,
} from '../schema/neighbors.js';

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

/** Cursor for `(timestamp DESC, id DESC)` keyed pagination. */
interface IdCursor {
  ts: number;
  id: number;
}

export interface TracerouteRow {
  id: number;
  fromNodeNum: number;
  toNodeNum: number;
  sourceId: string;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  timestamp: number;
  createdAt: number;
}

export interface PaginatedTraceroutes {
  items: TracerouteRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface GetTraceroutesArgs {
  sourceIds: string[];
  sinceMs: number;
  pageSize: number;
  cursor?: string | null;
}

export interface NeighborRow {
  id: number;
  nodeNum: number;
  neighborNum: number;
  sourceId: string;
  snr: number | null;
  timestamp: number;
}

export interface NeighborsResult {
  items: NeighborRow[];
}

export interface GetNeighborsArgs {
  sourceIds: string[];
  sinceMs: number;
}

export interface GridCell {
  latBin: number;
  lonBin: number;
  centerLat: number;
  centerLon: number;
  count: number;
}

export interface CoverageGridResult {
  cells: GridCell[];
  binSizeDeg: number;
}

export interface GetCoverageGridArgs {
  sourceIds: string[];
  sinceMs: number;
  zoom: number;
}

export interface HopEntry {
  sourceId: string;
  nodeNum: number;
  hops: number;
}

export interface HopCountsResult {
  entries: HopEntry[];
}

export interface GetHopCountsArgs {
  sourceIds: string[];
}

/**
 * Convert a slippy-map zoom level to a bin size in degrees. Lower zoom →
 * larger bins (coarser overview); higher zoom → finer bins. Clamped to
 * [1, 20]; the default zoom of 12 yields ~0.04° bins.
 */
function binSizeForZoom(zoom: number): number {
  const z = Math.max(1, Math.min(20, zoom));
  return Math.pow(2, 8 - z) * 0.01;
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

function encodeIdCursor(c: IdCursor): string {
  return Buffer.from(`${c.ts}:${c.id}`, 'utf8').toString('base64url');
}

function decodeIdCursor(s: string | null | undefined): IdCursor | null {
  if (!s) return null;
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [tsStr, idStr] = decoded.split(':');
    const ts = Number(tsStr);
    const id = Number(idStr);
    if (!Number.isFinite(ts) || !Number.isFinite(id)) return null;
    return { ts, id };
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

function pickTraceroutesTable(dbType: AnalysisDbType) {
  switch (dbType) {
    case 'sqlite':
      return traceroutesSqlite;
    case 'postgres':
      return traceroutesPostgres;
    case 'mysql':
      return traceroutesMysql;
  }
}

function pickNeighborsTable(dbType: AnalysisDbType) {
  switch (dbType) {
    case 'sqlite':
      return neighborInfoSqlite;
    case 'postgres':
      return neighborInfoPostgres;
    case 'mysql':
      return neighborInfoMysql;
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

  /**
   * Get a paginated list of traceroute records across given sources, newest
   * first. Cursor pagination keyed on `(timestamp DESC, id DESC)` — the
   * traceroutes table has a single `id` PK so the (ts, id) tuple is a stable
   * cursor.
   */
  async getTraceroutes(args: GetTraceroutesArgs): Promise<PaginatedTraceroutes> {
    const pageSize = Math.max(
      MIN_PAGE_SIZE,
      Math.min(args.pageSize, MAX_PAGE_SIZE),
    );

    if (args.sourceIds.length === 0) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }

    const traceroutes = pickTraceroutesTable(this.dbType);
    const cursor = decodeIdCursor(args.cursor ?? null);

    const baseConditions = [
      inArray(traceroutes.sourceId, args.sourceIds),
      gte(traceroutes.timestamp, args.sinceMs),
    ];

    if (cursor) {
      const cursorClause = or(
        lt(traceroutes.timestamp, cursor.ts),
        and(
          eq(traceroutes.timestamp, cursor.ts),
          lt(traceroutes.id, cursor.id),
        ),
      );
      if (cursorClause) {
        baseConditions.push(cursorClause);
      }
    }

    const fetchLimit = pageSize + 1;

    /* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union */
    const rows: any[] = await (this.db as any)
      .select({
        id: traceroutes.id,
        fromNodeNum: traceroutes.fromNodeNum,
        toNodeNum: traceroutes.toNodeNum,
        sourceId: traceroutes.sourceId,
        route: traceroutes.route,
        routeBack: traceroutes.routeBack,
        snrTowards: traceroutes.snrTowards,
        snrBack: traceroutes.snrBack,
        timestamp: traceroutes.timestamp,
        createdAt: traceroutes.createdAt,
      })
      .from(traceroutes)
      .where(and(...baseConditions))
      .orderBy(desc(traceroutes.timestamp), desc(traceroutes.id))
      .limit(fetchLimit);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const mapped: TracerouteRow[] = rows.map((r) => ({
      id: Number(r.id),
      fromNodeNum: Number(r.fromNodeNum),
      toNodeNum: Number(r.toNodeNum),
      sourceId: r.sourceId ?? '',
      route: r.route ?? null,
      routeBack: r.routeBack ?? null,
      snrTowards: r.snrTowards ?? null,
      snrBack: r.snrBack ?? null,
      timestamp: Number(r.timestamp),
      createdAt: Number(r.createdAt),
    }));

    const hasMore = mapped.length > pageSize;
    const items = mapped.slice(0, pageSize);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeIdCursor({ ts: last.timestamp, id: last.id })
        : null;

    return { items, pageSize, hasMore, nextCursor };
  }

  /**
   * Get neighbor edges across the given sources within `sinceMs`. No
   * pagination — neighbor tables are small per source and the consumer is
   * a topology renderer that wants the full set at once.
   */
  async getNeighbors(args: GetNeighborsArgs): Promise<NeighborsResult> {
    if (args.sourceIds.length === 0) {
      return { items: [] };
    }

    const neighbors = pickNeighborsTable(this.dbType);

    /* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union */
    const rows: any[] = await (this.db as any)
      .select({
        id: neighbors.id,
        nodeNum: neighbors.nodeNum,
        neighborNodeNum: neighbors.neighborNodeNum,
        sourceId: neighbors.sourceId,
        snr: neighbors.snr,
        timestamp: neighbors.timestamp,
      })
      .from(neighbors)
      .where(
        and(
          inArray(neighbors.sourceId, args.sourceIds),
          gte(neighbors.timestamp, args.sinceMs),
        ),
      )
      .orderBy(desc(neighbors.timestamp));
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const items: NeighborRow[] = rows.map((r) => ({
      id: Number(r.id),
      nodeNum: Number(r.nodeNum),
      neighborNum: Number(r.neighborNodeNum),
      sourceId: r.sourceId ?? '',
      snr: r.snr == null ? null : Number(r.snr),
      timestamp: Number(r.timestamp),
    }));

    return { items };
  }

  /**
   * Build a coverage grid by binning position fixes into lat/lon cells. The
   * grid reuses `getPositions` (the telemetry pivot) and groups in JS to
   * avoid duplicating the lat/lon pivot logic at the SQL layer. Walks at
   * most 5 pages (~10k positions) as a guardrail against runaway scans.
   *
   * Each cell counts the number of UNIQUE nodes (`(sourceId, nodeNum)`) that
   * have ever reported a fix from inside it — not raw fix count. This means a
   * stationary high-frequency reporter contributes 1 to its cell instead of
   * dominating, while a mobile node lights up every cell it has visited.
   */
  async getCoverageGrid(args: GetCoverageGridArgs): Promise<CoverageGridResult> {
    const binSize = binSizeForZoom(args.zoom);
    if (args.sourceIds.length === 0) {
      return { cells: [], binSizeDeg: binSize };
    }

    const pageSize = 2000;
    let cursor: string | null = null;
    const cellMap = new Map<string, GridCell>();
    // De-dup key per (sourceId, nodeNum, cell) — second+ fixes from the same
    // node into the same cell don't increment the count.
    const seen = new Set<string>();

    for (let i = 0; i < 5; i++) {
      const page = await this.getPositions({
        sourceIds: args.sourceIds,
        sinceMs: args.sinceMs,
        pageSize,
        cursor,
      });
      for (const p of page.items) {
        const latBin = Math.floor(p.latitude / binSize);
        const lonBin = Math.floor(p.longitude / binSize);
        const dedupeKey = `${p.sourceId}:${p.nodeNum}:${latBin}:${lonBin}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const cellKey = `${latBin}:${lonBin}`;
        let cell = cellMap.get(cellKey);
        if (!cell) {
          cell = {
            latBin,
            lonBin,
            centerLat: latBin * binSize + binSize / 2,
            centerLon: lonBin * binSize + binSize / 2,
            count: 0,
          };
          cellMap.set(cellKey, cell);
        }
        cell.count++;
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }

    return { cells: Array.from(cellMap.values()), binSizeDeg: binSize };
  }

  /**
   * Compute the hop count from each source's local node to every other
   * node, taken from the most recent traceroute reaching that node. The
   * `route` JSON column holds the array of intermediate node hops; its
   * length is the hop count. Nodes never reached by a traceroute do not
   * appear in the result.
   */
  async getHopCounts(args: GetHopCountsArgs): Promise<HopCountsResult> {
    if (args.sourceIds.length === 0) {
      return { entries: [] };
    }

    const traceroutes = pickTraceroutesTable(this.dbType);

    /* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union */
    const rows: any[] = await (this.db as any)
      .select({
        sourceId: traceroutes.sourceId,
        toNodeNum: traceroutes.toNodeNum,
        route: traceroutes.route,
        timestamp: traceroutes.timestamp,
      })
      .from(traceroutes)
      .where(inArray(traceroutes.sourceId, args.sourceIds))
      .orderBy(desc(traceroutes.timestamp));
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const seen = new Map<string, HopEntry>();
    for (const r of rows) {
      const sourceId = r.sourceId ?? '';
      if (!sourceId) continue;
      const nodeNum = Number(r.toNodeNum);
      const key = `${sourceId}:${nodeNum}`;
      if (seen.has(key)) continue;
      let hops = 0;
      try {
        const arr = JSON.parse(r.route ?? '[]');
        hops = Array.isArray(arr) ? arr.length : 0;
      } catch {
        hops = 0;
      }
      seen.set(key, { sourceId, nodeNum, hops });
    }
    return { entries: Array.from(seen.values()) };
  }
}
