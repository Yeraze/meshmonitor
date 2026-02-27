/**
 * Messages Repository
 *
 * Handles all message-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, and, or, desc, sql } from 'drizzle-orm';
import { messagesSqlite, messagesPostgres, messagesMysql } from '../schema/messages.js';
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
   * Insert a new message (ignores duplicates)
   */
  async insertMessage(messageData: DbMessage): Promise<void> {
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
      await db
        .insert(messagesSqlite)
        .values(values)
        .onConflictDoNothing();
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(messagesMysql)
        .values(values)
        .onDuplicateKeyUpdate({ set: { id: messageData.id } }); // MySQL equivalent of onConflictDoNothing
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(messagesPostgres)
        .values(values)
        .onConflictDoNothing();
    }
  }

  /**
   * Get a message by ID
   */
  async getMessage(id: string): Promise<DbMessage | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(messagesSqlite)
        .where(eq(messagesSqlite.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbMessage;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(messagesMysql)
        .where(eq(messagesMysql.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbMessage;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(messagesPostgres)
        .where(eq(messagesPostgres.id, id))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbMessage;
    }
  }

  /**
   * Get a message by requestId
   */
  async getMessageByRequestId(requestId: number): Promise<DbMessage | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(messagesSqlite)
        .where(eq(messagesSqlite.requestId, requestId))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbMessage;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(messagesMysql)
        .where(eq(messagesMysql.requestId, requestId))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbMessage;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(messagesPostgres)
        .where(eq(messagesPostgres.requestId, requestId))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbMessage;
    }
  }

  /**
   * Get messages with pagination, ordered by rxTime/timestamp desc
   */
  async getMessages(limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const messages = await db
        .select()
        .from(messagesSqlite)
        .orderBy(desc(sql`COALESCE(${messagesSqlite.rxTime}, ${messagesSqlite.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages.map(m => this.normalizeBigInts(m) as DbMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const messages = await db
        .select()
        .from(messagesMysql)
        .orderBy(desc(sql`COALESCE(${messagesMysql.rxTime}, ${messagesMysql.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages as DbMessage[];
    } else {
      const db = this.getPostgresDb();
      const messages = await db
        .select()
        .from(messagesPostgres)
        .orderBy(desc(sql`COALESCE(${messagesPostgres.rxTime}, ${messagesPostgres.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages as DbMessage[];
    }
  }

  /**
   * Get messages by channel
   */
  async getMessagesByChannel(channel: number, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const messages = await db
        .select()
        .from(messagesSqlite)
        .where(eq(messagesSqlite.channel, channel))
        .orderBy(desc(sql`COALESCE(${messagesSqlite.rxTime}, ${messagesSqlite.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages.map(m => this.normalizeBigInts(m) as DbMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const messages = await db
        .select()
        .from(messagesMysql)
        .where(eq(messagesMysql.channel, channel))
        .orderBy(desc(sql`COALESCE(${messagesMysql.rxTime}, ${messagesMysql.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages as DbMessage[];
    } else {
      const db = this.getPostgresDb();
      const messages = await db
        .select()
        .from(messagesPostgres)
        .where(eq(messagesPostgres.channel, channel))
        .orderBy(desc(sql`COALESCE(${messagesPostgres.rxTime}, ${messagesPostgres.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages as DbMessage[];
    }
  }

  /**
   * Get direct messages between two nodes
   */
  async getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const messages = await db
        .select()
        .from(messagesSqlite)
        .where(
          and(
            eq(messagesSqlite.portnum, 1),
            eq(messagesSqlite.channel, -1),
            or(
              and(eq(messagesSqlite.fromNodeId, nodeId1), eq(messagesSqlite.toNodeId, nodeId2)),
              and(eq(messagesSqlite.fromNodeId, nodeId2), eq(messagesSqlite.toNodeId, nodeId1))
            )
          )
        )
        .orderBy(desc(sql`COALESCE(${messagesSqlite.rxTime}, ${messagesSqlite.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages.map(m => this.normalizeBigInts(m) as DbMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const messages = await db
        .select()
        .from(messagesMysql)
        .where(
          and(
            eq(messagesMysql.portnum, 1),
            eq(messagesMysql.channel, -1),
            or(
              and(eq(messagesMysql.fromNodeId, nodeId1), eq(messagesMysql.toNodeId, nodeId2)),
              and(eq(messagesMysql.fromNodeId, nodeId2), eq(messagesMysql.toNodeId, nodeId1))
            )
          )
        )
        .orderBy(desc(sql`COALESCE(${messagesMysql.rxTime}, ${messagesMysql.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages as DbMessage[];
    } else {
      const db = this.getPostgresDb();
      const messages = await db
        .select()
        .from(messagesPostgres)
        .where(
          and(
            eq(messagesPostgres.portnum, 1),
            eq(messagesPostgres.channel, -1),
            or(
              and(eq(messagesPostgres.fromNodeId, nodeId1), eq(messagesPostgres.toNodeId, nodeId2)),
              and(eq(messagesPostgres.fromNodeId, nodeId2), eq(messagesPostgres.toNodeId, nodeId1))
            )
          )
        )
        .orderBy(desc(sql`COALESCE(${messagesPostgres.rxTime}, ${messagesPostgres.timestamp})`))
        .limit(limit)
        .offset(offset);

      return messages as DbMessage[];
    }
  }

  /**
   * Get messages after a timestamp
   */
  async getMessagesAfterTimestamp(timestamp: number): Promise<DbMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const messages = await db
        .select()
        .from(messagesSqlite)
        .where(gt(messagesSqlite.timestamp, timestamp))
        .orderBy(messagesSqlite.timestamp);

      return messages.map(m => this.normalizeBigInts(m) as DbMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const messages = await db
        .select()
        .from(messagesMysql)
        .where(gt(messagesMysql.timestamp, timestamp))
        .orderBy(messagesMysql.timestamp);

      return messages as DbMessage[];
    } else {
      const db = this.getPostgresDb();
      const messages = await db
        .select()
        .from(messagesPostgres)
        .where(gt(messagesPostgres.timestamp, timestamp))
        .orderBy(messagesPostgres.timestamp);

      return messages as DbMessage[];
    }
  }

  /**
   * Get total message count
   */
  async getMessageCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(messagesSqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(messagesMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(messagesPostgres);
      return result.length;
    }
  }

  /**
   * Delete a message by ID
   */
  async deleteMessage(id: string): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(eq(messagesSqlite.id, id));

      if (existing.length === 0) return false;

      await db.delete(messagesSqlite).where(eq(messagesSqlite.id, id));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(eq(messagesMysql.id, id));

      if (existing.length === 0) return false;

      await db.delete(messagesMysql).where(eq(messagesMysql.id, id));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(eq(messagesPostgres.id, id));

      if (existing.length === 0) return false;

      await db.delete(messagesPostgres).where(eq(messagesPostgres.id, id));
      return true;
    }
  }

  /**
   * Purge all messages from a channel
   */
  async purgeChannelMessages(channel: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(eq(messagesSqlite.channel, channel));

      for (const msg of toDelete) {
        await db.delete(messagesSqlite).where(eq(messagesSqlite.id, msg.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(eq(messagesMysql.channel, channel));

      for (const msg of toDelete) {
        await db.delete(messagesMysql).where(eq(messagesMysql.id, msg.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(eq(messagesPostgres.channel, channel));

      for (const msg of toDelete) {
        await db.delete(messagesPostgres).where(eq(messagesPostgres.id, msg.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Purge direct messages to/from a node
   */
  async purgeDirectMessages(nodeNum: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(
          and(
            or(
              eq(messagesSqlite.fromNodeNum, nodeNum),
              eq(messagesSqlite.toNodeNum, nodeNum)
            ),
            sql`${messagesSqlite.toNodeId} != '!ffffffff'`
          )
        );

      for (const msg of toDelete) {
        await db.delete(messagesSqlite).where(eq(messagesSqlite.id, msg.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(
          and(
            or(
              eq(messagesMysql.fromNodeNum, nodeNum),
              eq(messagesMysql.toNodeNum, nodeNum)
            ),
            sql`${messagesMysql.toNodeId} != '!ffffffff'`
          )
        );

      for (const msg of toDelete) {
        await db.delete(messagesMysql).where(eq(messagesMysql.id, msg.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(
          and(
            or(
              eq(messagesPostgres.fromNodeNum, nodeNum),
              eq(messagesPostgres.toNodeNum, nodeNum)
            ),
            sql`${messagesPostgres.toNodeId} != '!ffffffff'`
          )
        );

      for (const msg of toDelete) {
        await db.delete(messagesPostgres).where(eq(messagesPostgres.id, msg.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Cleanup old messages
   */
  async cleanupOldMessages(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(lt(messagesSqlite.timestamp, cutoff));

      for (const msg of toDelete) {
        await db.delete(messagesSqlite).where(eq(messagesSqlite.id, msg.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(lt(messagesMysql.timestamp, cutoff));

      for (const msg of toDelete) {
        await db.delete(messagesMysql).where(eq(messagesMysql.id, msg.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(lt(messagesPostgres.timestamp, cutoff));

      for (const msg of toDelete) {
        await db.delete(messagesPostgres).where(eq(messagesPostgres.id, msg.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Update message acknowledgement by requestId
   */
  async updateMessageAckByRequestId(requestId: number, ackFailed: boolean = false): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(eq(messagesSqlite.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesSqlite)
        .set({
          ackFailed,
          deliveryState: ackFailed ? 'failed' : 'confirmed',
        })
        .where(eq(messagesSqlite.requestId, requestId));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(eq(messagesMysql.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesMysql)
        .set({
          ackFailed,
          deliveryState: ackFailed ? 'failed' : 'confirmed',
        })
        .where(eq(messagesMysql.requestId, requestId));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(eq(messagesPostgres.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesPostgres)
        .set({
          ackFailed,
          deliveryState: ackFailed ? 'failed' : 'confirmed',
        })
        .where(eq(messagesPostgres.requestId, requestId));
      return true;
    }
  }

  /**
   * Update message delivery state
   */
  async updateMessageDeliveryState(requestId: number, deliveryState: 'delivered' | 'confirmed' | 'failed'): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(eq(messagesSqlite.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesSqlite)
        .set({ deliveryState })
        .where(eq(messagesSqlite.requestId, requestId));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(eq(messagesMysql.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesMysql)
        .set({ deliveryState })
        .where(eq(messagesMysql.requestId, requestId));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(eq(messagesPostgres.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesPostgres)
        .set({ deliveryState })
        .where(eq(messagesPostgres.requestId, requestId));
      return true;
    }
  }

  async updateMessageTimestamps(requestId: number, rxTime: number): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite)
        .where(eq(messagesSqlite.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesSqlite)
        .set({ rxTime, timestamp: rxTime })
        .where(eq(messagesSqlite.requestId, requestId));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql)
        .where(eq(messagesMysql.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesMysql)
        .set({ rxTime, timestamp: rxTime })
        .where(eq(messagesMysql.requestId, requestId));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres)
        .where(eq(messagesPostgres.requestId, requestId));

      if (existing.length === 0) return false;

      await db
        .update(messagesPostgres)
        .set({ rxTime, timestamp: rxTime })
        .where(eq(messagesPostgres.requestId, requestId));
      return true;
    }
  }

  /**
   * Delete all messages
   */
  async deleteAllMessages(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const count = await db
        .select({ id: messagesSqlite.id })
        .from(messagesSqlite);
      await db.delete(messagesSqlite);
      return count.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const count = await db
        .select({ id: messagesMysql.id })
        .from(messagesMysql);
      await db.delete(messagesMysql);
      return count.length;
    } else {
      const db = this.getPostgresDb();
      const count = await db
        .select({ id: messagesPostgres.id })
        .from(messagesPostgres);
      await db.delete(messagesPostgres);
      return count.length;
    }
  }
}
