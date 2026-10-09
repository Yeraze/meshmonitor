/**
 * Messages Repository
 *
 * Handles all message-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, gte, and, or, desc, sql, inArray, isNotNull, isNull, ne, notInArray, SQL, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope, ALL_SOURCES } from './base.js';
import { TranslationsRepository } from './translations.js';
import { DatabaseType, DbMessage } from '../types.js';
import { logger } from '../../utils/logger.js';
import { PortNum } from '../../server/constants/meshtastic.js';
import { classifyMessageTransport, type NodeTransportClass } from '../../utils/nodeTransport.js';

/**
 * Chat-like portnums that render in the DM thread view (#3691). Telemetry,
 * traceroute, and other non-chat DM rows stay excluded. ATAK GeoChat DMs
 * (PortNum.ATAK_PLUGIN, 72) are persisted by processTakPacket with
 * channel = -1 and must surface alongside plain text messages. ATAK V2
 * GeoChat DMs (PortNum.ATAK_PLUGIN_V2, 78, #4317) follow the same path via
 * processTakV2Packet.
 */
const DM_CHAT_PORTNUMS = [PortNum.TEXT_MESSAGE_APP, PortNum.ATAK_PLUGIN, PortNum.ATAK_PLUGIN_V2];

/**
 * Floor below which `rxTime` is not a real receive time (2020-01-01, ms).
 * Same value as `MIN_PLAUSIBLE_RXTIME_MS` in `server/utils/messageTime.ts`.
 */
const MIN_PLAUSIBLE_RXTIME_MS = 1_577_836_800_000;

/** Channels a caller may read on one source: an explicit list, or every channel. */
export type MessageChannelScope = number[] | 'all';

/** One source plus the channels on it a caller may read (#5517). */
export interface MessageSourceScope {
  sourceId: string;
  channels: MessageChannelScope;
}

/**
 * Repository for message operations
 */
export class MessagesRepository extends BaseRepository {
  private translationsRepo: TranslationsRepository | null = null;

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private getTranslationsRepo(): TranslationsRepository {
    if (!this.translationsRepo) this.translationsRepo = new TranslationsRepository(this.db, this.dbType);
    return this.translationsRepo;
  }

  /**
   * Drop `message_translations` links whose message was just deleted (#5520)
   * and recount the cache's `messageRefCount`. Called at the end of every
   * delete path below. Best-effort: a failure is logged, never thrown — the
   * hourly translation-cache prune sweeps the same orphans again, and the
   * stored-translation read path only serves links whose message still
   * exists, so a missed sweep can never leak a deleted message's translation.
   */
  private async sweepTranslationLinks(scope: SourceScope | undefined): Promise<void> {
    try {
      await this.getTranslationsRepo().removeOrphanedLinks(scope || ALL_SOURCES);
    } catch (err) {
      logger.warn('Failed to sweep message translation links after message delete:', err);
    }
  }

