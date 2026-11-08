/**
 * Repository for `meshcore_hop_snr` (issue #5722): per-hop SNR from MeshCore
 * TRACE packets. PER-SOURCE — every read and write takes a `sourceId`.
 *
 * Rows are directional: `receiver` heard `sender` at `snrQuarterDb / 4` dB.
 */
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface MeshCoreHopSnrRow {
  id?: number;
  sourceId: string;
  traceTag: number;
  authCode: number;
  /** 0-based position of this hop in the trace. */
  hopIndex: number;
  /** Rows this trace produced. */
  hopCount: number;
  /** Width of the path hashes in the trace (1 or 2 bytes). */
  hashBytes: number;
  /** Resolved contact key of the transmitting end, or null. */
  senderPublicKey: string | null;
  /** The sender's path hash as hex, or null when it is not on the wire. */
  senderHash: string | null;
  /** Contacts that matched `senderHash`: 1 = resolved, 0 = unknown, >1 = ambiguous. */
  senderCandidates: number;
  receiverPublicKey: string | null;
  receiverHash: string | null;
  receiverCandidates: number;
  /** SNR at the receiver, signed quarter-dB (the wire unit). */
  snrQuarterDb: number;
  /** True when MeshMonitor sent the trace; false when it was overheard. */
  initiated: boolean;
  /** ms since epoch */
  timestamp: number;
}

/**
 * One end of a link, as `summarizeHopSnrLinks` groups it: a resolved key, an
 * unresolved path hash, or unknown (both null). Keys and hashes are lowercase.
 */
export interface HopSnrLinkEnd {
  publicKey: string | null;
  hash: string | null;
}

/** Rows one history read returns by default. */
export const HOP_SNR_HISTORY_LIMIT = 2000;
/** Most rows a caller may ask one history read for (the chart view, #5765). */
export const HOP_SNR_HISTORY_MAX_LIMIT = 20000;

