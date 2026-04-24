/**
 * Messages Repository
 *
 * Handles all message-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, gte, and, or, desc, sql, like, ilike, inArray, isNotNull, isNull, ne, notInArray, SQL, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbMessage } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Repository for message operations
 */
export class MessagesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert a new message (ignores duplicates).
   * Keeps branching: different upsert syntax and result shapes per dialect.
   */
  async insertMessage(messageData: DbMessage, sourceId?: string): Promise<boolean> {
    const { messages } = this.tables;
    const values: any = {
      id: messageData.id,
      fromNodeNum: messageData.fromNodeNum,
      toNodeNum: messageData.toNodeNum,
      fromNodeId: messageData.fromNodeId,
      toNodeId: messageData.toNodeId,
      text: messageData.text,
      channel: messageData.channel,
      portnum: messageData.portnum ?? null,
      requestId: messageData.requestId ?? null,
      timestamp: messageData.timestamp,
      rxTime: messageData.rxTime ?? null,
      hopStart: messageData.hopStart ?? null,
      hopLimit: messageData.hopLimit ?? null,
      relayNode: messageData.relayNode ?? null,
      replyId: messageData.replyId ?? null,
      emoji: messageData.emoji ?? null,
      viaMqtt: messageData.viaMqtt ?? null,
      viaStoreForward: messageData.viaStoreForward ?? null,
      rxSnr: messageData.rxSnr ?? null,
      rxRssi: messageData.rxRssi ?? null,
      ackFailed: messageData.ackFailed ?? null,
      routingErrorReceived: messageData.routingErrorReceived ?? null,
      deliveryState: messageData.deliveryState ?? null,
      wantAck: messageData.wantAck ?? null,
      ackFromNode: messageData.ackFromNode ?? null,
      createdAt: messageData.createdAt,
      decryptedBy: messageData.decryptedBy ?? null,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }

    const result = await this.insertIgnore(messages, values);
    return this.getAffectedRows(result) > 0;
  }

  /**
   * Get a message by ID
   */
  async getMessage(id: string): Promise<DbMessage | null> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbMessage;
  }

  /**
   * Get a message by requestId
   */
  async getMessageByRequestId(requestId: number): Promise<DbMessage | null> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(eq(messages.requestId, requestId))
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbMessage;
  }

  /**
   * Get messages with pagination, ordered by rxTime/timestamp desc.
   *
   * `excludePortnums` drops rows whose portnum matches any in the list. NULL
   * portnums are always retained (legacy rows predate the column). UI feeds
   * pass `[PortNum.TRACEROUTE_APP]` so traceroute rows don't consume the
   * fixed-size window the client filters down to text messages (issue #2741).
   */
  async getMessages(
    limit: number = 100,
    offset: number = 0,
    sourceId?: string,
    excludePortnums?: number[],
  ): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const whereClause = (excludePortnums && excludePortnums.length > 0)
      ? and(
          this.withSourceScope(messages, sourceId),
          or(isNull(messages.portnum), notInArray(messages.portnum, excludePortnums)),
        )
      : this.withSourceScope(messages, sourceId);
    const result = await this.db
      .select()
      .from(messages)
      .where(whereClause)
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages by channel
   */
  async getMessagesByChannel(channel: number, limit: number = 100, offset: number = 0, sourceId?: string): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channel, channel), this.withSourceScope(messages, sourceId)))
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages in a channel strictly before a cursor timestamp (cursor-based pagination).
   *
   * @param channel    Channel number to filter on
   * @param before     Exclusive upper-bound for COALESCE(rxTime, timestamp) in ms.
   *                   If undefined, no upper bound is applied (returns newest `limit` rows).
   * @param limit      Max rows to return
   * @param sourceId   Optional source scope
   */
  async getMessagesBeforeInChannel(
    channel: number,
    before: number | undefined,
    limit: number = 100,
    sourceId?: string
  ): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const timeExpr = sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`;
    const conditions: (SQL | undefined)[] = [
      eq(messages.channel, channel),
      this.withSourceScope(messages, sourceId),
    ];
    if (before !== undefined) {
      conditions.push(sql`${timeExpr} < ${before}`);
    }
    const result = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(timeExpr))
      .limit(limit);
    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get direct messages between two nodes
   */
  async getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100, offset: number = 0, sourceId?: string): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.portnum, 1),
          eq(messages.channel, -1),
          or(
            and(eq(messages.fromNodeId, nodeId1), eq(messages.toNodeId, nodeId2)),
            and(eq(messages.fromNodeId, nodeId2), eq(messages.toNodeId, nodeId1))
          ),
          this.withSourceScope(messages, sourceId)
        )
      )
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages after a timestamp
   */
  async getMessagesAfterTimestamp(timestamp: number, sourceId?: string): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(and(gt(messages.timestamp, timestamp), this.withSourceScope(messages, sourceId)))
      .orderBy(messages.timestamp);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get total message count
   */
  async getMessageCount(sourceId?: string): Promise<number> {
    const { messages } = this.tables;
    const result = await this.db.select({ count: count() }).from(messages)
      .where(this.withSourceScope(messages, sourceId));
    return Number(result[0].count);
  }

  /**
   * Delete a message by ID
   */
  async deleteMessage(id: string): Promise<boolean> {
    const { messages } = this.tables;
    const existing = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, id));

    if (existing.length === 0) return false;

    await this.db.delete(messages).where(eq(messages.id, id));
    return true;
  }

  /**
   * Purge all messages from a channel (optionally scoped to a single source).
   * When sourceId is provided, only messages belonging to that source are deleted.
   */
  async purgeChannelMessages(channel: number, sourceId?: string): Promise<number> {
    const { messages } = this.tables;
    const condition = and(eq(messages.channel, channel), this.withSourceScope(messages, sourceId));
    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(messages)
      .where(condition);
    await this.db.delete(messages).where(condition);
    return deletedCount;
  }

  /**
   * Purge direct messages to/from a node (optionally scoped to a single source).
   * When sourceId is provided, only messages belonging to that source are deleted.
   */
  async purgeDirectMessages(nodeNum: number, sourceId?: string): Promise<number> {
    const { messages } = this.tables;
    const condition = and(
      or(
        eq(messages.fromNodeNum, nodeNum),
        eq(messages.toNodeNum, nodeNum)
      ),
      sql`${messages.toNodeId} != '!ffffffff'`,
      this.withSourceScope(messages, sourceId)
    );
    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(messages)
      .where(condition);
    await this.db.delete(messages).where(condition);
    return deletedCount;
  }

  /**
   * SQLite-only synchronous insert of a message (INSERT OR IGNORE).
   * Mirrors `insertMessage()` but runs synchronously so the legacy sync
   * facade on `DatabaseService` can keep its non-async signature.
   */
  insertMessageSqlite(messageData: DbMessage, sourceId?: string): boolean {
    if (!this.sqliteDb) {
      throw new Error('insertMessageSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const values: any = {
      id: messageData.id,
      fromNodeNum: messageData.fromNodeNum,
      toNodeNum: messageData.toNodeNum,
      fromNodeId: messageData.fromNodeId,
      toNodeId: messageData.toNodeId,
      text: messageData.text,
      channel: messageData.channel,
      portnum: messageData.portnum ?? null,
      requestId: (messageData as any).requestId ?? null,
      timestamp: messageData.timestamp,
      rxTime: messageData.rxTime ?? null,
      hopStart: messageData.hopStart ?? null,
      hopLimit: messageData.hopLimit ?? null,
      relayNode: messageData.relayNode ?? null,
      replyId: messageData.replyId ?? null,
      emoji: messageData.emoji ?? null,
      viaMqtt: messageData.viaMqtt ?? null,
      viaStoreForward: (messageData as any).viaStoreForward ?? null,
      rxSnr: messageData.rxSnr ?? null,
      rxRssi: messageData.rxRssi ?? null,
      ackFailed: (messageData as any).ackFailed ?? null,
      routingErrorReceived: (messageData as any).routingErrorReceived ?? null,
      deliveryState: (messageData as any).deliveryState ?? null,
      wantAck: (messageData as any).wantAck ?? null,
      ackFromNode: (messageData as any).ackFromNode ?? null,
      createdAt: messageData.createdAt,
      decryptedBy: (messageData as any).decryptedBy ?? null,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }
    const result: any = db.insert(messages).values(values).onConflictDoNothing().run();
    return Number(result?.changes ?? 0) > 0;
  }

  /**
   * SQLite-only synchronous fetch of a single message by id.
   */
  getMessageSqlite(id: string): DbMessage | null {
    if (!this.sqliteDb) {
      throw new Error('getMessageSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const rows = db.select().from(messages).where(eq(messages.id, id)).limit(1).all();
    if (rows.length === 0) return null;
    return this.normalizeBigInts(rows[0]) as DbMessage;
  }

  /**
   * SQLite-only synchronous fetch of a single message by requestId.
   */
  getMessageByRequestIdSqlite(requestId: number): DbMessage | null {
    if (!this.sqliteDb) {
      throw new Error('getMessageByRequestIdSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const rows = db.select().from(messages).where(eq(messages.requestId, requestId)).limit(1).all();
    if (rows.length === 0) return null;
    return this.normalizeBigInts(rows[0]) as DbMessage;
  }

  /**
   * SQLite-only synchronous paginated fetch of messages.
   */
  getMessagesSqlite(limit: number = 100, offset: number = 0, sourceId?: string): DbMessage[] {
    if (!this.sqliteDb) {
      throw new Error('getMessagesSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const rows = db
      .select()
      .from(messages)
      .where(this.withSourceScope(messages, sourceId))
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset)
      .all();
    return this.normalizeBigInts(rows) as DbMessage[];
  }

  /**
   * SQLite-only synchronous paginated fetch of messages by channel.
   */
  getMessagesByChannelSqlite(channel: number, limit: number = 100, offset: number = 0, sourceId?: string): DbMessage[] {
    if (!this.sqliteDb) {
      throw new Error('getMessagesByChannelSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const rows = db
      .select()
      .from(messages)
      .where(and(eq(messages.channel, channel), this.withSourceScope(messages, sourceId)))
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset)
      .all();
    return this.normalizeBigInts(rows) as DbMessage[];
  }

  /**
   * SQLite-only synchronous fetch of messages after a timestamp.
   */
  getMessagesAfterTimestampSqlite(timestamp: number, sourceId?: string): DbMessage[] {
    if (!this.sqliteDb) {
      throw new Error('getMessagesAfterTimestampSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const rows = db
      .select()
      .from(messages)
      .where(and(gt(messages.timestamp, timestamp), this.withSourceScope(messages, sourceId)))
      .orderBy(messages.timestamp)
      .all();
    return this.normalizeBigInts(rows) as DbMessage[];
  }

  /**
   * SQLite-only synchronous total message count.
   */
  getMessageCountSqlite(sourceId?: string): number {
    if (!this.sqliteDb) {
      throw new Error('getMessageCountSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const rows = db
      .select({ count: count() })
      .from(messages)
      .where(this.withSourceScope(messages, sourceId))
      .all();
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * SQLite-only synchronous delete-by-id. Returns true when a row was removed.
   */
  deleteMessageSqlite(id: string): boolean {
    if (!this.sqliteDb) {
      throw new Error('deleteMessageSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const result = db.delete(messages).where(eq(messages.id, id)).run();
    return Number(result.changes) > 0;
  }

  /**
   * SQLite-only synchronous cleanup of messages older than `days`.
   * Optionally scope to a single source. Returns the number of rows deleted.
   */
  cleanupOldMessagesSqlite(days: number = 30, sourceId?: string): number {
    if (!this.sqliteDb) {
      throw new Error('cleanupOldMessagesSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const condition = sourceId
      ? and(lt(messages.timestamp, cutoff), this.withSourceScope(messages, sourceId))
      : lt(messages.timestamp, cutoff);
    const result = db.delete(messages).where(condition).run();
    return Number(result.changes);
  }

  /**
   * SQLite-only synchronous delete of broadcast messages sent by a node.
   * (i.e. messages where fromNodeNum = nodeNum AND toNodeId = '!ffffffff')
   * Used by deleteNode to clean up public-channel messages from a deleted node.
   */
  deleteBroadcastMessagesFromNodeSqlite(nodeNum: number): number {
    if (!this.sqliteDb) {
      throw new Error('deleteBroadcastMessagesFromNodeSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const result = db
      .delete(messages)
      .where(and(eq(messages.fromNodeNum, nodeNum), eq(messages.toNodeId, '!ffffffff')))
      .run();
    return Number(result.changes);
  }

  /**
   * SQLite-only synchronous wipe of ALL messages.
   * Mirrors `deleteAllMessages()` for the sync DatabaseService facade.
   */
  deleteAllMessagesSqlite(): number {
    if (!this.sqliteDb) {
      throw new Error('deleteAllMessagesSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const result = db.delete(messages).run();
    return Number(result.changes);
  }

  /**
   * SQLite-only synchronous ACK update by requestId. Matches
   * `updateMessageAckByRequestId()` but the `ackFailed -> 'failed' / 'delivered'`
   * mapping that the sync facade historically used (not 'confirmed') is preserved.
   */
  updateMessageAckByRequestIdSqlite(requestId: number, ackFailed: boolean = false): boolean {
    if (!this.sqliteDb) {
      throw new Error('updateMessageAckByRequestIdSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const deliveryState = ackFailed ? 'failed' : 'delivered';
    const result = db
      .update(messages)
      .set({
        ackFailed,
        routingErrorReceived: ackFailed,
        deliveryState,
      })
      .where(eq(messages.requestId, requestId))
      .run();
    return Number(result.changes) > 0;
  }

  /**
   * SQLite-only synchronous delivery-state update.
   * Keeps in sync with `updateMessageDeliveryState()`; additionally sets
   * `ackFailed` when the state is 'failed' (matches old raw-SQL behavior).
   */
  updateMessageDeliveryStateSqlite(
    requestId: number,
    deliveryState: 'delivered' | 'confirmed' | 'failed',
  ): boolean {
    if (!this.sqliteDb) {
      throw new Error('updateMessageDeliveryStateSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const ackFailed = deliveryState === 'failed';
    const result = db
      .update(messages)
      .set({ deliveryState, ackFailed })
      .where(eq(messages.requestId, requestId))
      .run();
    return Number(result.changes) > 0;
  }

  /**
   * SQLite-only synchronous timestamp/rxTime update (fired when an ACK arrives).
   */
  updateMessageTimestampsSqlite(requestId: number, rxTime: number): boolean {
    if (!this.sqliteDb) {
      throw new Error('updateMessageTimestampsSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const result = db
      .update(messages)
      .set({ rxTime, timestamp: rxTime })
      .where(eq(messages.requestId, requestId))
      .run();
    return Number(result.changes) > 0;
  }

  /**
   * Aggregate message count by day for the last `days` days.
   * Optionally scope to a single source. Returns an array of
   * { date: 'YYYY-MM-DD', count } rows in ascending date order.
   *
   * Keeps branching: per-dialect date formatting.
   */
  async getMessagesByDay(days: number = 7, sourceId?: string): Promise<Array<{ date: string; count: number }>> {
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const { messages } = this.tables;

    const dateExpr = this.isSQLite()
      ? sql<string>`date(${messages.timestamp}/1000, 'unixepoch')`
      : this.isMySQL()
      ? sql<string>`DATE_FORMAT(FROM_UNIXTIME(${messages.timestamp}/1000), '%Y-%m-%d')`
      : sql<string>`to_char(to_timestamp(${messages.timestamp}/1000), 'YYYY-MM-DD')`;

    const condition = and(gt(messages.timestamp, cutoff), this.withSourceScope(messages, sourceId));

    const rows = await this.db
      .select({ date: dateExpr, count: count() })
      .from(messages)
      .where(condition)
      .groupBy(dateExpr)
      .orderBy(dateExpr);

    return (rows as Array<{ date: string; count: number | bigint }>).map(r => ({
      date: r.date,
      count: Number(r.count),
    }));
  }

  /**
   * SQLite-only synchronous variant of `getMessagesByDay()`.
   * Used by the sync `DatabaseService.getMessagesByDay` facade.
   */
  getMessagesByDaySqlite(days: number = 7, sourceId?: string): Array<{ date: string; count: number }> {
    if (!this.sqliteDb) {
      throw new Error('getMessagesByDaySqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const dateExpr = sql<string>`date(${messages.timestamp}/1000, 'unixepoch')`;
    const condition = sourceId
      ? and(gt(messages.timestamp, cutoff), this.withSourceScope(messages, sourceId))
      : gt(messages.timestamp, cutoff);
    const rows = db
      .select({ date: dateExpr, count: count() })
      .from(messages)
      .where(condition)
      .groupBy(dateExpr)
      .orderBy(dateExpr)
      .all();
    return (rows as Array<{ date: string; count: number | bigint }>).map(r => ({
      date: r.date,
      count: Number(r.count),
    }));
  }

  /**
   * Cleanup old messages scoped to a specific source (async, all backends).
   * Returns the number of rows deleted. When sourceId is provided, only
   * messages belonging to that source are cleaned up.
   */
  async cleanupOldMessagesForSource(days: number, sourceId: string): Promise<number> {
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const { messages } = this.tables;
    const condition = and(lt(messages.timestamp, cutoff), this.withSourceScope(messages, sourceId));

    // Count first so we can return an affected-row count consistently across
    // dialects (MySQL's delete result shape is awkward with Drizzle here).
    const [{ c }] = await this.db
      .select({ c: count() })
      .from(messages)
      .where(condition);
    await this.db.delete(messages).where(condition);
    return Number(c);
  }

  /**
   * SQLite-only synchronous purge of channel messages. Mirrors
   * `purgeChannelMessages()` but returns the count synchronously so the
   * sync `DatabaseService` facade can use it directly. Uses Drizzle query
   * builders so column names come from the schema.
   */
  purgeChannelMessagesSqlite(channel: number, sourceId?: string): number {
    if (!this.sqliteDb) {
      throw new Error('purgeChannelMessagesSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const condition = and(eq(messages.channel, channel), this.withSourceScope(messages, sourceId));
    const result = db.delete(messages).where(condition).run();
    return Number(result.changes);
  }

  /**
   * SQLite-only synchronous purge of direct messages to/from a node.
   * Mirrors `purgeDirectMessages()` — excludes broadcast messages
   * (`toNodeId != '!ffffffff'`) and scopes by source when provided.
   */
  purgeDirectMessagesSqlite(nodeNum: number, sourceId?: string): number {
    if (!this.sqliteDb) {
      throw new Error('purgeDirectMessagesSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const condition = and(
      or(
        eq(messages.fromNodeNum, nodeNum),
        eq(messages.toNodeNum, nodeNum)
      ),
      ne(messages.toNodeId, '!ffffffff'),
      this.withSourceScope(messages, sourceId)
    );
    const result = db.delete(messages).where(condition).run();
    return Number(result.changes);
  }

  /**
   * Cleanup old messages
   */
  async cleanupOldMessages(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { messages } = this.tables;

    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(messages)
      .where(lt(messages.timestamp, cutoff));
    await this.db.delete(messages).where(lt(messages.timestamp, cutoff));
    return deletedCount;
  }

  /**
   * Update message acknowledgement by requestId
   */
  async updateMessageAckByRequestId(requestId: number, ackFailed: boolean = false): Promise<boolean> {
    const { messages } = this.tables;
    const existing = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.requestId, requestId));

    if (existing.length === 0) return false;

    await this.db
      .update(messages)
      .set({
        ackFailed,
        deliveryState: ackFailed ? 'failed' : 'confirmed',
      })
      .where(eq(messages.requestId, requestId));
    return true;
  }

  /**
   * Update message delivery state
   */
  async updateMessageDeliveryState(requestId: number, deliveryState: 'delivered' | 'confirmed' | 'failed'): Promise<boolean> {
    const { messages } = this.tables;
    const existing = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.requestId, requestId));

    if (existing.length === 0) return false;

    await this.db
      .update(messages)
      .set({ deliveryState })
      .where(eq(messages.requestId, requestId));
    return true;
  }

  async updateMessageTimestamps(requestId: number, rxTime: number): Promise<boolean> {
    const { messages } = this.tables;
    const existing = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.requestId, requestId));

    if (existing.length === 0) return false;

    await this.db
      .update(messages)
      .set({ rxTime, timestamp: rxTime })
      .where(eq(messages.requestId, requestId));
    return true;
  }

  /**
   * Delete all messages
   */
  async deleteAllMessages(): Promise<number> {
    const { messages } = this.tables;
    const result = await this.db.select({ count: count() }).from(messages);
    const total = Number(result[0].count);
    await this.db.delete(messages);
    return total;
  }

  /**
   * Search messages with text matching, filtering, and pagination.
   * Returns matching messages and total count for pagination.
   *
   * Keeps branching: different text search functions per dialect
   * (SQLite: instr/LOWER LIKE, MySQL: BINARY LIKE/like, PostgreSQL: like/ilike).
   */
  async searchMessages(options: {
    query: string;
    caseSensitive?: boolean;
    scope?: 'all' | 'channels' | 'dms';
    channels?: number[];
    fromNodeId?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ messages: DbMessage[]; total: number }> {
    const {
      query,
      caseSensitive = false,
      scope = 'all',
      channels,
      fromNodeId,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
    } = options;

    const { messages: table } = this.tables;
    const pattern = `%${query}%`;
    const timeExpr = sql`COALESCE(${table.rxTime}, ${table.timestamp})`;

    // Build conditions array - shared across all dialects
    const conditions: SQL[] = [];

    // Text must exist
    conditions.push(isNotNull(table.text));
    conditions.push(ne(table.text, ''));

    // Text search - dialect-specific
    if (this.isSQLite()) {
      if (caseSensitive) {
        conditions.push(sql`instr(${table.text}, ${query}) > 0`);
      } else {
        conditions.push(sql`LOWER(${table.text}) LIKE LOWER(${pattern})`);
      }
    } else if (this.isMySQL()) {
      if (caseSensitive) {
        conditions.push(sql`BINARY ${table.text} LIKE ${pattern}`);
      } else {
        conditions.push(like(table.text, pattern));
      }
    } else {
      // PostgreSQL
      if (caseSensitive) {
        conditions.push(like(table.text, pattern));
      } else {
        conditions.push(ilike(table.text, pattern));
      }
    }

    // Scope filter
    if (scope === 'channels') {
      conditions.push(gte(table.channel, 0));
    } else if (scope === 'dms') {
      conditions.push(eq(table.channel, -1));
    }

    // Channel filter
    if (channels && channels.length > 0) {
      conditions.push(inArray(table.channel, channels));
    }

    // From node filter
    if (fromNodeId) {
      conditions.push(eq(table.fromNodeId, fromNodeId));
    }

    // Date range filters
    if (startDate !== undefined) {
      conditions.push(sql`${timeExpr} >= ${startDate}`);
    }
    if (endDate !== undefined) {
      conditions.push(sql`${timeExpr} <= ${endDate}`);
    }

    const whereClause = and(...conditions);

    // Get total count
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(whereClause);
    const total = Number(countResult[0]?.count ?? 0);

    // Get paginated messages
    const messages = await this.db
      .select()
      .from(table)
      .where(whereClause)
      .orderBy(desc(timeExpr))
      .limit(limit)
      .offset(offset);

    return { messages: this.normalizeBigInts(messages) as DbMessage[], total };
  }

  /**
   * Migrate messages when channels are moved between slots.
   * Runs all updates in a single transaction — rolls back entirely on any error.
   *
   * @param moves - Array of {from, to} slot pairs. Handles swaps automatically.
   * @returns {success, totalRowsAffected} or throws on failure (transaction rolled back)
   */
  async migrateMessagesForChannelMoves(moves: { from: number; to: number }[]): Promise<{ success: boolean; totalRowsAffected: number }> {
    if (moves.length === 0) return { success: true, totalRowsAffected: 0 };

    const TEMP_CHANNEL = -99;
    let totalRowsAffected = 0;

    // Detect swaps: if A→B and B→A both exist
    const swapPairs = new Set<string>();
    for (const move of moves) {
      const reverse = moves.find(m => m.from === move.to && m.to === move.from);
      if (reverse) {
        const key = [Math.min(move.from, move.to), Math.max(move.from, move.to)].join(',');
        swapPairs.add(key);
      }
    }

    // Build ordered SQL operations
    const operations: { sql: any; description: string }[] = [];

    // Process swaps first (need temp value to avoid conflicts)
    const processedSwaps = new Set<string>();
    for (const move of moves) {
      const key = [Math.min(move.from, move.to), Math.max(move.from, move.to)].join(',');
      if (swapPairs.has(key) && !processedSwaps.has(key)) {
        processedSwaps.add(key);
        const a = Math.min(move.from, move.to);
        const b = Math.max(move.from, move.to);
        operations.push(
          { sql: sql`UPDATE messages SET channel = ${TEMP_CHANNEL} WHERE channel = ${a}`, description: `swap step 1: channel ${a} → temp` },
          { sql: sql`UPDATE messages SET channel = ${a} WHERE channel = ${b}`, description: `swap step 2: channel ${b} → ${a}` },
          { sql: sql`UPDATE messages SET channel = ${b} WHERE channel = ${TEMP_CHANNEL}`, description: `swap step 3: temp → ${b}` }
        );
      }
    }

    // Process simple moves (not part of a swap)
    for (const move of moves) {
      const key = [Math.min(move.from, move.to), Math.max(move.from, move.to)].join(',');
      if (!swapPairs.has(key)) {
        operations.push(
          { sql: sql`UPDATE messages SET channel = ${move.to} WHERE channel = ${move.from}`, description: `move: channel ${move.from} → ${move.to}` }
        );
      }
    }

    // Execute all operations inside a Drizzle transaction so BEGIN/COMMIT
    // land on the same pinned pool client. The previous implementation ran
    // `executeRun(BEGIN)` through `db.execute()`, which grabs a fresh pool
    // client per call on node-postgres — BEGIN would run on client A and
    // release A back to the pool in "idle in transaction" state while
    // subsequent statements ran on different clients. That leaked a pool
    // slot per invocation (#2780).
    //
    // SQLite uses better-sqlite3 (sync). Drizzle's sqlite-core transaction
    // refuses Promise-returning callbacks, so we branch on dialect: sync
    // txn for SQLite, async for PG/MySQL.
    try {
      if (this.isSQLite()) {
        (this.db as any).transaction((tx: any) => {
          for (const op of operations) {
            const result = tx.run(op.sql);
            const rows = this.getAffectedRows(result);
            totalRowsAffected += rows;
            logger.info(`📦 Message migration: ${op.description} (${rows} rows)`);
          }
        });
      } else {
        await (this.db as any).transaction(async (tx: any) => {
          for (const op of operations) {
            const result = await tx.execute(op.sql);
            const rows = this.getAffectedRows(result);
            totalRowsAffected += rows;
            logger.info(`📦 Message migration: ${op.description} (${rows} rows)`);
          }
        });
      }
      logger.info(`📦 Message migration complete: ${moves.length} move(s), ${totalRowsAffected} total rows affected`);
      return { success: true, totalRowsAffected };
    } catch (error) {
      logger.error('📦 Message migration failed, transaction rolled back:', error);
      throw error;
    }
  }
}