  /** Synchronous SQLite twin of `sweepTranslationLinks` for the sync facade. */
  private sweepTranslationLinksSqliteSync(scope: SourceScope | undefined): void {
    try {
      this.getTranslationsRepo().removeOrphanedLinksSqliteSync(scope || ALL_SOURCES);
    } catch (err) {
      logger.warn('Failed to sweep message translation links after message delete:', err);
    }
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
      xeddsaSigned: messageData.xeddsaSigned ?? null,
      ackProofStatus: messageData.ackProofStatus ?? null,
      rxSnr: messageData.rxSnr ?? null,
      rxRssi: messageData.rxRssi ?? null,
      ackFailed: messageData.ackFailed ?? null,
      routingErrorReceived: messageData.routingErrorReceived ?? null,
      deliveryState: messageData.deliveryState ?? null,
      wantAck: messageData.wantAck ?? null,
      ackFromNode: messageData.ackFromNode ?? null,
      routingErrorCode: messageData.routingErrorCode ?? null,
      createdAt: messageData.createdAt,
      decryptedBy: messageData.decryptedBy ?? null,
      sourceIp: messageData.sourceIp ?? null,
      sourcePath: messageData.sourcePath ?? null,
    };
    // Only write the spoof flag when set, so the column is referenced only for
    // suspect messages (avoids touching the many hardcoded test fixtures). (#2584)
    if (messageData.spoofSuspected) {
      values.spoofSuspected = true;
    }
    // #5101: only when known, like spoofSuspected above — keeps hand-built
    // test fixtures without the column working. `!= null` keeps an explicit 0
    // (TransportMechanism.INTERNAL, outbound sends).
    if (messageData.transportMechanism != null) {
      values.transportMechanism = messageData.transportMechanism;
    }
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
   * Fetch messages by id, scoped to ONE source (#5520). Ids that don't exist
   * on that source are simply absent from the result. The caller applies
   * channel / DM visibility (`resolveMessageReadAccess`).
   */
  async getMessagesByIdsInSource(sourceId: string, ids: string[]): Promise<DbMessage[]> {
    if (ids.length === 0) return [];
    const { messages } = this.tables;
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, ids), this.withSourceScope(messages, sourceId)));
    return (rows as DbMessage[]).map((r) => this.normalizeBigInts(r) as DbMessage);
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
   * Get messages with pagination, ordered by server DB arrival time (createdAt) desc.
   *
   * Uses `createdAt` instead of device-reported `rxTime`/`timestamp` so future-skewed
   * device clocks cannot pin old messages at the top of channel chat (issue #3122).
   *
   * `excludePortnums` drops rows whose portnum matches any in the list. NULL
   * portnums are always retained (legacy rows predate the column). UI feeds
   * pass `[PortNum.TRACEROUTE_APP]` so traceroute rows don't consume the
   * fixed-size window the client filters down to text messages (issue #2741).
   */
  async getMessages(
    limit: number = 100,
    offset: number = 0,
    sourceId?: SourceScope,
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
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages by channel, ordered by server DB arrival time (issue #3122).
   */
  async getMessagesByChannel(channel: number, limit: number = 100, offset: number = 0, sourceId?: SourceScope): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channel, channel), this.withSourceScope(messages, sourceId)))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages in a channel strictly before a cursor (cursor-based pagination).
   *
   * Cursor is server DB arrival time (createdAt) so the chat scroll-back order is
   * stable even when device clocks are skewed (issue #3122).
   *
   * @param channel    Channel number to filter on
   * @param before     Exclusive upper-bound for createdAt in ms.
   *                   If undefined, no upper bound is applied (returns newest `limit` rows).
   * @param limit      Max rows to return
   * @param sourceId   Optional source scope
   */
  async getMessagesBeforeInChannel(
    channel: number,
    before: number | undefined,
    limit: number = 100,
    sourceId?: SourceScope
  ): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const conditions: (SQL | undefined)[] = [
      eq(messages.channel, channel),
      this.withSourceScope(messages, sourceId),
    ];
    if (before !== undefined) {
      conditions.push(sql`${messages.createdAt} < ${before}`);
    }
    const result = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get direct messages between two nodes, ordered by server DB arrival time (issue #3122).
   */
  async getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100, offset: number = 0, sourceId?: SourceScope): Promise<DbMessage[]> {
    const { messages } = this.tables;
    const result = await this.db
      .select()
      .from(messages)
      .where(
        and(
          inArray(messages.portnum, DM_CHAT_PORTNUMS),
          eq(messages.channel, -1),
          or(
            and(eq(messages.fromNodeId, nodeId1), eq(messages.toNodeId, nodeId2)),
            and(eq(messages.fromNodeId, nodeId2), eq(messages.toNodeId, nodeId1))
          ),
          this.withSourceScope(messages, sourceId)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .offset(offset);

    return this.normalizeBigInts(result) as DbMessage[];
  }

  /**
   * Get messages after a timestamp
   */
  async getMessagesAfterTimestamp(timestamp: number, sourceId?: SourceScope): Promise<DbMessage[]> {
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
  async getMessageCount(sourceId: SourceScope): Promise<number> {
    const { messages } = this.tables;
    const result = await this.db.select({ count: count() }).from(messages)
      .where(this.withSourceScope(messages, sourceId));
    return Number(result[0].count);
  }

  /**
   * Rows on one source and channel whose `replyId` is `replyId` — the
   * candidates for "a tapback on, or a reply to, that packet".
   *
   * This only SELECTS candidates. Whether a row really answers a given message
   * is decided by the shared predicates in `src/utils/messageReplies.ts` (the
   * same ones the message views render with), which the caller applies to
   * these rows. Keyed on the packet id, never on time, so clock changes do not
   * matter. `limit` bounds a pathological thread.
   */
  async getReplyCandidates(
    sourceId: string,
    replyId: number,
    channel: number,
    limit: number = 200,
  ): Promise<Array<{ id: string; fromNodeNum: number; text: string | null; emoji: number | null; replyId: number | null }>> {
    const { messages } = this.tables;
    const rows = await this.db
      .select({
        id: messages.id,
        fromNodeNum: messages.fromNodeNum,
        text: messages.text,
        emoji: messages.emoji,
        replyId: messages.replyId,
      })
      .from(messages)
      .where(and(
        eq(messages.replyId, replyId),
        eq(messages.channel, channel),
        this.withSourceScope(messages, sourceId),
      ))
      .limit(limit);
    return (rows as Array<{ id: unknown; fromNodeNum: unknown; text: string | null; emoji: unknown; replyId: unknown }>).map((r) => ({
      id: String(r.id),
      fromNodeNum: Number(r.fromNodeNum),
      text: r.text ?? null,
      emoji: r.emoji == null ? null : Number(r.emoji),
      replyId: r.replyId == null ? null : Number(r.replyId),
    }));
  }

  /**
   * Count messages whose server arrival time (`createdAt`, milliseconds)
   * falls within the last `sinceMs` milliseconds.
   *
   * Filters on `createdAt` — not the device-reported `timestamp` — so a node
   * with a skewed/future RTC cannot inflate or hide the count (the same reason
   * getMessagesAfterTimestamp and the chat scroll-back key off `createdAt`).
   *
   * Powers the message-rate gauge on the v1 metrics endpoint, which only
   * needs the number — going through getMessagesAfterTimestamp and taking
   * `.length` would haul every matching row's text through the ORM on each
   * scrape.
   */
  async getMessageCountSince(sourceId: SourceScope, sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    const { messages } = this.tables;
    const result = await this.db.select({ count: count() }).from(messages)
      .where(and(gt(messages.createdAt, cutoff), this.withSourceScope(messages, sourceId)));
    return Number(result[0].count);
  }

  /**
   * Message counts for one source, grouped by channel and transport class
   * (#5101). The channel axis lets the route drop channels the caller cannot
   * read. Groups by the RAW `(viaMqtt, transportMechanism)` pair in SQL
   * (dialect boolean handling stays where Phase 1 put it) and classifies each
   * group in TypeScript with `classifyMessageTransport` — deliberately NOT
   * `classifyNodeTransport`, see that function's doc: here `viaMqtt` wins.
   * Groups that land in the same `(channel, class)` bucket after
   * classification are merged. Excludes `excludePortnums` the same way
   * getMessages does (NULL portnum kept).
   */
  async getMessageCountsByChannelAndTransport(
    sourceId: string,
    excludePortnums: number[] = [],
  ): Promise<Array<{ channel: number; transportClass: NodeTransportClass; count: number }>> {
    const { messages } = this.tables;
    const whereClause = and(
      this.withSourceScope(messages, sourceId),
      excludePortnums.length > 0
        ? or(isNull(messages.portnum), notInArray(messages.portnum, excludePortnums))
        : undefined,
    );
    const rows = await this.db
      .select({
        channel: messages.channel,
        viaMqtt: messages.viaMqtt,
        transportMechanism: messages.transportMechanism,
        count: count(),
      })
      .from(messages)
      .where(whereClause)
      .groupBy(messages.channel, messages.viaMqtt, messages.transportMechanism);

    const merged = new Map<string, { channel: number; transportClass: NodeTransportClass; count: number }>();
    for (const r of rows as Array<{
      channel: number | string | bigint;
      viaMqtt: boolean | number | null;
      transportMechanism: number | string | bigint | null;
      count: number | string | bigint;
    }>) {
      const channel = Number(r.channel);
      const transportClass = classifyMessageTransport({
        transportMechanism: r.transportMechanism == null ? null : Number(r.transportMechanism),
        // PG returns boolean true/false, MySQL/SQLite return 1/0, NULL
        // (pre-flag rows) reads as false.
        viaMqtt: Number(r.viaMqtt) === 1,
      });
      const key = `${channel}:${transportClass}`;
      const existing = merged.get(key);
      const rowCount = Number(r.count);
      if (existing) {
        existing.count += rowCount;
      } else {
        merged.set(key, { channel, transportClass, count: rowCount });
      }
    }
    return Array.from(merged.values());
  }

  /**
   * Get the distinct `channel` numbers that have messages for a source, with a
   * per-channel message count and the most recent message timestamp. Used by
   * the Channels tab to enumerate the channel_database-backed virtual channels
   * (`CHANNEL_DB_OFFSET + id`) that actually carry traffic for MQTT sources,
   * which otherwise have no rows in the per-source `channels` table.
   *
   * Ordered most-active first (highest count), then by channel number.
   */
  async getDistinctChannelsForSource(
    sourceId: string,
  ): Promise<Array<{ channel: number; messageCount: number; lastTimestamp: number | null }>> {
    const { messages } = this.tables;
    const rows = await this.db
      .select({
        channel: messages.channel,
        messageCount: count(),
        lastTimestamp: sql<number | null>`MAX(${messages.timestamp})`,
      })
      .from(messages)
      .where(this.withSourceScope(messages, sourceId))
      .groupBy(messages.channel);

    return rows
      .map((r: any) => ({
        channel: Number(r.channel),
        messageCount: Number(r.messageCount),
        lastTimestamp: r.lastTimestamp != null ? Number(r.lastTimestamp) : null,
      }))
      .filter((r: { channel: number }) => Number.isFinite(r.channel))
      .sort((a: { messageCount: number; channel: number }, b: { messageCount: number; channel: number }) =>
        b.messageCount - a.messageCount || a.channel - b.channel,
      );
  }

  /**
   * Delete a message by ID
   */
  async deleteMessage(id: string): Promise<boolean> {
    const { messages } = this.tables;
    const existing = await this.db
      .select({ id: messages.id, sourceId: messages.sourceId })
      .from(messages)
      .where(eq(messages.id, id));

    if (existing.length === 0) return false;

    await this.db.delete(messages).where(eq(messages.id, id));
    await this.sweepTranslationLinks(existing[0].sourceId || ALL_SOURCES);
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
    await this.sweepTranslationLinks(sourceId);
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
    await this.sweepTranslationLinks(sourceId);
    return deletedCount;
  }

  /**
   * Purge all messages ORIGINATED by a node (fromNodeNum == node), including
   * channel broadcasts that purgeDirectMessages excludes. Scoped by source.
   */
  async purgeMessagesFromNode(nodeNum: number, sourceId?: string): Promise<number> {
    const { messages } = this.tables;
    const condition = and(eq(messages.fromNodeNum, nodeNum), this.withSourceScope(messages, sourceId));
    const [{ deletedCount }] = await this.db
      .select({ deletedCount: count() })
      .from(messages)
      .where(condition);
    await this.db.delete(messages).where(condition);
    await this.sweepTranslationLinks(sourceId);
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
      xeddsaSigned: messageData.xeddsaSigned ?? null,
      ackProofStatus: messageData.ackProofStatus ?? null,
      rxSnr: messageData.rxSnr ?? null,
      rxRssi: messageData.rxRssi ?? null,
      ackFailed: (messageData as any).ackFailed ?? null,
      routingErrorReceived: (messageData as any).routingErrorReceived ?? null,
      deliveryState: (messageData as any).deliveryState ?? null,
      wantAck: (messageData as any).wantAck ?? null,
      ackFromNode: (messageData as any).ackFromNode ?? null,
      routingErrorCode: messageData.routingErrorCode ?? null,
      createdAt: messageData.createdAt,
      decryptedBy: (messageData as any).decryptedBy ?? null,
      sourceIp: (messageData as any).sourceIp ?? null,
      sourcePath: (messageData as any).sourcePath ?? null,
    };
    if ((messageData as any).spoofSuspected) {
      values.spoofSuspected = true;
    }
    // #5101: see insertMessage() above for the "only when known" rule.
    if (messageData.transportMechanism != null) {
      values.transportMechanism = messageData.transportMechanism;
    }
    if (sourceId) {
      values.sourceId = sourceId;
    }
    const result: any = db.insert(messages).values(values).onConflictDoNothing().run();
    return Number(result?.changes ?? 0) > 0;
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
    this.sweepTranslationLinksSqliteSync(sourceId);
    return Number(result.changes);
  }


  /**
   * SQLite-only synchronous wipe of all messages, optionally scoped to a source.
   * Mirrors `deleteAllMessages()` for the sync DatabaseService facade.
   */
  deleteAllMessagesSqlite(sourceId?: SourceScope): number {
    if (!this.sqliteDb) {
      throw new Error('deleteAllMessagesSqlite is SQLite-only');
    }
    const db = this.sqliteDb;
    const messages = this.tables.messages;
    const isScoped = typeof sourceId === 'string' && sourceId !== '';
    const result = isScoped
      ? db.delete(messages).where(eq(messages.sourceId, sourceId as string)).run()
      : db.delete(messages).run();
    this.sweepTranslationLinksSqliteSync(isScoped ? sourceId : ALL_SOURCES);
    return Number(result.changes);
  }




  /**
   * Aggregate message count by day for the last `days` days.
   * Optionally scope to a single source. Returns an array of
   * { date: 'YYYY-MM-DD', count } rows in ascending date order.
   *
   * Keeps branching: per-dialect date formatting.
   */
  async getMessagesByDay(days: number = 7, sourceId: SourceScope): Promise<Array<{ date: string; count: number }>> {
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
    await this.sweepTranslationLinks(sourceId);
    return Number(c);
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
    await this.sweepTranslationLinks(ALL_SOURCES);
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
   * Update message delivery state.
   *
   * `routingErrorCode` (#4816 Phase 2) is optional and defaults to being
   * omitted from the update set entirely — the failed-routing call site is
   * the only one that passes a concrete numeric RoutingError reason, so the
   * column stays NULL (or whatever it already was) rather than being
   * clobbered on the other states.
   *
   * `ackMeta` (#4851) carries fields read directly off the ACK packet itself
   * — who sent it, and the signal it was received with — for the Delivery
   * Details popup's Identity/Signal sections. Only the destination-ACK
   * ('confirmed') call site has a genuine over-the-air packet to read these
   * from, so every other call site omits it and the columns stay untouched,
   * same NULL-preserving contract as `routingErrorCode` above.
   */
  async updateMessageDeliveryState(
    requestId: number,
    deliveryState: 'delivered' | 'confirmed' | 'failed',
    routingErrorCode?: number | null,
    ackMeta?: {
      ackFromNode?: number | null;
      relayNode?: number | null;
      rxSnr?: number | null;
      rxRssi?: number | null;
      /** #5279 MeshPacket.AckProofStatus number; undefined leaves the column untouched. */
      ackProofStatus?: number | null;
    },
  ): Promise<boolean> {
    const { messages } = this.tables;
    const existing = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.requestId, requestId));

    if (existing.length === 0) return false;

    const updateSet: {
      deliveryState: string;
      routingErrorCode?: number | null;
      ackFromNode?: number | null;
      relayNode?: number | null;
      rxSnr?: number | null;
      rxRssi?: number | null;
      ackProofStatus?: number | null;
    } = { deliveryState };
    if (routingErrorCode !== undefined) {
      updateSet.routingErrorCode = routingErrorCode;
    }
    if (ackMeta?.ackFromNode !== undefined) updateSet.ackFromNode = ackMeta.ackFromNode;
    if (ackMeta?.relayNode !== undefined) updateSet.relayNode = ackMeta.relayNode;
    if (ackMeta?.rxSnr !== undefined) updateSet.rxSnr = ackMeta.rxSnr;
    if (ackMeta?.rxRssi !== undefined) updateSet.rxRssi = ackMeta.rxRssi;
    if (ackMeta?.ackProofStatus !== undefined) updateSet.ackProofStatus = ackMeta.ackProofStatus;

    await this.db
      .update(messages)
      .set(updateSet)
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
   * Delete all messages, optionally scoped to a single source.
   */
  async deleteAllMessages(sourceId?: SourceScope): Promise<number> {
    const { messages } = this.tables;
    // ALL_SOURCES or undefined → global delete (no WHERE); a string → scoped delete.
    const isScoped = typeof sourceId === 'string' && sourceId !== '';
    const countQuery = this.db.select({ count: count() }).from(messages);
    const result = await (isScoped
      ? countQuery.where(eq(messages.sourceId, sourceId as string))
      : countQuery);
    const total = Number(result[0].count);
    if (isScoped) {
      await this.db.delete(messages).where(eq(messages.sourceId, sourceId as string));
    } else {
      await this.db.delete(messages);
    }
    await this.sweepTranslationLinks(isScoped ? sourceId : ALL_SOURCES);
    return total;
  }

  /**
   * Canonical time of a message row, in ms: the device receive time when it is
   * plausible, else the server timestamp. Mirrors `canonicalMessageTime`
   * (`server/utils/messageTime.ts`) so a filter on this expression agrees with
   * the time the UI shows. A raw `COALESCE(rxTime, timestamp)` would sort an
   * MQTT row with `rxTime = 0` into 1970.
   */
  private canonicalTimeExpr(): SQL {
    const { messages: table } = this.tables;
    return sql`CASE WHEN ${table.rxTime} > ${sql.raw(String(MIN_PLAUSIBLE_RXTIME_MS))} THEN ${table.rxTime} ELSE ${table.timestamp} END`;
  }

  /**
   * WHERE fragment for a list of per-source channel scopes, or `null` when no
   * scope can match anything. Callers MUST treat `null` as "zero rows" — never
   * as "no filter" (#5517).
   */
  private sourceScopesCondition(scopes: MessageSourceScope[]): SQL | null {
    const { messages: table } = this.tables;
    const parts: SQL[] = [];
    for (const scope of scopes) {
      if (!scope.sourceId) continue;
      if (scope.channels === 'all') {
        parts.push(eq(table.sourceId, scope.sourceId));
      } else if (scope.channels.length > 0) {
        parts.push(and(eq(table.sourceId, scope.sourceId), inArray(table.channel, scope.channels)) as SQL);
      }
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : (or(...parts) as SQL);
  }

  /**
   * Search messages with text matching, filtering, and pagination.
   * Returns matching messages and total count for pagination.
   *
   * `scopes` limits the search to the given sources and, per source, to the
   * channels the caller may read. When `scopes` is given and empty (or every
   * entry has an empty channel list) the result is empty — the query never
   * falls back to an unscoped search (#5517). `sourceId` alone is the simpler
   * form used by the v1 API: one source, channel list taken from `channels`.
   *
   * Dates are epoch milliseconds, compared against the canonical message time.
   */
  async searchMessages(options: {
    query: string;
    caseSensitive?: boolean;
    scope?: 'all' | 'channels' | 'dms';
    channels?: number[];
    scopes?: MessageSourceScope[];
    sourceId?: string;
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
      scopes,
      sourceId,
      fromNodeId,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
    } = options;

    const { messages: table } = this.tables;
    const timeExpr = this.canonicalTimeExpr();

    const conditions: SQL[] = [];

    if (scopes !== undefined) {
      const scoped = this.sourceScopesCondition(scopes);
      if (!scoped) return { messages: [], total: 0 };
      conditions.push(scoped);
    }
    if (sourceId) {
      conditions.push(eq(table.sourceId, sourceId));
    }

    // Text must exist
    conditions.push(isNotNull(table.text));
    conditions.push(ne(table.text, ''));
    conditions.push(this.textContains(table.text, query, caseSensitive));

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

    // Date range filters (ms)
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
      .orderBy(desc(timeExpr), desc(table.id))
      .limit(limit)
      .offset(offset);

    return { messages: this.normalizeBigInts(messages) as DbMessage[], total };
  }

  /**
   * One page of a filtered message export for ONE source (#5517).
   *
   * Ordered oldest-first by canonical time then id, and paged by keyset
   * (`after`) rather than OFFSET, so a 100k-row export does not rescan the
   * rows it already sent. `channels` is the set the caller may read on this
   * source; an empty list returns no rows.
   *
   * Filters:
   * - `includeTerms`: keep rows whose text contains ANY term (case-insensitive).
   * - `excludeTerms`: drop rows whose text contains any term.
   * - `startMs` / `endMs`: inclusive range on the canonical time.
   * - `type`: channel traffic only, DMs only, or both.
   * - `fromNodeId`: one sender, matched case-insensitively.
   * - Traceroute rows are always excluded (as in the unified feed); reactions
   *   (emoji > 0) unless `includeReactions`.
   */
  async getMessagesForExport(options: {
    sourceId: string;
    channels: MessageChannelScope;
    includeTerms?: string[];
    excludeTerms?: string[];
    startMs?: number;
    endMs?: number;
    type?: 'all' | 'channels' | 'dms';
    fromNodeId?: string;
    includeReactions?: boolean;
    after?: { time: number; id: string };
    limit?: number;
  }): Promise<DbMessage[]> {
    const { messages: table } = this.tables;
    const {
      sourceId,
      channels,
      includeTerms = [],
      excludeTerms = [],
      startMs,
      endMs,
      type = 'all',
      fromNodeId,
      includeReactions = false,
      after,
    } = options;
    if (!sourceId) throw new Error('getMessagesForExport requires a sourceId');
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 5000));

    const scoped = this.sourceScopesCondition([{ sourceId, channels }]);
    if (!scoped) return [];

    const timeExpr = this.canonicalTimeExpr();
    const conditions: SQL[] = [scoped, isNotNull(table.text), ne(table.text, '')];

    conditions.push(or(isNull(table.portnum), notInArray(table.portnum, [PortNum.TRACEROUTE_APP])) as SQL);
    if (!includeReactions) {
      conditions.push(or(isNull(table.emoji), eq(table.emoji, 0)) as SQL);
    }
    if (type === 'channels') {
      conditions.push(gte(table.channel, 0));
    } else if (type === 'dms') {
      conditions.push(eq(table.channel, -1));
    }

    const include = includeTerms.map((t) => t.trim()).filter(Boolean);
    if (include.length > 0) {
      const matches = include.map((t) => this.textContains(table.text, t));
      conditions.push(matches.length === 1 ? matches[0] : (or(...matches) as SQL));
    }
    for (const term of excludeTerms.map((t) => t.trim()).filter(Boolean)) {
      conditions.push(sql`NOT (${this.textContains(table.text, term)})`);
    }

    if (fromNodeId) {
      conditions.push(sql`LOWER(${table.fromNodeId}) = ${fromNodeId.toLowerCase()}`);
    }
    if (startMs !== undefined) conditions.push(sql`${timeExpr} >= ${startMs}`);
    if (endMs !== undefined) conditions.push(sql`${timeExpr} <= ${endMs}`);
    if (after) {
      conditions.push(sql`(${timeExpr} > ${after.time} OR (${timeExpr} = ${after.time} AND ${table.id} > ${after.id}))`);
    }

    const rows = await this.db
      .select()
      .from(table)
      .where(and(...conditions))
      .orderBy(timeExpr, table.id)
      .limit(limit);
    return this.normalizeBigInts(rows) as DbMessage[];
  }

  /**
   * Migrate messages when channels are moved between slots.
   * Runs all updates in a single transaction — rolls back entirely on any error.
   *
   * @param moves - Array of {from, to} slot pairs. Handles swaps automatically.
   * @returns {success, totalRowsAffected} or throws on failure (transaction rolled back)
   */
  async migrateMessagesForChannelMoves(
    moves: { from: number; to: number }[],
    sourceId?: string,
  ): Promise<{ success: boolean; totalRowsAffected: number }> {
    if (moves.length === 0) return { success: true, totalRowsAffected: 0 };

    const TEMP_CHANNEL = -99;
    let totalRowsAffected = 0;

    // Source scope (#3712): without this, a channel move detected on one source
    // rewrites the `channel` column for EVERY source's messages that happen to
    // sit in the same slot, corrupting message-channel assignment across
    // sources. The column is `sourceId` in all three dialects (quoted for PG).
    const scope = sourceId
      ? (this.isPostgres()
          ? sql` AND ${sql.raw('"sourceId"')} = ${sourceId}`
          : sql` AND sourceId = ${sourceId}`)
      : sql``;

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
          { sql: sql`UPDATE messages SET channel = ${TEMP_CHANNEL} WHERE channel = ${a}${scope}`, description: `swap step 1: channel ${a} → temp` },
          { sql: sql`UPDATE messages SET channel = ${a} WHERE channel = ${b}${scope}`, description: `swap step 2: channel ${b} → ${a}` },
          { sql: sql`UPDATE messages SET channel = ${b} WHERE channel = ${TEMP_CHANNEL}${scope}`, description: `swap step 3: temp → ${b}` }
        );
      }
    }

    // Process simple moves (not part of a swap)
    for (const move of moves) {
      const key = [Math.min(move.from, move.to), Math.max(move.from, move.to)].join(',');
      if (!swapPairs.has(key)) {
        operations.push(
          { sql: sql`UPDATE messages SET channel = ${move.to} WHERE channel = ${move.from}${scope}`, description: `move: channel ${move.from} → ${move.to}` }
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