export class MeshCoreHopSnrRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private requireSource(sourceId: string, op: string): void {
    if (!sourceId) throw new Error(`MeshCoreHopSnrRepository.${op} requires a sourceId`);
  }

  private toRow(raw: Record<string, unknown>): MeshCoreHopSnrRow {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return {
      id: Number(r.id),
      sourceId: String(r.sourceId),
      traceTag: Number(r.traceTag),
      authCode: Number(r.authCode),
      hopIndex: Number(r.hopIndex),
      hopCount: Number(r.hopCount),
      hashBytes: Number(r.hashBytes),
      senderPublicKey: str(r.senderPublicKey),
      senderHash: str(r.senderHash),
      senderCandidates: Number(r.senderCandidates),
      receiverPublicKey: str(r.receiverPublicKey),
      receiverHash: str(r.receiverHash),
      receiverCandidates: Number(r.receiverCandidates),
      snrQuarterDb: Number(r.snrQuarterDb),
      initiated: r.initiated === true || r.initiated === 1,
      timestamp: Number(r.timestamp),
    };
  }

  /** Insert the rows of one trace. All rows must belong to `sourceId`. */
  async insertHops(sourceId: string, rows: MeshCoreHopSnrRow[]): Promise<void> {
    this.requireSource(sourceId, 'insertHops');
    if (rows.length === 0) return;
    const t = this.tables.meshcoreHopSnr;
    const values = rows.map((r) => ({
      sourceId,
      traceTag: r.traceTag,
      authCode: r.authCode,
      hopIndex: r.hopIndex,
      hopCount: r.hopCount,
      hashBytes: r.hashBytes,
      senderPublicKey: r.senderPublicKey,
      senderHash: r.senderHash,
      senderCandidates: r.senderCandidates,
      receiverPublicKey: r.receiverPublicKey,
      receiverHash: r.receiverHash,
      receiverCandidates: r.receiverCandidates,
      snrQuarterDb: r.snrQuarterDb,
      initiated: r.initiated,
      timestamp: r.timestamp,
    }));
    await this.db.insert(t).values(values);
  }

  /** True when this source already stored this trace at or after `sinceMs`. */
  async hasTrace(sourceId: string, traceTag: number, authCode: number, sinceMs: number): Promise<boolean> {
    this.requireSource(sourceId, 'hasTrace');
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select({ id: t.id }).from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.traceTag, traceTag), eq(t.authCode, authCode), gte(t.timestamp, sinceMs)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Hop rows where the contact `publicKey` is the sender or the receiver,
   * newest first, at or after `sinceMs`.
   */
  async getHistoryForNode(sourceId: string, publicKey: string, sinceMs: number, limit = HOP_SNR_HISTORY_LIMIT): Promise<MeshCoreHopSnrRow[]> {
    this.requireSource(sourceId, 'getHistoryForNode');
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select().from(t)
      .where(and(
        this.withSourceScope(t, sourceId),
        or(eq(t.senderPublicKey, publicKey), eq(t.receiverPublicKey, publicKey)),
        gte(t.timestamp, sinceMs),
      ))
      .orderBy(desc(t.timestamp), desc(t.id))
      .limit(Math.max(1, Math.min(limit, HOP_SNR_HISTORY_MAX_LIMIT)));
    return rows.map((r: Record<string, unknown>) => this.toRow(r));
  }

  /** Every hop row of the source at or after `sinceMs`, newest first. */
  async getRecent(sourceId: string, sinceMs: number, limit = HOP_SNR_HISTORY_LIMIT): Promise<MeshCoreHopSnrRow[]> {
    this.requireSource(sourceId, 'getRecent');
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select().from(t)
      .where(and(this.withSourceScope(t, sourceId), gte(t.timestamp, sinceMs)))
      .orderBy(desc(t.timestamp), desc(t.id))
      .limit(Math.max(1, Math.min(limit, HOP_SNR_HISTORY_MAX_LIMIT)));
    return rows.map((r: Record<string, unknown>) => this.toRow(r));
  }

  /**
   * The hop rows of the newest trace this instance SENT (`initiated`) that
   * involves the contact `publicKey` as sender or receiver, at or after
   * `sinceMs`, in hop order. Empty when there is none. One trace is one
   * `(traceTag, authCode)` pair, so rows of an older trace never mix in.
   */
  async getLatestInitiatedTraceFor(sourceId: string, publicKey: string, sinceMs: number): Promise<MeshCoreHopSnrRow[]> {
    this.requireSource(sourceId, 'getLatestInitiatedTraceFor');
    const t = this.tables.meshcoreHopSnr;
    const newest = await this.db.select().from(t)
      .where(and(
        this.withSourceScope(t, sourceId),
        eq(t.initiated, true),
        or(eq(t.senderPublicKey, publicKey), eq(t.receiverPublicKey, publicKey)),
        gte(t.timestamp, sinceMs),
      ))
      .orderBy(desc(t.timestamp), desc(t.id))
      .limit(1);
    if (newest.length === 0) return [];
    const head = this.toRow(newest[0] as Record<string, unknown>);
    return this.loadInitiatedTrace(sourceId, head.traceTag, head.authCode, sinceMs);
  }

  /**
   * Initiated traces of the source at or after `sinceMs`, newest trace first,
   * at most `limitTraces`; each trace's rows are in hop order. Grouping
   * (`(traceTag, authCode)`, newest row per hop index) is the same as
   * `getLatestInitiatedTraceFor`.
   */
  async getInitiatedTraces(sourceId: string, sinceMs: number, limitTraces: number): Promise<MeshCoreHopSnrRow[][]> {
    this.requireSource(sourceId, 'getInitiatedTraces');
    if (limitTraces <= 0) return [];
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select().from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.initiated, true), gte(t.timestamp, sinceMs)))
      .orderBy(desc(t.timestamp), desc(t.id))
      .limit(HOP_SNR_HISTORY_MAX_LIMIT);
    const order: string[] = [];
    const groups = new Map<string, MeshCoreHopSnrRow[]>();
    for (const raw of rows) {
      const row = this.toRow(raw as Record<string, unknown>);
      const key = `${row.traceTag}:${row.authCode}`;
      let g = groups.get(key);
      if (!g) {
        if (order.length >= limitTraces) continue;
        g = [];
        groups.set(key, g);
        order.push(key);
      }
      g.push(row);
    }
    return order.map((k) => this.dedupeHopIndexes(groups.get(k)!));
  }

  private async loadInitiatedTrace(sourceId: string, traceTag: number, authCode: number, sinceMs: number): Promise<MeshCoreHopSnrRow[]> {
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select().from(t)
      .where(and(
        this.withSourceScope(t, sourceId),
        eq(t.initiated, true),
        eq(t.traceTag, traceTag),
        eq(t.authCode, authCode),
        gte(t.timestamp, sinceMs),
      ))
      .orderBy(asc(t.hopIndex), desc(t.id));
    return this.dedupeHopIndexes(rows.map((r: Record<string, unknown>) => this.toRow(r)));
  }

  /** A re-used tag can leave duplicate hop indexes; keep the first (newest id) per index, in hop order. */
  private dedupeHopIndexes(rows: MeshCoreHopSnrRow[]): MeshCoreHopSnrRow[] {
    const sorted = [...rows].sort((a, b) => a.hopIndex - b.hopIndex || (b.id ?? 0) - (a.id ?? 0));
    const seen = new Set<number>();
    const out: MeshCoreHopSnrRow[] = [];
    for (const r of sorted) {
      if (seen.has(r.hopIndex)) continue;
      seen.add(r.hopIndex);
      out.push(r);
    }
    return out;
  }

  /**
   * Hop rows whose both ends resolved to a contact key (sent or overheard),
   * newest first, at or after `sinceMs`. For consumers that need
   * key-to-key links, such as position estimation.
   */
  async getResolvedLinks(sourceId: string, sinceMs: number, limit = HOP_SNR_HISTORY_LIMIT): Promise<MeshCoreHopSnrRow[]> {
    this.requireSource(sourceId, 'getResolvedLinks');
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select().from(t)
      .where(and(
        this.withSourceScope(t, sourceId),
        isNotNull(t.senderPublicKey),
        isNotNull(t.receiverPublicKey),
        gte(t.timestamp, sinceMs),
      ))
      .orderBy(desc(t.timestamp), desc(t.id))
      .limit(Math.max(1, Math.min(limit, HOP_SNR_HISTORY_MAX_LIMIT)));
    return rows.map((r: Record<string, unknown>) => this.toRow(r));
  }

  /** Retention: delete this source's rows older than `cutoffMs`. */
  async deleteOlderThan(sourceId: string, cutoffMs: number): Promise<void> {
    this.requireSource(sourceId, 'deleteOlderThan');
    const t = this.tables.meshcoreHopSnr;
    await this.db.delete(t).where(and(this.withSourceScope(t, sourceId), lt(t.timestamp, cutoffMs)));
  }

  /**
   * Clear one directional link's trace SNR history (#5970): every row of this
   * source whose sender is `sender` and whose receiver is `receiver`, at any
   * age. An end matches the way `summarizeHopSnrLinks` groups rows into one
   * graph: by public key when it is resolved, else by path hash (with no key),
   * else unknown (no key and no hash). At least one end must be a resolved
   * key. Returns the number of rows deleted.
   */
  async deleteLink(sourceId: string, sender: HopSnrLinkEnd, receiver: HopSnrLinkEnd): Promise<number> {
    this.requireSource(sourceId, 'deleteLink');
    if (!sender.publicKey && !receiver.publicKey) {
      throw new Error('MeshCoreHopSnrRepository.deleteLink requires a resolved publicKey on one end');
    }
    const t = this.tables.meshcoreHopSnr;
    const result = await this.db.delete(t).where(and(
      this.withSourceScope(t, sourceId),
      this.endMatches('sender', sender),
      this.endMatches('receiver', receiver),
    ));
    return this.getAffectedRows(result);
  }

  private endMatches(side: 'sender' | 'receiver', end: HopSnrLinkEnd): SQL | undefined {
    const t = this.tables.meshcoreHopSnr;
    const keyCol = side === 'sender' ? t.senderPublicKey : t.receiverPublicKey;
    const hashCol = side === 'sender' ? t.senderHash : t.receiverHash;
    if (end.publicKey) return eq(keyCol, end.publicKey);
    if (end.hash) return and(isNull(keyCol), eq(hashCol, end.hash));
    return and(isNull(keyCol), isNull(hashCol));
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    this.requireSource(sourceId, 'deleteBySourceId');
    const t = this.tables.meshcoreHopSnr;
    await this.db.delete(t).where(this.withSourceScope(t, sourceId));
  }
}
