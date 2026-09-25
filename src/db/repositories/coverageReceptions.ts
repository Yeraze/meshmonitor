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
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, not, notInArray, or, sql, SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import type { CoverageReceiverFilterEntry } from '../../utils/coverageReceiverFilter.js';

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
  /**
   * Source-scoped receiver filter (#5277 P2 §2.3), replacing P1's flat
   * `receiverIds?: string[]` — which matched a receiverId on EVERY source,
   * not just the one the caller meant. Entries whose `sourceId` is not in
   * `sourceIds` are dropped silently (the permission intersection stays
   * authoritative). A source with no entry is unconstrained (every one of
   * its receivers matches).
   */
  receiverFilter?: CoverageReceiverFilterEntry[];
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
  /**
   * Optional upper bound (#5277 Phase 4b WP2, `/receivers?since=&until=`) —
   * a survey older than the retention window has rows only inside its own
   * window, so without this its receivers would be missing from the filter
   * list and the map. Omitted = unbounded (through now), matching the
   * original P1/P2 behaviour.
   */
  untilMs?: number;
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
  /** Reception rows for this receiver in the window (#5277 P2 §2.3). */
  receptionCount: number;
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

/**
 * A retention-exemption window: rows for `senderId` whose `receivedAt` falls
 * in `[startAt, endAt]` survive `purgeOlderThan`'s cutoff regardless of age
 * (#5277 Phase 4b WP1). Structurally identical to
 * `CoverageSurveysRepository`'s `CoverageSurveyExemptionWindow` — duck-typed
 * on purpose, not imported, so this repository stays free of a survey
 * import (the spec's "single seam, no cross-repo coupling").
 */
