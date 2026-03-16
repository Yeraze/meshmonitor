/**
 * Messages Repository
 *
 * Handles all message-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, gte, and, or, desc, sql, like, ilike, inArray, isNotNull, ne, SQL, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbMessage } from '../types.js';

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
  async insertMessage(messageData: DbMessage): Promise<boolean> {
    const { messages } = this.tables;
    const values = {
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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .insert(messages)
        .values(values)
        .onConflictDoNothing();
      // SQLite Drizzle returns { changes: number } - 0 means conflict (no insert)
      return (result as any).changes > 0;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .insert(messages)
        .values(values)
        .onDuplicateKeyUpdate({ set: { id: messageData.id } }); // MySQL equivalent of onConflictDoNothing
      // MySQL returns affectedRows: 1 for insert, 0 for duplicate with same values
      return (result as any)[0]?.affectedRows > 0;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .insert(messages)
        .values(values)
        .onConflictDoNothing();
      // PostgreSQL returns rowCount: 0 on conflict
      return (result as any).rowCount > 0;
    }
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
  async getMessages(limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages by channel
   */
  async getMessagesByChannel(channel: number, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(eq(messages.channel, channel))
      .orderBy(desc(sql`COALESCE(${messages.rxTime}, ${messages.timestamp})`))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get direct messages between two nodes
   */
  async getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
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
          )
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
  async getMessagesAfterTimestamp(timestamp: number): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(gt(messages.timestamp, timestamp))
      .orderBy(messages.timestamp);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get total message count
   */
  async getMessageCount(): Promise<number> {
    const { messages } = this.tables;
    const result = await this.db.select({ count: count() }).from(messages);
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
   * Purge all messages from a channel
   */
  async purgeChannelMessages(channel: number): Promise<number> {
    const { messages } = this.tables;
    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(messages)
      .where(eq(messages.channel, channel));
    await this.db.delete(messages).where(eq(messages.channel, channel));
    return deletedCount;
  }

  /**
   * Purge direct messages to/from a node
   */
  async purgeDirectMessages(nodeNum: number): Promise<number> {
    const { messages } = this.tables;
    const condition = and(
      or(
        eq(messages.fromNodeNum, nodeNum),
        eq(messages.toNodeNum, nodeNum)
      ),
      sql`${messages.toNodeId} != '!ffffffff'`
    );
    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(messages)
      .where(condition);
    await this.db.delete(messages).where(condition);
    return deletedCount;
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
}
