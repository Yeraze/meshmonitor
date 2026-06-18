/**
 * Dead Drop / Mailbox Repository.
 *
 * CRUD for the per-source async message store (dead_drop_messages) backing the
 * Dead Drop auto-responder feature ("mesh voicemail"). Messages are addressed
 * to a recipient *name* as typed by the sender; retrieval matches that name
 * against any identity form (short name, long name, node id, node num) of the
 * DM sender asking for their inbox — so the recipient proves identity via the
 * DM sender context rather than a fragile store-time node lookup.
 *
 * Soft-state: a message is "pending" until `playedAt` is set, hidden once
 * `deletedAt` is set, and treated as expired when `createdAt` is older than the
 * caller-supplied cutoff. Expired rows are filtered out of every read and can
 * be hard-purged via `purgeExpired`.
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, asc, isNull, inArray, gt, lt, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbDeadDropMessage } from '../types.js';

export interface DeadDropMessageInput {
  sourceId: string;
  shortId: string;
  recipientName: string;
  senderNodeNum: number;
  senderShortName: string;
  senderLongName: string;
  body: string;
}

export class DeadDropRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** True if a shortId is already in use for this source (collision check). */
  async shortIdExists(sourceId: string, shortId: string): Promise<boolean> {
    const { deadDropMessages } = this.tables;
    const result = await this.db
      .select({ id: deadDropMessages.id })
      .from(deadDropMessages)
      .where(and(eq(deadDropMessages.sourceId, sourceId), eq(deadDropMessages.shortId, shortId)))
      .limit(1);
    return result.length > 0;
  }

  /** Store a new message. createdAt defaults to now. */
  async insertMessage(input: DeadDropMessageInput, createdAt: number = Date.now()): Promise<void> {
    const { deadDropMessages } = this.tables;
    await this.db.insert(deadDropMessages).values({
      sourceId: input.sourceId,
      shortId: input.shortId,
      recipientName: input.recipientName,
      senderNodeNum: input.senderNodeNum,
      senderShortName: input.senderShortName,
      senderLongName: input.senderLongName,
      body: input.body,
      createdAt,
      playedAt: null,
      deletedAt: null,
    });
  }

  /**
   * Pending (unplayed, undeleted, unexpired) messages whose recipientName is any
   * of `recipientNames`, oldest first. Pass the retriever's identity forms.
   */
  async getPendingForRecipient(
    sourceId: string,
    recipientNames: string[],
    cutoff: number,
  ): Promise<DbDeadDropMessage[]> {
    const { deadDropMessages } = this.tables;
    if (recipientNames.length === 0) return [];
    const result = await this.db
      .select()
      .from(deadDropMessages)
      .where(and(
        eq(deadDropMessages.sourceId, sourceId),
        inArray(deadDropMessages.recipientName, recipientNames),
        isNull(deadDropMessages.playedAt),
        isNull(deadDropMessages.deletedAt),
        gt(deadDropMessages.createdAt, cutoff),
      ))
      .orderBy(asc(deadDropMessages.createdAt));
    return this.normalizeBigInts(result) as DbDeadDropMessage[];
  }

  /** Played-but-undeleted, unexpired messages for the recipient (drives `inbox clear`). */
  async getPlayedForRecipient(
    sourceId: string,
    recipientNames: string[],
    cutoff: number,
  ): Promise<DbDeadDropMessage[]> {
    const { deadDropMessages } = this.tables;
    if (recipientNames.length === 0) return [];
    const result = await this.db
      .select()
      .from(deadDropMessages)
      .where(and(
        eq(deadDropMessages.sourceId, sourceId),
        inArray(deadDropMessages.recipientName, recipientNames),
        isNull(deadDropMessages.deletedAt),
        gt(deadDropMessages.createdAt, cutoff),
      ))
      .orderBy(asc(deadDropMessages.createdAt));
    // Filter to played in JS so the same index serves both paths; small N per recipient.
    return (this.normalizeBigInts(result) as DbDeadDropMessage[]).filter(m => m.playedAt != null);
  }

  /** Count of pending messages addressed to a recipient (per-recipient cap). */
  async countPendingForRecipient(sourceId: string, recipientName: string, cutoff: number): Promise<number> {
    const { deadDropMessages } = this.tables;
    const result = await this.db
      .select({ c: count() })
      .from(deadDropMessages)
      .where(and(
        eq(deadDropMessages.sourceId, sourceId),
        eq(deadDropMessages.recipientName, recipientName),
        isNull(deadDropMessages.playedAt),
        isNull(deadDropMessages.deletedAt),
        gt(deadDropMessages.createdAt, cutoff),
      ));
    return Number(result[0]?.c ?? 0);
  }

  /** Count of a sender's outstanding (pending) messages (per-sender cap). */
  async countPendingFromSender(sourceId: string, senderNodeNum: number, cutoff: number): Promise<number> {
    const { deadDropMessages } = this.tables;
    const result = await this.db
      .select({ c: count() })
      .from(deadDropMessages)
      .where(and(
        eq(deadDropMessages.sourceId, sourceId),
        eq(deadDropMessages.senderNodeNum, senderNodeNum),
        isNull(deadDropMessages.playedAt),
        isNull(deadDropMessages.deletedAt),
        gt(deadDropMessages.createdAt, cutoff),
      ));
    return Number(result[0]?.c ?? 0);
  }

  /** Look up a single live (undeleted) message by its user-facing shortId. */
  async getByShortId(sourceId: string, shortId: string): Promise<DbDeadDropMessage | null> {
    const { deadDropMessages } = this.tables;
    const result = await this.db
      .select()
      .from(deadDropMessages)
      .where(and(
        eq(deadDropMessages.sourceId, sourceId),
        eq(deadDropMessages.shortId, shortId),
        isNull(deadDropMessages.deletedAt),
      ))
      .limit(1);
    const rows = this.normalizeBigInts(result) as DbDeadDropMessage[];
    return rows[0] ?? null;
  }

  /** Mark a set of messages as played (delivered). */
  async markPlayed(sourceId: string, ids: number[], ts: number = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    const { deadDropMessages } = this.tables;
    await this.db
      .update(deadDropMessages)
      .set({ playedAt: ts })
      .where(and(eq(deadDropMessages.sourceId, sourceId), inArray(deadDropMessages.id, ids)));
  }

  /** Soft-delete a set of messages. */
  async softDelete(sourceId: string, ids: number[], ts: number = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    const { deadDropMessages } = this.tables;
    await this.db
      .update(deadDropMessages)
      .set({ deletedAt: ts })
      .where(and(eq(deadDropMessages.sourceId, sourceId), inArray(deadDropMessages.id, ids)));
  }

  /** Hard-delete rows older than the cutoff (maintenance). Returns nothing. */
  async purgeExpired(cutoff: number): Promise<void> {
    const { deadDropMessages } = this.tables;
    await this.db
      .delete(deadDropMessages)
      .where(lt(deadDropMessages.createdAt, cutoff));
  }
}