export interface CoverageRetentionExemptionWindow {
  senderId: string;
  startAt: number;
  endAt: number;
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
   * Build the source/receiver scoping clause for `getReceptions`
   * (#5277 P2 §2.3): `or(inArray(sourceId, unconstrainedSources),
   * ...entryClauses)`, where `unconstrainedSources` is `sourceIds` minus the
   * sources that have a `receiverFilter` entry. Include → `sourceId = s AND
   * receiverId IN (ids)`; exclude → `sourceId = s AND receiverId NOT IN
   * (ids)` (`receiverId` is NOT NULL, so NOT IN has no NULL trap). Entries
   * whose `sourceId` isn't in `sourceIds` are dropped — the permission
   * intersection stays authoritative, never widened by a stale/forged entry.
   *
   * Returns `null` when nothing can possibly match (every entry dropped and
   * no unconstrained sources remain, or an include entry has an empty id
   * list) — the caller returns an empty page without querying.
   */
  private buildReceptionsSourceClause(
    sourceIds: string[],
    receiverFilter: CoverageReceiverFilterEntry[] | undefined,
  ): SQL | null {
    const { coverageReceptions } = this.tables;

    if (!receiverFilter || receiverFilter.length === 0) {
      return inArray(coverageReceptions.sourceId, sourceIds) ?? null;
    }

    const permitted = new Set(sourceIds);
    const bySource = new Map<string, CoverageReceiverFilterEntry>();
    for (const entry of receiverFilter) {
      if (!permitted.has(entry.sourceId)) continue;
      bySource.set(entry.sourceId, entry);
    }

    const unconstrainedSources = sourceIds.filter((id) => !bySource.has(id));
    const parts: SQL[] = [];

    if (unconstrainedSources.length > 0) {
      const clause = inArray(coverageReceptions.sourceId, unconstrainedSources);
      if (clause) parts.push(clause);
    }

    for (const entry of bySource.values()) {
      if (entry.mode === 'include') {
        // notInArray/inArray with an empty list is invalid SQL on some
        // dialects; an empty include list matches nothing for that source,
        // so it's simply omitted from the OR rather than queried.
        if (entry.receiverIds.length === 0) continue;
        const clause = and(
          eq(coverageReceptions.sourceId, entry.sourceId),
          inArray(coverageReceptions.receiverId, entry.receiverIds),
        );
        if (clause) parts.push(clause);
      } else {
        const clause = entry.receiverIds.length === 0
          ? eq(coverageReceptions.sourceId, entry.sourceId)
          : and(
              eq(coverageReceptions.sourceId, entry.sourceId),
              notInArray(coverageReceptions.receiverId, entry.receiverIds),
            );
        if (clause) parts.push(clause);
      }
    }

    if (parts.length === 0) return null;
    return or(...parts) ?? null;
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

    const sourceClause = this.buildReceptionsSourceClause(args.sourceIds, args.receiverFilter);
    if (!sourceClause) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }

    const conditions = [
      sourceClause,
      gte(coverageReceptions.receivedAt, args.sinceMs),
      lte(coverageReceptions.receivedAt, args.untilMs),
    ];

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

  /** Batch size for `getReceivers`'s follow-up snapshot fetch (#5277 P2 §2.3, Decision D9). */
  private static readonly RECEIVERS_SNAPSHOT_CHUNK = 200;

  /**
   * Distinct receivers present in the retention window for the given
   * sources — derived from the table only (Decision D8: no `source.type`
   * gate). One row per `(sourceId, receiverKind, receiverId,
   * receiverNodeNum)`, with `lastReceivedAt = MAX(receivedAt)`,
   * `receptionCount = COUNT(*)`, and the position snapshot taken from that
   * group's most recent row that has a non-null snapshot (which can be
   * earlier than `lastReceivedAt` itself).
   *
   * Batched (Decision D9, #5277 P2): P1's "receivers are few" assumption
   * doesn't hold once MQTT gateways are in the table — one query per
   * receiver would mean hundreds of round trips per `/receivers` call.
   * Instead: one GROUP BY (adding `lastSnapAt = MAX(CASE WHEN
   * receiverLatitude IS NOT NULL THEN receivedAt END)` per group, portable
   * plain SQL), then one batched OR-of-ANDs select per chunk of 200 groups
   * that actually have a snapshot, keyed on `(sourceId, receiverKind,
   * receiverId, receiverNodeNum, receivedAt = lastSnapAt)` — the unique
   * index prefix `(sourceId, receiverId, …)` serves the lookup. Total query
   * count: `1 + ceil(N/200)` where N is the number of groups with a
   * snapshot, down from P1's `1 + N`.
   */
  async getReceivers(args: GetCoverageReceiversArgs): Promise<CoverageReceiverRow[]> {
    if (args.sourceIds.length === 0) {
      return [];
    }

    const { coverageReceptions } = this.tables;

    const windowConditions = [
      inArray(coverageReceptions.sourceId, args.sourceIds),
      gte(coverageReceptions.receivedAt, args.sinceMs),
    ];
    if (args.untilMs !== undefined) {
      windowConditions.push(lte(coverageReceptions.receivedAt, args.untilMs));
    }

    const groups = await this.db
      .select({
        sourceId: coverageReceptions.sourceId,
        receiverKind: coverageReceptions.receiverKind,
        receiverId: coverageReceptions.receiverId,
        receiverNodeNum: coverageReceptions.receiverNodeNum,
        protocol: sql<string>`MAX(${coverageReceptions.protocol})`,
        lastReceivedAt: sql<number>`MAX(${coverageReceptions.receivedAt})`,
        receptionCount: count(),
        lastSnapAt: sql<number | null>`MAX(CASE WHEN ${coverageReceptions.receiverLatitude} IS NOT NULL THEN ${coverageReceptions.receivedAt} END)`,
      })
      .from(coverageReceptions)
      .where(and(...windowConditions))
      .groupBy(
        coverageReceptions.sourceId,
        coverageReceptions.receiverKind,
        coverageReceptions.receiverId,
        coverageReceptions.receiverNodeNum,
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
    const groupRows = groups as any[];

    /** Group key for the snapshot map — mirrors the follow-up query's WHERE. */
    const snapKey = (sourceId: string, receiverId: string, nodeNum: number | null): string =>
      `${sourceId}|${receiverId}|${nodeNum ?? '\u0000'}`;

    const needsSnapshot = groupRows.filter((g) => g.lastSnapAt != null);
    const snapshots = new Map<string, { receiverLatitude: number; receiverLongitude: number }>();

    for (let i = 0; i < needsSnapshot.length; i += CoverageReceptionsRepository.RECEIVERS_SNAPSHOT_CHUNK) {
      const chunk = needsSnapshot.slice(i, i + CoverageReceptionsRepository.RECEIVERS_SNAPSHOT_CHUNK);

      const clauses = chunk
        .map((g) => {
          const nodeNum = g.receiverNodeNum == null ? null : Number(g.receiverNodeNum);
          const nodeNumClause = nodeNum === null
            ? isNull(coverageReceptions.receiverNodeNum)
            : eq(coverageReceptions.receiverNodeNum, nodeNum);
          return and(
            eq(coverageReceptions.sourceId, g.sourceId),
            eq(coverageReceptions.receiverKind, g.receiverKind),
            eq(coverageReceptions.receiverId, g.receiverId),
            nodeNumClause,
            eq(coverageReceptions.receivedAt, Number(g.lastSnapAt)),
            isNotNull(coverageReceptions.receiverLatitude),
          );
        })
        .filter((c): c is SQL => c != null);

      if (clauses.length === 0) continue;
      const combined = or(...clauses);
      if (!combined) continue;

      const snapRows = await this.db
        .select({
          sourceId: coverageReceptions.sourceId,
          receiverId: coverageReceptions.receiverId,
          receiverNodeNum: coverageReceptions.receiverNodeNum,
          receiverLatitude: coverageReceptions.receiverLatitude,
          receiverLongitude: coverageReceptions.receiverLongitude,
        })
        .from(coverageReceptions)
        .where(combined);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
      for (const r of snapRows as any[]) {
        const nodeNum = r.receiverNodeNum == null ? null : Number(r.receiverNodeNum);
        const key = snapKey(r.sourceId, r.receiverId, nodeNum);
        // Take the first row per group key — several rows can share
        // (sourceId, receiverId, nodeNum, receivedAt) when two receptions
        // land in the same millisecond from different senders.
        if (!snapshots.has(key)) {
          snapshots.set(key, {
            receiverLatitude: Number(r.receiverLatitude),
            receiverLongitude: Number(r.receiverLongitude),
          });
        }
      }
    }

    return groupRows.map((g) => {
      const nodeNum = g.receiverNodeNum == null ? null : Number(g.receiverNodeNum);
      const snap = snapshots.get(snapKey(g.sourceId, g.receiverId, nodeNum));
      return {
        sourceId: g.sourceId,
        protocol: g.protocol,
        receiverKind: g.receiverKind,
        receiverId: g.receiverId,
        receiverNodeNum: nodeNum,
        lastReceivedAt: Number(g.lastReceivedAt),
        receptionCount: Number(g.receptionCount),
        receiverLatitude: snap ? snap.receiverLatitude : null,
        receiverLongitude: snap ? snap.receiverLongitude : null,
      };
    });
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
   * sources — retention is global by design. This is the single purge seam
   * (#5277 Phase 1 WP2 / Phase 4b WP1): `exemptions` — one window per saved
   * survey, keyed on sender + effective window, spanning every source —
   * protects a survey's receptions from the sweep even when they fall
   * outside the retention cutoff. `coverageRetentionService` is the only
   * caller that passes a non-empty `exemptions`; an empty/omitted list is
   * exactly P1's original behaviour (no NULL trap: `senderId` and
   * `receivedAt` are NOT NULL on this table). Returns the number of rows
   * deleted.
   */
  async purgeOlderThan(cutoffMs: number, exemptions: CoverageRetentionExemptionWindow[] = []): Promise<number> {
    const { coverageReceptions } = this.tables;

    const conditions: SQL[] = [lt(coverageReceptions.receivedAt, cutoffMs)];

    if (exemptions.length > 0) {
      const exemptionClauses = exemptions
        .map((w) => and(
          eq(coverageReceptions.senderId, w.senderId),
          gte(coverageReceptions.receivedAt, w.startAt),
          lte(coverageReceptions.receivedAt, w.endAt),
        ))
        .filter((c): c is SQL => c != null);

      if (exemptionClauses.length > 0) {
        const combined = or(...exemptionClauses);
        if (combined) conditions.push(not(combined));
      }
    }

    const result = await this.db
      .delete(coverageReceptions)
      .where(and(...conditions));
    return this.getAffectedRows(result);
  }

  /**
   * Backup export (#5277 Phase 4b WP1, Decision U3): rows inside ANY
   * survey's effective window, across every source, with the `id` column
   * OMITTED. Restore inserts these rows with fresh ids — see migration 173's
   * header / COVERAGE_P4_SPEC.md §2b.6 for the PG-sequence trap this avoids
   * (restored explicit ids never bump the serial sequence, and a later
   * `recordReception` whose auto-assigned id collides would otherwise be
   * silently dropped by `insertIgnore`'s target-less `onConflictDoNothing()`).
   * Returns `[]` immediately when there are no windows — no survey means no
   * exportable receptions, and an empty `or()` is invalid SQL.
   */
  async exportSurveyReceptions(windows: CoverageRetentionExemptionWindow[]): Promise<Omit<DbCoverageReception, 'id'>[]> {
    if (windows.length === 0) return [];

    const { coverageReceptions } = this.tables;
    const clauses = windows
      .map((w) => and(
        eq(coverageReceptions.senderId, w.senderId),
        gte(coverageReceptions.receivedAt, w.startAt),
        lte(coverageReceptions.receivedAt, w.endAt),
      ))
      .filter((c): c is SQL => c != null);

    if (clauses.length === 0) return [];
    const combined = or(...clauses);
    if (!combined) return [];

    const rows = await this.db
      .select()
      .from(coverageReceptions)
      .where(combined);

    return (rows as any[]).map((r) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
      const { id: _id, ...rest } = this.mapReception(r);
      return rest;
    });
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
