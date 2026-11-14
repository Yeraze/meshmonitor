/**
 * Repository for `direct_rf_contacts` (#6210): a per-source daily rollup of
 * the nodes a source's own radio heard directly over RF. See
 * `src/db/schema/directRfContacts.ts`.
 *
 * `applyDelta` is a read-modify-write, not a dialect-specific upsert: best
 * SNR/RSSI over nullable readings needs MAX/COALESCE forms that differ per
 * backend (and MySQL evaluates ON DUPLICATE KEY assignments left to right).
 * The only writer (`directRfContactRecorder.ts`) coalesces receptions in
 * memory and flushes one delta per (source, node, day) at a time, so the
 * simple form is safe. A lost race on the first insert of a day falls back
 * to the update path.
 *
 * Windowed reads return whole-day rows that overlap the window and fold
 * them in JS: a 30-day window over a few hundred nodes is a few thousand
 * rows, and folding in JS keeps the query dialect-neutral. A window edge
 * that cuts a day counts that whole day's receptions.
 */
import { and, asc, eq, gte, lt, lte } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export const DIRECT_RF_DAY_MS = 86_400_000;

/** Unix ms floored to the start of its UTC day. */
export function directRfDayBucket(ms: number): number {
  return Math.floor(ms / DIRECT_RF_DAY_MS) * DIRECT_RF_DAY_MS;
}

export type DirectRfProtocol = 'meshtastic' | 'meshcore';

/** One coalesced batch of direct receptions for one (source, node, day). */
export interface DirectRfContactDelta {
  sourceId: string;
  protocol: DirectRfProtocol;
  /** `!xxxxxxxx` (Meshtastic) or a 64-hex public key (MeshCore). */
  nodeKey: string;
  nodeNum: number | null;
  dayBucket: number;
  firstHeardAt: number;
  lastHeardAt: number;
  count: number;
  bestSnr: number | null;
  bestRssi: number | null;
  snrSum: number;
  snrCount: number;
  rssiSum: number;
  rssiCount: number;
}

export interface DbDirectRfContactDay {
  id: number;
  sourceId: string;
  protocol: DirectRfProtocol;
  nodeKey: string;
  nodeNum: number | null;
  dayBucket: number;
  firstHeardAt: number;
  lastHeardAt: number;
  receptionCount: number;
  bestSnr: number | null;
  bestRssi: number | null;
  snrSum: number;
  snrCount: number;
  rssiSum: number;
  rssiCount: number;
}

/** One node folded over a window. */
export interface DirectRfContactSummary {
  nodeKey: string;
  nodeNum: number | null;
  protocol: DirectRfProtocol;
  firstHeardAt: number;
  lastHeardAt: number;
  receptionCount: number;
  bestSnr: number | null;
  bestRssi: number | null;
  avgSnr: number | null;
  avgRssi: number | null;
  /** UTC days in the window with at least one direct reception. */
  daysHeard: number;
}

/** One node's day, for the detail-page sparkline. */
export interface DirectRfContactDailyPoint {
  dayBucket: number;
  receptionCount: number;
  firstHeardAt: number;
  lastHeardAt: number;
  bestSnr: number | null;
  bestRssi: number | null;
}

export interface DirectRfWindow {
  sourceId: string;
  fromMs: number;
  toMs: number;
}

const maxOrNull = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

