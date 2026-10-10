/**
 * Repository for `meshcore_hop_snr` (issue #5722): per-hop SNR from MeshCore
 * TRACE packets. PER-SOURCE — every read and write takes a `sourceId`.
 *
 * Rows are directional: `receiver` heard `sender` at `snrQuarterDb / 4` dB.
 */
import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
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

/** Most rows one history read returns. */
export const HOP_SNR_HISTORY_LIMIT = 2000;

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
      .limit(Math.max(1, Math.min(limit, HOP_SNR_HISTORY_LIMIT)));
    return rows.map((r: Record<string, unknown>) => this.toRow(r));
  }

  /** Every hop row of the source at or after `sinceMs`, newest first. */
  async getRecent(sourceId: string, sinceMs: number, limit = HOP_SNR_HISTORY_LIMIT): Promise<MeshCoreHopSnrRow[]> {
    this.requireSource(sourceId, 'getRecent');
    const t = this.tables.meshcoreHopSnr;
    const rows = await this.db.select().from(t)
      .where(and(this.withSourceScope(t, sourceId), gte(t.timestamp, sinceMs)))
      .orderBy(desc(t.timestamp), desc(t.id))
      .limit(Math.max(1, Math.min(limit, HOP_SNR_HISTORY_LIMIT)));
    return rows.map((r: Record<string, unknown>) => this.toRow(r));
  }

  /** Retention: delete this source's rows older than `cutoffMs`. */
  async deleteOlderThan(sourceId: string, cutoffMs: number): Promise<void> {
    this.requireSource(sourceId, 'deleteOlderThan');
    const t = this.tables.meshcoreHopSnr;
    await this.db.delete(t).where(and(this.withSourceScope(t, sourceId), lt(t.timestamp, cutoffMs)));
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    this.requireSource(sourceId, 'deleteBySourceId');
    const t = this.tables.meshcoreHopSnr;
    await this.db.delete(t).where(this.withSourceScope(t, sourceId));
  }
}
