/**
 * Repository for `meshtastic_heard_repeaters` — the Meshtastic Heard-By side
 * table (Delivery Diagnostics epic #4816, Phase 4 WP1).
 *
 * A re-flood of our own outgoing Meshtastic channel packet, overheard back by
 * us, is the Meshtastic analog of MeshCore's self-echo correlation
 * (`meshcore_heard_repeaters` / `MeshCoreRepository.recordHeardRepeater`) —
 * this repository copies that shape directly. `relayByte` is only the last
 * byte of the relaying node's nodeNum (Meshtastic protobuf `relay_node`), so
 * identity is inherently ambiguous; candidate name resolution happens at
 * query time (WP3), never here.
 *
 * One row per (sourceId, messageId, relayByte). Dedups on that triple keeping
 * the best (max) observed SNR, refreshing `heardAt` on every re-flood.
 * PER-SOURCE (`sourceId`, scoped) — required on every write and read.
 */
import { and, desc, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbMeshtasticHeardRepeater {
  id?: number;
  sourceId: string;
  messageId: string;
  relayByte: number;
  snr?: number | null;
  heardAt: number;
  createdAt: number;
}

export interface RecordMeshtasticHeardRepeaterParams {
  sourceId: string;
  messageId: string;
  relayByte: number;
  snr?: number | null;
  heardAt: number;
}

/** Max of two nullable numbers; null only when both are null. */
function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export class MeshtasticHeardRepeatersRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Record (or refresh) a relay byte that re-flooded an outgoing channel
   * message. Dedups on (sourceId, messageId, relayByte); on a repeat
   * re-flood we keep the best (max) SNR and refresh `heardAt`. Returns the
   * merged record.
   */
  async recordHeardRepeater(
    record: RecordMeshtasticHeardRepeaterParams,
  ): Promise<DbMeshtasticHeardRepeater> {
    if (!record.sourceId) {
      throw new Error('MeshtasticHeardRepeatersRepository.recordHeardRepeater requires a sourceId');
    }
    if (!record.messageId) {
      throw new Error('MeshtasticHeardRepeatersRepository.recordHeardRepeater requires a messageId');
    }
    const { meshtasticHeardRepeaters } = this.tables;
    const now = this.now();

    const existingRows = await this.db
      .select()
      .from(meshtasticHeardRepeaters)
      .where(
        and(
          eq(meshtasticHeardRepeaters.sourceId, record.sourceId),
          eq(meshtasticHeardRepeaters.messageId, record.messageId),
          eq(meshtasticHeardRepeaters.relayByte, record.relayByte),
        ),
      )
      .limit(1);
    const existing = existingRows[0]
      ? (this.normalizeBigInts(existingRows[0]) as unknown as DbMeshtasticHeardRepeater)
      : undefined;

    if (existing) {
      const mergedSnr = maxNullable(existing.snr ?? null, record.snr ?? null);
      await this.db
        .update(meshtasticHeardRepeaters)
        .set({ snr: mergedSnr, heardAt: record.heardAt })
        .where(
          and(
            eq(meshtasticHeardRepeaters.sourceId, record.sourceId),
            eq(meshtasticHeardRepeaters.messageId, record.messageId),
            eq(meshtasticHeardRepeaters.relayByte, record.relayByte),
          ),
        );
      return { ...existing, snr: mergedSnr, heardAt: record.heardAt };
    }

    await this.db.insert(meshtasticHeardRepeaters).values({
      sourceId: record.sourceId,
      messageId: record.messageId,
      relayByte: record.relayByte,
      snr: record.snr ?? null,
      heardAt: record.heardAt,
      createdAt: now,
    });
    return {
      sourceId: record.sourceId,
      messageId: record.messageId,
      relayByte: record.relayByte,
      snr: record.snr ?? null,
      heardAt: record.heardAt,
      createdAt: now,
    };
  }

  /**
   * Fetch all heard-repeater rows for a single message (per-source scoped),
   * ordered by SNR descending (best-observed link first).
   */
  async getHeardRepeatersForMessage(
    messageId: string,
    sourceId: string,
  ): Promise<DbMeshtasticHeardRepeater[]> {
    if (!sourceId) {
      throw new Error('MeshtasticHeardRepeatersRepository.getHeardRepeatersForMessage requires a sourceId');
    }
    if (!messageId) {
      throw new Error('MeshtasticHeardRepeatersRepository.getHeardRepeatersForMessage requires a messageId');
    }
    const { meshtasticHeardRepeaters } = this.tables;
    const result = await this.db
      .select()
      .from(meshtasticHeardRepeaters)
      .where(
        and(
          eq(meshtasticHeardRepeaters.sourceId, sourceId),
          eq(meshtasticHeardRepeaters.messageId, messageId),
        ),
      )
      .orderBy(desc(meshtasticHeardRepeaters.snr));
    return this.normalizeBigInts(result) as unknown as DbMeshtasticHeardRepeater[];
  }
}
