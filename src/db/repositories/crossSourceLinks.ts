/**
 * Repository for `cross_source_links` (#5561): hourly aggregates of "source
 * A's radio was heard by source B". See `src/db/schema/crossSourceLinks.ts`.
 *
 * `recordHearing` is a read-modify-write, not a single dialect-specific
 * upsert: running min/avg/max over nullable readings needs LEAST/COALESCE
 * forms that differ per backend (and MySQL evaluates ON DUPLICATE KEY
 * assignments left to right, PG/SQLite do not). Volume is low (only packets
 * from our own radios heard by our other sources), and the caller
 * (`crossSourceLinkRecorder.ts`) serialises writes per bucket key, so the
 * simple form is safe. A lost race on the first insert of a bucket falls back
 * to the update path.
 */
import { and, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type CrossSourceLinkKind = 'origin' | 'relay';
export type CrossSourceLinkTransport = 'rf' | 'mqtt_gateway';
export type CrossSourceLinkProtocol = 'meshtastic' | 'meshcore';

export const CROSS_SOURCE_LINK_BUCKET_MS = 3_600_000;

export function crossSourceLinkBucket(ms: number): number {
  return Math.floor(ms / CROSS_SOURCE_LINK_BUCKET_MS) * CROSS_SOURCE_LINK_BUCKET_MS;
}

export interface DbCrossSourceLink {
  id: number;
  txSourceId: string;
  txNodeId: string;
  rxSourceId: string;
  rxNodeId: string;
  protocol: CrossSourceLinkProtocol;
  kind: CrossSourceLinkKind;
  transportClass: CrossSourceLinkTransport;
  hourBucket: number;
  count: number;
  snrMin: number | null;
  snrAvg: number | null;
  snrMax: number | null;
  snrCount: number;
  rssiAvg: number | null;
  rssiCount: number;
  lastHeardAt: number;
}

export interface RecordCrossSourceHearingParams {
  txSourceId: string;
  txNodeId: string;
  rxSourceId: string;
  rxNodeId: string;
  protocol: CrossSourceLinkProtocol;
  kind: CrossSourceLinkKind;
  transportClass: CrossSourceLinkTransport;
  snr?: number | null;
  rssi?: number | null;
  heardAt: number;
}

export class CrossSourceLinksRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private normalize(row: any): DbCrossSourceLink {
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      id: Number(row.id),
      txSourceId: row.txSourceId,
      txNodeId: row.txNodeId,
      rxSourceId: row.rxSourceId,
      rxNodeId: row.rxNodeId,
      protocol: row.protocol,
      kind: row.kind,
      transportClass: row.transportClass,
      hourBucket: Number(row.hourBucket),
      count: Number(row.count),
      snrMin: num(row.snrMin),
      snrAvg: num(row.snrAvg),
      snrMax: num(row.snrMax),
      snrCount: Number(row.snrCount),
      rssiAvg: num(row.rssiAvg),
      rssiCount: Number(row.rssiCount),
      lastHeardAt: Number(row.lastHeardAt),
    };
  }

  private bucketWhere(p: RecordCrossSourceHearingParams, hourBucket: number) {
    const { crossSourceLinks: t } = this.tables;
    return and(
      eq(t.txSourceId, p.txSourceId),
      eq(t.txNodeId, p.txNodeId),
      eq(t.rxSourceId, p.rxSourceId),
      eq(t.rxNodeId, p.rxNodeId),
      eq(t.kind, p.kind),
      eq(t.transportClass, p.transportClass),
      eq(t.hourBucket, hourBucket),
    );
  }

  /** Fold one hearing into its hour bucket (insert the bucket on first use). */
  async recordHearing(p: RecordCrossSourceHearingParams): Promise<void> {
    if (!p.txSourceId || !p.rxSourceId || !p.txNodeId || !p.rxNodeId) {
      throw new Error('CrossSourceLinksRepository.recordHearing requires both source ids and both node ids');
    }
    if (p.txSourceId === p.rxSourceId) {
      throw new Error('CrossSourceLinksRepository.recordHearing: tx and rx source must differ');
    }
    const { crossSourceLinks: t } = this.tables;
    const hourBucket = crossSourceLinkBucket(p.heardAt);
    const snr = p.snr != null && Number.isFinite(p.snr) ? p.snr : null;
    const rssi = p.rssi != null && Number.isFinite(p.rssi) ? p.rssi : null;

    const findExisting = async (): Promise<DbCrossSourceLink | null> => {
      const rows = await this.db.select().from(t).where(this.bucketWhere(p, hourBucket)).limit(1);
      return rows[0] ? this.normalize(rows[0]) : null;
    };

    let existing = await findExisting();
    if (!existing) {
      await this.insertIgnore(t, {
        txSourceId: p.txSourceId,
        txNodeId: p.txNodeId,
        rxSourceId: p.rxSourceId,
        rxNodeId: p.rxNodeId,
        protocol: p.protocol,
        kind: p.kind,
        transportClass: p.transportClass,
        hourBucket,
        count: 0,
        snrCount: 0,
        rssiCount: 0,
        lastHeardAt: p.heardAt,
      });
      existing = await findExisting();
      if (!existing) return; // insert failed for a reason other than a duplicate; drop this sample
    }

    const snrCount = existing.snrCount + (snr !== null ? 1 : 0);
    const rssiCount = existing.rssiCount + (rssi !== null ? 1 : 0);
    const set = {
      count: existing.count + 1,
      snrMin: snr === null ? existing.snrMin : existing.snrMin === null ? snr : Math.min(existing.snrMin, snr),
      snrMax: snr === null ? existing.snrMax : existing.snrMax === null ? snr : Math.max(existing.snrMax, snr),
      snrAvg: snr === null ? existing.snrAvg : ((existing.snrAvg ?? 0) * existing.snrCount + snr) / snrCount,
      snrCount,
      rssiAvg: rssi === null ? existing.rssiAvg : ((existing.rssiAvg ?? 0) * existing.rssiCount + rssi) / rssiCount,
      rssiCount,
      lastHeardAt: Math.max(existing.lastHeardAt, p.heardAt),
    };
    await this.db.update(t).set(set).where(eq(t.id, existing.id));
  }

  /**
   * Buckets at or after `sinceMs` whose tx AND rx source are both in
   * `sourceIds` (the caller's readable set: the two-source read rule).
   */
  async getLinks(args: { sourceIds: string[]; sinceMs: number; limit?: number }): Promise<DbCrossSourceLink[]> {
    if (args.sourceIds.length === 0) return [];
    const { crossSourceLinks: t } = this.tables;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(
        gte(t.hourBucket, crossSourceLinkBucket(args.sinceMs)),
        inArray(t.txSourceId, args.sourceIds),
        inArray(t.rxSourceId, args.sourceIds),
      ))
      .orderBy(desc(t.hourBucket))
      .limit(Math.max(1, Math.min(args.limit ?? 20_000, 50_000)));
    return rows.map((r: any) => this.normalize(r));
  }

  /** Retention: drop buckets that started before `cutoffMs`. */
  async purgeOlderThan(cutoffMs: number): Promise<number> {
    const { crossSourceLinks: t } = this.tables;
    const result = await this.db.delete(t).where(lt(t.hourBucket, cutoffMs));
    return this.getAffectedRows(result);
  }

  /** Remove every link a source takes part in, as sender or receiver. */
  async deleteForSource(sourceId: string): Promise<number> {
    if (!sourceId) throw new Error('CrossSourceLinksRepository.deleteForSource requires a sourceId');
    const { crossSourceLinks: t } = this.tables;
    const result = await this.db.delete(t).where(or(eq(t.txSourceId, sourceId), eq(t.rxSourceId, sourceId)));
    return this.getAffectedRows(result);
  }

  async deleteAll(): Promise<number> {
    const { crossSourceLinks: t } = this.tables;
    const result = await this.db.delete(t);
    return this.getAffectedRows(result);
  }
}
