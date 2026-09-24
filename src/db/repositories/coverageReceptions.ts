/**
 * Repository for `coverage_receptions` — the Coverage Report RF-reception
 * log (epic #5277, Phase 1 WP1).
 *
 * One row per (packet, path, receiver): `recordReception` is first-write-wins
 * via `insertIgnore` on the `(sourceId, receiverId, senderId, packetKey,
 * pathKey)` unique key — unlike `MeshtasticHeardRepeatersRepository`, there is
 * no SNR merge on a repeat key, because a later copy on the same path is a
 * replay or retransmission, not new information (see the schema header for
 * the full rationale).
 *
 * `purgeOlderThan` is the **single purge seam** documented in the spec: the
 * P4 saved-survey exemption is added here and nowhere else. Retention itself
 * is global by design (no sourceId scoping on the purge), even though every
 * row carries a sourceId for read-side scoping.
 *
 * PER-SOURCE reads (`getReceptions` / `getReceivers` / `getSenderSummary`)
 * all require an explicit `sourceIds` allow-list — an empty list returns an
 * empty result rather than falling through to "every source".
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbCoverageReception {
  id: number;
  sourceId: string;
  protocol: string;
  receiverKind: string;
  receiverId: string;
  receiverNodeNum: number | null;
  receiverLatitude: number | null;
  receiverLongitude: number | null;
  senderId: string;
  senderNodeNum: number | null;
  packetKey: string;
  packetId: number | null;
  pathKey: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  precisionBits: number | null;
  snr: number | null;
  rssi: number | null;
  hopStart: number | null;
  hopLimit: number | null;
  hopsAway: number | null;
  relayNode: number | null;
  transportMechanism: number | null;
  channel: number | null;
  rxTime: number | null;
  receivedAt: number;
}

export interface RecordCoverageReceptionParams {
  sourceId: string;
  protocol: string;
  receiverKind: string;
  receiverId: string;
  receiverNodeNum?: number | null;
  receiverLatitude?: number | null;
  receiverLongitude?: number | null;
  senderId: string;
  senderNodeNum?: number | null;
  packetKey: string;
  packetId?: number | null;
  pathKey: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  precisionBits?: number | null;
  snr?: number | null;
  rssi?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  hopsAway?: number | null;
  relayNode?: number | null;
  transportMechanism?: number | null;
  channel?: number | null;
  rxTime?: number | null;
  receivedAt: number;
}

export type CoverageHopsMode = 'exact' | 'max';

export interface GetCoverageReceptionsArgs {
  sourceIds: string[];
  sinceMs: number;
  untilMs: number;
  receiverIds?: string[];
  senderId?: string;
  hops?: number;
  hopsMode?: CoverageHopsMode;
  pageSize: number;
  cursor?: string | null;
}

export interface CoverageReceptionsPage {
  items: DbCoverageReception[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface GetCoverageReceiversArgs {
  sourceIds: string[];
  sinceMs: number;
}

export interface CoverageReceiverRow {
  sourceId: string;
  protocol: string;
  receiverKind: string;
  receiverId: string;
  receiverNodeNum: number | null;
  lastReceivedAt: number;
  receiverLatitude: number | null;
  receiverLongitude: number | null;
}

export interface GetCoverageSenderSummaryArgs {
  sourceIds: string[];
  sinceMs: number;
  untilMs: number;
  limit: number;
}

export interface CoverageSenderSummaryRow {
  sourceId: string;
  senderId: string;
  senderNodeNum: number | null;
  fixCount: number;
  lastReceivedAt: number;
}

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 2000;
const DEFAULT_PAGE_SIZE = 1000;

function clampPageSize(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  return Math.max(MIN_PAGE_SIZE, Math.min(Math.trunc(raw), MAX_PAGE_SIZE));
}

/** Cursor for `(receivedAt DESC, id DESC)` keyed pagination — base64 JSON `{ts,id}`. */
interface ReceptionCursor {
  ts: number;
  id: number;
}

function encodeCursor(c: ReceptionCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(s: string | null | undefined): ReceptionCursor | null {
  if (!s) return null;
  try {
    const decoded = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof decoded?.ts !== 'number' || typeof decoded?.id !== 'number') return null;
    if (!Number.isFinite(decoded.ts) || !Number.isFinite(decoded.id)) return null;
    return { ts: decoded.ts, id: decoded.id };
  } catch {
    return null;
  }
}

