/**
 * Repository for `pki_exchange_state` (issue #5691, "Reliable PKI").
 *
 * Per (source, node): the outcome of the last PKI exchange MeshMonitor started
 * with that node, and `lastPrimedAt`, the persisted hourly timer for priming
 * NodeInfo sends. PER-SOURCE — every read and write takes a `sourceId`.
 *
 * The state machine itself (which event moves which state) lives in
 * `src/server/services/reliablePki.ts`; this file only stores the result.
 */
import { and, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type PkiExchangeStateValue = 'successful' | 'pending' | 'failed';

/** Why the last exchange was marked failed. */
export type PkiFailureReason =
  | 'timeout'            // no reply or ack within the exchange deadline
  | 'max_retransmit'     // our radio gave up retransmitting (firmware MAX_RETRANSMIT)
  | 'pki_unknown_pubkey' // the node said it does not hold our public key
  | 'no_channel';        // the node could not decrypt the packet at all

export interface PkiExchangeStateRow {
  sourceId: string;
  nodeNum: number;
  state: PkiExchangeStateValue;
  stateChangedAt: number;
  lastSuccessAt: number | null;
  failingSince: number | null;
  lastFailureReason: PkiFailureReason | null;
  lastPrimedAt: number | null;
  updatedAt: number;
}

export class PkiExchangeStateRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private requireSource(sourceId: string, op: string): void {
    if (!sourceId) throw new Error(`PkiExchangeStateRepository.${op} requires a sourceId`);
  }

  private toRow(raw: Record<string, unknown>): PkiExchangeStateRow {
    const r = this.normalizeBigInts(raw) as Record<string, unknown>;
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      sourceId: String(r.sourceId),
      nodeNum: Number(r.nodeNum),
      state: r.state as PkiExchangeStateValue,
      stateChangedAt: Number(r.stateChangedAt),
      lastSuccessAt: num(r.lastSuccessAt),
      failingSince: num(r.failingSince),
      lastFailureReason: (r.lastFailureReason as PkiFailureReason | null) ?? null,
      lastPrimedAt: num(r.lastPrimedAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  async getState(sourceId: string, nodeNum: number): Promise<PkiExchangeStateRow | null> {
    this.requireSource(sourceId, 'getState');
    const t = this.tables.pkiExchangeState;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(this.withSourceScope(t, sourceId), eq(t.nodeNum, nodeNum)))
      .limit(1);
    return rows[0] ? this.toRow(rows[0]) : null;
  }

  /** Write the whole row for (sourceId, nodeNum), inserting it if missing. */
  private async write(row: PkiExchangeStateRow): Promise<PkiExchangeStateRow> {
    const t = this.tables.pkiExchangeState;
    const set = {
      state: row.state,
      stateChangedAt: row.stateChangedAt,
      lastSuccessAt: row.lastSuccessAt,
      failingSince: row.failingSince,
      lastFailureReason: row.lastFailureReason,
      lastPrimedAt: row.lastPrimedAt,
      updatedAt: row.updatedAt,
    };
    await this.upsert(t, { sourceId: row.sourceId, nodeNum: row.nodeNum, ...set }, [t.sourceId, t.nodeNum], set);
    return row;
  }

  private blank(sourceId: string, nodeNum: number, now: number): PkiExchangeStateRow {
    return {
      sourceId, nodeNum, state: 'pending', stateChangedAt: now,
      lastSuccessAt: null, failingSince: null, lastFailureReason: null, lastPrimedAt: null, updatedAt: now,
    };
  }

  /** A send that expects an answer went out. Keeps `failingSince` so the UI can say "failing since". */
  async markPending(sourceId: string, nodeNum: number, now: number = this.now()): Promise<PkiExchangeStateRow> {
    this.requireSource(sourceId, 'markPending');
    const prev = (await this.getState(sourceId, nodeNum)) ?? this.blank(sourceId, nodeNum, now);
    return this.write({
      ...prev,
      state: 'pending',
      stateChangedAt: prev.state === 'pending' ? prev.stateChangedAt : now,
      updatedAt: now,
    });
  }

  /** The node answered: clears the failure streak. */
  async markSuccessful(sourceId: string, nodeNum: number, now: number = this.now()): Promise<PkiExchangeStateRow> {
    this.requireSource(sourceId, 'markSuccessful');
    const prev = (await this.getState(sourceId, nodeNum)) ?? this.blank(sourceId, nodeNum, now);
    return this.write({
      ...prev,
      state: 'successful',
      stateChangedAt: prev.state === 'successful' ? prev.stateChangedAt : now,
      lastSuccessAt: now,
      failingSince: null,
      lastFailureReason: null,
      updatedAt: now,
    });
  }

  /** No answer, or an explicit decrypt failure. `failingSince` keeps the first failure time. */
  async markFailed(
    sourceId: string, nodeNum: number, reason: PkiFailureReason, now: number = this.now(),
  ): Promise<PkiExchangeStateRow> {
    this.requireSource(sourceId, 'markFailed');
    const prev = (await this.getState(sourceId, nodeNum)) ?? this.blank(sourceId, nodeNum, now);
    return this.write({
      ...prev,
      state: 'failed',
      stateChangedAt: prev.state === 'failed' ? prev.stateChangedAt : now,
      failingSince: prev.failingSince ?? now,
      lastFailureReason: reason,
      updatedAt: now,
    });
  }

  /** Stamp the hourly priming timer. Leaves the exchange state as it is. */
  async recordPriming(sourceId: string, nodeNum: number, now: number = this.now()): Promise<PkiExchangeStateRow> {
    this.requireSource(sourceId, 'recordPriming');
    const prev = await this.getState(sourceId, nodeNum);
    if (!prev) {
      // No exchange seen yet (e.g. the firmware primed after a NAK we never
      // tracked). Create the row as `failed`: priming only follows a failure.
      return this.write({
        ...this.blank(sourceId, nodeNum, now),
        state: 'failed', failingSince: now, lastPrimedAt: now,
      });
    }
    return this.write({ ...prev, lastPrimedAt: now, updatedAt: now });
  }

  /** Source deletion cleanup. Returns the number of rows removed. */
  async deleteBySourceId(sourceId: string): Promise<number> {
    this.requireSource(sourceId, 'deleteBySourceId');
    const t = this.tables.pkiExchangeState;
    const result = await this.executeRun(this.db.delete(t).where(this.withSourceScope(t, sourceId)));
    return this.getAffectedRows(result);
  }
}
