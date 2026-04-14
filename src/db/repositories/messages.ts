/**
 * Messages Repository
 *
 * Handles all message-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, gte, and, or, desc, sql, like, ilike, inArray, isNotNull, ne, SQL, count } from 'drizzle-orm';
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
   * Get messages with pagination, ordered by rxTime/timestamp desc
   */
  async getMessages(limit: number = 100, offset: number = 0, sourceId?: string): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(this.withSourceScope(messages, sourceId))
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

    // Execute all operations in a transaction
    try {
      await this.executeRun(sql`BEGIN`);

      for (const op of operations) {
        const result = await this.executeRun(op.sql);
        const rows = this.getAffectedRows(result);
        totalRowsAffected += rows;
        logger.info(`📦 Message migration: ${op.description} (${rows} rows)`);
      }

      await this.executeRun(sql`COMMIT`);
      logger.info(`📦 Message migration complete: ${moves.length} move(s), ${totalRowsAffected} total rows affected`);
      return { success: true, totalRowsAffected };
    } catch (error) {
      logger.error('📦 Message migration failed, rolling back:', error);
      try {
        await this.executeRun(sql`ROLLBACK`);
      } catch (rollbackError) {
        logger.error('📦 Rollback also failed:', rollbackError);
      }
      throw error;
    }
  }
}