export class CoverageReceptionsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private mapReception(row: any): DbCoverageReception { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
    return {
      id: Number(row.id),
      sourceId: row.sourceId,
      protocol: row.protocol,
      receiverKind: row.receiverKind,
      receiverId: row.receiverId,
      receiverNodeNum: row.receiverNodeNum == null ? null : Number(row.receiverNodeNum),
      receiverLatitude: row.receiverLatitude == null ? null : Number(row.receiverLatitude),
      receiverLongitude: row.receiverLongitude == null ? null : Number(row.receiverLongitude),
      senderId: row.senderId,
      senderNodeNum: row.senderNodeNum == null ? null : Number(row.senderNodeNum),
      packetKey: row.packetKey,
      packetId: row.packetId == null ? null : Number(row.packetId),
      pathKey: row.pathKey,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      altitude: row.altitude == null ? null : Number(row.altitude),
      precisionBits: row.precisionBits == null ? null : Number(row.precisionBits),
      snr: row.snr == null ? null : Number(row.snr),
      rssi: row.rssi == null ? null : Number(row.rssi),
      hopStart: row.hopStart == null ? null : Number(row.hopStart),
      hopLimit: row.hopLimit == null ? null : Number(row.hopLimit),
      hopsAway: row.hopsAway == null ? null : Number(row.hopsAway),
      relayNode: row.relayNode == null ? null : Number(row.relayNode),
      transportMechanism: row.transportMechanism == null ? null : Number(row.transportMechanism),
      channel: row.channel == null ? null : Number(row.channel),
      rxTime: row.rxTime == null ? null : Number(row.rxTime),
      receivedAt: Number(row.receivedAt),
    };
  }

  /**
   * Record one (packet, path, receiver) RF reception. First-write-wins via
   * `insertIgnore` on the unique key — returns true when a new row was
   * inserted, false when it was a duplicate (no merge).
   *
   * Throws on any empty unique-key field: `sourceId`, `receiverId`,
   * `senderId`, `packetKey`, `pathKey`. All three backends treat NULL as
   * distinct in a UNIQUE index, so an accidentally-empty key would silently
   * defeat the dedupe rather than fail loudly.
   */
  async recordReception(params: RecordCoverageReceptionParams): Promise<boolean> {
    if (!params.sourceId) {
      throw new Error('CoverageReceptionsRepository.recordReception requires a sourceId');
    }
    if (!params.receiverId) {
      throw new Error('CoverageReceptionsRepository.recordReception requires a receiverId');
    }
    if (!params.senderId) {
      throw new Error('CoverageReceptionsRepository.recordReception requires a senderId');
    }
    if (!params.packetKey) {
      throw new Error('CoverageReceptionsRepository.recordReception requires a packetKey');
    }
    if (!params.pathKey) {
      throw new Error('CoverageReceptionsRepository.recordReception requires a pathKey');
    }

    const { coverageReceptions } = this.tables;
    const result = await this.insertIgnore(coverageReceptions, {
      sourceId: params.sourceId,
      protocol: params.protocol,
      receiverKind: params.receiverKind,
      receiverId: params.receiverId,
      receiverNodeNum: params.receiverNodeNum ?? null,
      receiverLatitude: params.receiverLatitude ?? null,
      receiverLongitude: params.receiverLongitude ?? null,
      senderId: params.senderId,
      senderNodeNum: params.senderNodeNum ?? null,
      packetKey: params.packetKey,
      packetId: params.packetId ?? null,
      pathKey: params.pathKey,
      latitude: params.latitude,
      longitude: params.longitude,
      altitude: params.altitude ?? null,
      precisionBits: params.precisionBits ?? null,
      snr: params.snr ?? null,
      rssi: params.rssi ?? null,
      hopStart: params.hopStart ?? null,
      hopLimit: params.hopLimit ?? null,
      hopsAway: params.hopsAway ?? null,
      relayNode: params.relayNode ?? null,
      transportMechanism: params.transportMechanism ?? null,
      channel: params.channel ?? null,
      rxTime: params.rxTime ?? null,
      receivedAt: params.receivedAt,
    });
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Paginated reception rows, newest first. Cursor pagination keyed on
   * `(receivedAt DESC, id DESC)` — concurrent inserts never cause rows to be
   * skipped or repeated across pages. `hops`/`hopsMode` filters exclude NULL
   * `hopsAway` rows whenever a hops filter is set (an unknown hop count never
   * matches a specific hop request).
   */
  async getReceptions(args: GetCoverageReceptionsArgs): Promise<CoverageReceptionsPage> {
    const pageSize = clampPageSize(args.pageSize);

    if (args.sourceIds.length === 0) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }

    const { coverageReceptions } = this.tables;
    const cursor = decodeCursor(args.cursor ?? null);

    const conditions = [
      inArray(coverageReceptions.sourceId, args.sourceIds),
      gte(coverageReceptions.receivedAt, args.sinceMs),
      lte(coverageReceptions.receivedAt, args.untilMs),
    ];

    if (args.receiverIds && args.receiverIds.length > 0) {
      conditions.push(inArray(coverageReceptions.receiverId, args.receiverIds));
    }
    if (args.senderId) {
      conditions.push(eq(coverageReceptions.senderId, args.senderId));
    }
    if (args.hops !== undefined && args.hops !== null) {
      conditions.push(isNotNull(coverageReceptions.hopsAway));
      conditions.push(
        args.hopsMode === 'max'
          ? lte(coverageReceptions.hopsAway, args.hops)
          : eq(coverageReceptions.hopsAway, args.hops),
      );
    }

    if (cursor) {
      const cursorClause = or(
        lt(coverageReceptions.receivedAt, cursor.ts),
        and(
          eq(coverageReceptions.receivedAt, cursor.ts),
          lt(coverageReceptions.id, cursor.id),
        ),
      );
      if (cursorClause) {
        conditions.push(cursorClause);
      }
    }

    const fetchLimit = pageSize + 1;
    const rows = await this.db
      .select()
      .from(coverageReceptions)
      .where(and(...conditions))
      .orderBy(desc(coverageReceptions.receivedAt), desc(coverageReceptions.id))
      .limit(fetchLimit);

    const mapped = (rows as any[]).map((r) => this.mapReception(r)); // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union
    const hasMore = mapped.length > pageSize;
    const items = mapped.slice(0, pageSize);
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ ts: last.receivedAt, id: last.id })
      : null;

    return { items, pageSize, hasMore, nextCursor };
  }

  /**
   * Distinct receivers present in the retention window for the given
   * sources — derived from the table only (Decision D8: no `source.type`
   * gate). One row per `(sourceId, receiverKind, receiverId,
   * receiverNodeNum)`, with `lastReceivedAt = MAX(receivedAt)` and the
   * position snapshot taken from that group's most recent row that has a
   * non-null snapshot (which can be earlier than `lastReceivedAt` itself).
   *
   * Implemented as a GROUP BY followed by one bounded follow-up query per
   * group (receivers are few) rather than a dialect-specific window
   * function, to stay portable across SQLite/PostgreSQL/MySQL.
   */
  async getReceivers(args: GetCoverageReceiversArgs): Promise<CoverageReceiverRow[]> {
    if (args.sourceIds.length === 0) {
      return [];
    }

    const { coverageReceptions } = this.tables;

    const groups = await this.db
      .select({
        sourceId: coverageReceptions.sourceId,
        receiverKind: coverageReceptions.receiverKind,
        receiverId: coverageReceptions.receiverId,
        receiverNodeNum: coverageReceptions.receiverNodeNum,
        protocol: sql<string>`MAX(${coverageReceptions.protocol})`,
        lastReceivedAt: sql<number>`MAX(${coverageReceptions.receivedAt})`,
      })
      .from(coverageReceptions)
      .where(and(
        inArray(coverageReceptions.sourceId, args.sourceIds),
        gte(coverageReceptions.receivedAt, args.sinceMs),
      ))
      .groupBy(
        coverageReceptions.sourceId,
        coverageReceptions.receiverKind,
        coverageReceptions.receiverId,
        coverageReceptions.receiverNodeNum,
      );

    const results: CoverageReceiverRow[] = [];
    for (const g of groups as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union
      const nodeNum = g.receiverNodeNum == null ? null : Number(g.receiverNodeNum);
      const nodeNumClause = nodeNum === null
        ? isNull(coverageReceptions.receiverNodeNum)
        : eq(coverageReceptions.receiverNodeNum, nodeNum);

      const snapRows = await this.db
        .select({
          receiverLatitude: coverageReceptions.receiverLatitude,
          receiverLongitude: coverageReceptions.receiverLongitude,
        })
        .from(coverageReceptions)
        .where(and(
          eq(coverageReceptions.sourceId, g.sourceId),
          eq(coverageReceptions.receiverKind, g.receiverKind),
          eq(coverageReceptions.receiverId, g.receiverId),
          nodeNumClause,
          isNotNull(coverageReceptions.receiverLatitude),
        ))
        .orderBy(desc(coverageReceptions.receivedAt))
        .limit(1);

      const snap = (snapRows as any[])[0]; // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union

      results.push({
        sourceId: g.sourceId,
        protocol: g.protocol,
        receiverKind: g.receiverKind,
        receiverId: g.receiverId,
        receiverNodeNum: nodeNum,
        lastReceivedAt: Number(g.lastReceivedAt),
        receiverLatitude: snap ? Number(snap.receiverLatitude) : null,
        receiverLongitude: snap ? Number(snap.receiverLongitude) : null,
      });
    }

    return results;
  }

  /**
   * Per-sender summary within a window: distinct fix count (`countDistinct`
   * on `packetKey`, since a sender can have multiple reception rows per
   * fix) and the most recent reception, grouped by `(sourceId, senderId,
   * senderNodeNum)`, ordered newest-first.
   */
  async getSenderSummary(args: GetCoverageSenderSummaryArgs): Promise<CoverageSenderSummaryRow[]> {
    if (args.sourceIds.length === 0) {
      return [];
    }

    const limit = Math.max(1, Math.min(Math.trunc(args.limit), MAX_PAGE_SIZE));
    const { coverageReceptions } = this.tables;

    const rows = await this.db
      .select({
        sourceId: coverageReceptions.sourceId,
        senderId: coverageReceptions.senderId,
        senderNodeNum: coverageReceptions.senderNodeNum,
        fixCount: sql<number>`COUNT(DISTINCT ${coverageReceptions.packetKey})`,
        lastReceivedAt: sql<number>`MAX(${coverageReceptions.receivedAt})`,
      })
      .from(coverageReceptions)
      .where(and(
        inArray(coverageReceptions.sourceId, args.sourceIds),
        gte(coverageReceptions.receivedAt, args.sinceMs),
        lte(coverageReceptions.receivedAt, args.untilMs),
      ))
      .groupBy(coverageReceptions.sourceId, coverageReceptions.senderId, coverageReceptions.senderNodeNum)
      .orderBy(sql`MAX(${coverageReceptions.receivedAt}) DESC`)
      .limit(limit);

    return (rows as any[]).map((r) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union
      sourceId: r.sourceId,
      senderId: r.senderId,
      senderNodeNum: r.senderNodeNum == null ? null : Number(r.senderNodeNum),
      fixCount: Number(r.fixCount ?? 0),
      lastReceivedAt: Number(r.lastReceivedAt ?? 0),
    }));
  }

  /**
   * Delete every row older than `cutoffMs` (by `receivedAt`), across ALL
   * sources — retention is global by design. This is the single purge seam:
   * a future saved-survey exemption (P4) is added here and nowhere else.
   * Returns the number of rows deleted.
   */
  async purgeOlderThan(cutoffMs: number): Promise<number> {
    const { coverageReceptions } = this.tables;
    const result = await this.db
      .delete(coverageReceptions)
      .where(lt(coverageReceptions.receivedAt, cutoffMs));
    return this.getAffectedRows(result);
  }

  /**
   * Delete every reception row for one source — used on source deletion and
   * per-source "purge nodes". Throws on an empty sourceId (fail-closed, same
   * convention as `withSourceScope`).
   */
  async deleteForSource(sourceId: string): Promise<number> {
    if (!sourceId) {
      throw new Error('CoverageReceptionsRepository.deleteForSource requires a sourceId');
    }
    const { coverageReceptions } = this.tables;
    const result = await this.db
      .delete(coverageReceptions)
      .where(eq(coverageReceptions.sourceId, sourceId));
    return this.getAffectedRows(result);
  }

  /** Delete every reception row, across every source (global "purge all nodes"). */
  async deleteAll(): Promise<number> {
    const { coverageReceptions } = this.tables;
    const result = await this.db.delete(coverageReceptions);
    return this.getAffectedRows(result);
  }
}