export class DirectRfContactsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private normalize(row: Record<string, unknown>): DbDirectRfContactDay {
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      id: Number(row.id),
      sourceId: String(row.sourceId),
      protocol: row.protocol as DirectRfProtocol,
      nodeKey: String(row.nodeKey),
      nodeNum: num(row.nodeNum),
      dayBucket: Number(row.dayBucket),
      firstHeardAt: Number(row.firstHeardAt),
      lastHeardAt: Number(row.lastHeardAt),
      receptionCount: Number(row.receptionCount),
      bestSnr: num(row.bestSnr),
      bestRssi: num(row.bestRssi),
      snrSum: Number(row.snrSum ?? 0),
      snrCount: Number(row.snrCount ?? 0),
      rssiSum: Number(row.rssiSum ?? 0),
      rssiCount: Number(row.rssiCount ?? 0),
    };
  }

  /** Fold one coalesced batch into its day row (insert the row on first use). */
  async applyDelta(d: DirectRfContactDelta): Promise<void> {
    if (!d.sourceId || !d.nodeKey) {
      throw new Error('DirectRfContactsRepository.applyDelta requires a sourceId and a nodeKey');
    }
    if (d.count <= 0) return;
    const { directRfContacts: t } = this.tables;
    const where = and(
      eq(t.sourceId, d.sourceId),
      eq(t.nodeKey, d.nodeKey),
      eq(t.dayBucket, d.dayBucket),
    );
    const findExisting = async (): Promise<DbDirectRfContactDay | null> => {
      const rows = await this.db.select().from(t).where(where).limit(1);
      return rows[0] ? this.normalize(rows[0]) : null;
    };

    let existing = await findExisting();
    if (!existing) {
      const result = await this.insertIgnore(t, {
        sourceId: d.sourceId,
        protocol: d.protocol,
        nodeKey: d.nodeKey,
        nodeNum: d.nodeNum,
        dayBucket: d.dayBucket,
        firstHeardAt: d.firstHeardAt,
        lastHeardAt: d.lastHeardAt,
        receptionCount: d.count,
        bestSnr: d.bestSnr,
        bestRssi: d.bestRssi,
        snrSum: d.snrSum,
        snrCount: d.snrCount,
        rssiSum: d.rssiSum,
        rssiCount: d.rssiCount,
      });
      // Our insert landed: the row holds exactly this delta, nothing to merge.
      if (this.getAffectedRows(result) > 0) return;
      // Lost a race to another writer's insert: merge into its row instead.
      existing = await findExisting();
      // A lost race always finds the winner's row above and merges into it.
      // Reaching here means the insert failed with no row present (not a
      // duplicate), so there is nothing to merge into; drop this batch.
      if (!existing) return;
    }

    await this.db.update(t).set({
      firstHeardAt: Math.min(existing.firstHeardAt, d.firstHeardAt),
      lastHeardAt: Math.max(existing.lastHeardAt, d.lastHeardAt),
      receptionCount: existing.receptionCount + d.count,
      bestSnr: maxOrNull(existing.bestSnr, d.bestSnr),
      bestRssi: maxOrNull(existing.bestRssi, d.bestRssi),
      snrSum: existing.snrSum + d.snrSum,
      snrCount: existing.snrCount + d.snrCount,
      rssiSum: existing.rssiSum + d.rssiSum,
      rssiCount: existing.rssiCount + d.rssiCount,
      ...(existing.nodeNum === null && d.nodeNum !== null ? { nodeNum: d.nodeNum } : {}),
    }).where(eq(t.id, existing.id));
  }

  /** Day rows of one source that overlap [fromMs, toMs]. */
  private async getDayRows(w: DirectRfWindow, nodeKey?: string): Promise<DbDirectRfContactDay[]> {
    if (!w.sourceId) throw new Error('DirectRfContactsRepository: sourceId is required');
    const { directRfContacts: t } = this.tables;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(
        this.withSourceScope(t, w.sourceId),
        gte(t.dayBucket, directRfDayBucket(w.fromMs)),
        lte(t.dayBucket, directRfDayBucket(w.toMs)),
        gte(t.lastHeardAt, w.fromMs),
        lte(t.firstHeardAt, w.toMs),
        nodeKey !== undefined ? eq(t.nodeKey, nodeKey) : undefined,
      ))
      .orderBy(asc(t.dayBucket));
    return (rows as Array<Record<string, unknown>>).map((r) => this.normalize(r));
  }

  /**
   * Every node this source heard directly in [fromMs, toMs], one summary per
   * node, most recently heard first. `nodeKey` narrows it to one node.
   */
  async getContacts(w: DirectRfWindow & { nodeKey?: string }): Promise<DirectRfContactSummary[]> {
    const rows = await this.getDayRows(w, w.nodeKey);
    const acc = new Map<string, DirectRfContactSummary & { snrSum: number; snrCount: number; rssiSum: number; rssiCount: number }>();
    for (const r of rows) {
      const cur = acc.get(r.nodeKey);
      if (!cur) {
        acc.set(r.nodeKey, {
          nodeKey: r.nodeKey,
          nodeNum: r.nodeNum,
          protocol: r.protocol,
          firstHeardAt: r.firstHeardAt,
          lastHeardAt: r.lastHeardAt,
          receptionCount: r.receptionCount,
          bestSnr: r.bestSnr,
          bestRssi: r.bestRssi,
          avgSnr: null,
          avgRssi: null,
          daysHeard: 1,
          snrSum: r.snrSum,
          snrCount: r.snrCount,
          rssiSum: r.rssiSum,
          rssiCount: r.rssiCount,
        });
        continue;
      }
      cur.nodeNum = cur.nodeNum ?? r.nodeNum;
      cur.firstHeardAt = Math.min(cur.firstHeardAt, r.firstHeardAt);
      cur.lastHeardAt = Math.max(cur.lastHeardAt, r.lastHeardAt);
      cur.receptionCount += r.receptionCount;
      cur.bestSnr = maxOrNull(cur.bestSnr, r.bestSnr);
      cur.bestRssi = maxOrNull(cur.bestRssi, r.bestRssi);
      cur.daysHeard += 1;
      cur.snrSum += r.snrSum;
      cur.snrCount += r.snrCount;
      cur.rssiSum += r.rssiSum;
      cur.rssiCount += r.rssiCount;
    }
    return Array.from(acc.values())
      .map(({ snrSum, snrCount, rssiSum, rssiCount, ...s }) => ({
        ...s,
        avgSnr: snrCount > 0 ? snrSum / snrCount : null,
        avgRssi: rssiCount > 0 ? rssiSum / rssiCount : null,
      }))
      .sort((a, b) => b.lastHeardAt - a.lastHeardAt);
  }

  /** One node's day rows in [fromMs, toMs], oldest first. */
  async getNodeDaily(w: DirectRfWindow & { nodeKey: string }): Promise<DirectRfContactDailyPoint[]> {
    if (!w.nodeKey) throw new Error('DirectRfContactsRepository.getNodeDaily requires a nodeKey');
    const rows = await this.getDayRows(w, w.nodeKey);
    return rows.map((r) => ({
      dayBucket: r.dayBucket,
      receptionCount: r.receptionCount,
      firstHeardAt: r.firstHeardAt,
      lastHeardAt: r.lastHeardAt,
      bestSnr: r.bestSnr,
      bestRssi: r.bestRssi,
    }));
  }

  /** Retention: drop every day row that started before `cutoffDayBucket`. Idempotent. */
  async purgeOlderThan(cutoffDayBucket: number): Promise<number> {
    const { directRfContacts: t } = this.tables;
    const result = await this.db.delete(t).where(lt(t.dayBucket, cutoffDayBucket));
    return this.getAffectedRows(result);
  }

  async deleteForSource(sourceId: string): Promise<number> {
    if (!sourceId) throw new Error('DirectRfContactsRepository.deleteForSource requires a sourceId');
    const { directRfContacts: t } = this.tables;
    const result = await this.db.delete(t).where(this.withSourceScope(t, sourceId));
    return this.getAffectedRows(result);
  }

  /** Unscoped on purpose: only the admin global purge (`purgeAllNodesAsync` with no sourceId) calls this. */
  async deleteAll(): Promise<number> {
    const { directRfContacts: t } = this.tables;
    const result = await this.db.delete(t);
    return this.getAffectedRows(result);
  }
}
