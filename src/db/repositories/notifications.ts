/**
 * Notifications Repository
 *
 * Handles all notification-related database operations including:
 * - Push subscriptions (CRUD)
 * - User notification preferences (CRUD)
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, sql, and, or, lte, isNull, ne } from 'drizzle-orm';
import {
  readMessagesSqlite,
} from '../schema/notifications.js';
import {
  messagesSqlite,
} from '../schema/messages.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbPushSubscription } from '../types.js';
import { logger } from '../../utils/logger.js';

// Re-export for convenience
export type { DbPushSubscription } from '../types.js';

/** A single channel mute rule. muteUntil is Unix ms; null = indefinite. */
export interface MutedChannel {
  channelId: number;
  muteUntil: number | null;
}

/** A single DM mute rule. muteUntil is Unix ms; null = indefinite. */
export interface MutedDM {
  nodeUuid: string;
  muteUntil: number | null;
}

/**
 * Notification preferences data structure (database-agnostic)
 */
export interface NotificationPreferences {
  enableWebPush: boolean;
  enableApprise: boolean;
  enabledChannels: number[];
  enableDirectMessages: boolean;
  notifyOnEmoji: boolean;
  notifyOnMqtt: boolean;
  notifyOnNewNode: boolean;
  notifyOnTraceroute: boolean;
  notifyOnInactiveNode: boolean;
  notifyOnServerEvents: boolean;
  prefixWithNodeName: boolean;
  monitoredNodes: string[];
  whitelist: string[];
  blacklist: string[];
  appriseUrls: string[];
  mutedChannels: MutedChannel[];
  mutedDMs: MutedDM[];
}

/**
 * Input for creating/updating push subscriptions
 */
export interface PushSubscriptionInput {
  userId?: number | null;
  /** Phase D: required — which source this subscription belongs to */
  sourceId: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent?: string | null;
}

/**
 * Repository for notification operations
 */
export class NotificationsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ PUSH SUBSCRIPTIONS ============

  /**
   * Get all push subscriptions
   */
  async getAllSubscriptions(sourceId?: string): Promise<DbPushSubscription[]> {
    // Phase D: sourceId required at route layer; legacy callers may pass undefined to get all
    try {
      const { pushSubscriptions } = this.tables;
      const rows = sourceId
        ? await this.db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.sourceId, sourceId))
            .orderBy(desc(pushSubscriptions.createdAt))
        : await this.db
            .select()
            .from(pushSubscriptions)
            .orderBy(desc(pushSubscriptions.createdAt));
      return rows.map((row: any) => this.mapSubscriptionRow(row));
    } catch (error) {
      logger.error('Failed to get all subscriptions:', error);
      return [];
    }
  }

  /**
   * Get push subscriptions for a specific user
   */
  async getUserSubscriptions(userId: number | null | undefined, sourceId?: string): Promise<DbPushSubscription[]> {
    try {
      const { pushSubscriptions } = this.tables;
      const filters = [] as any[];
      if (userId) filters.push(eq(pushSubscriptions.userId, userId));
      if (sourceId) filters.push(eq(pushSubscriptions.sourceId, sourceId));
      const rows = filters.length > 0
        ? await this.db
            .select()
            .from(pushSubscriptions)
            .where(and(...filters))
            .orderBy(desc(pushSubscriptions.createdAt))
        : await this.db
            .select()
            .from(pushSubscriptions)
            .orderBy(desc(pushSubscriptions.createdAt));
      return rows.map((row: any) => this.mapSubscriptionRow(row));
    } catch (error) {
      logger.error('Failed to get user subscriptions:', error);
      return [];
    }
  }

  /**
   * Save a push subscription (insert or update by endpoint).
   * Keeps branching: MySQL uses onDuplicateKeyUpdate vs onConflictDoUpdate.
   */
  async saveSubscription(input: PushSubscriptionInput): Promise<void> {
    const now = this.now();
    const { pushSubscriptions } = this.tables;
    if (!input.sourceId) {
      throw new Error('saveSubscription requires sourceId');
    }
    const sourceId = input.sourceId;
    const values = {
      userId: input.userId ?? null,
      sourceId,
      endpoint: input.endpoint,
      p256dhKey: input.p256dhKey,
      authKey: input.authKey,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    const setData = {
      userId: input.userId ?? null,
      sourceId,
      p256dhKey: input.p256dhKey,
      authKey: input.authKey,
      userAgent: input.userAgent ?? null,
      updatedAt: now,
      lastUsedAt: now,
    };

    await this.upsert(pushSubscriptions, values, [pushSubscriptions.userId, pushSubscriptions.endpoint, pushSubscriptions.sourceId], setData);
  }

  /**
   * Remove a push subscription by endpoint
   */
  async removeSubscription(endpoint: string): Promise<void> {
    const { pushSubscriptions } = this.tables;
    await this.db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }

  /**
   * Update the last_used_at timestamp for a subscription
   */
  async updateSubscriptionLastUsed(endpoint: string): Promise<void> {
    const now = this.now();
    const { pushSubscriptions } = this.tables;
    await this.db
      .update(pushSubscriptions)
      .set({ lastUsedAt: now })
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }

  // ============ USER NOTIFICATION PREFERENCES ============

  /**
   * Get notification preferences for a user
   */
  async getUserPreferences(userId: number, sourceId?: string): Promise<NotificationPreferences | null> {
    if (!Number.isInteger(userId) || userId <= 0) {
      logger.error(`Invalid userId: ${userId}`);
      return null;
    }

    try {
      const { userNotificationPreferences } = this.tables;
      const whereClause = sourceId
        ? and(
            eq(userNotificationPreferences.userId, userId),
            eq(userNotificationPreferences.sourceId, sourceId)
          )
        : eq(userNotificationPreferences.userId, userId);
      const rows = await this.db
        .select()
        .from(userNotificationPreferences)
        .where(whereClause)
        .limit(1);

      if (rows.length === 0) {
        return null;
      }

      return this.mapPreferencesRow(rows[0]);
    } catch (error) {
      logger.error(`Failed to get preferences for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Save notification preferences for a user (insert or update).
   * Keeps branching: MySQL uses onDuplicateKeyUpdate, SQLite lacks notifyOnChannelMessage column.
   */
  async saveUserPreferences(userId: number, prefs: NotificationPreferences, sourceId?: string): Promise<boolean> {
    if (!Number.isInteger(userId) || userId <= 0) {
      logger.error(`Invalid userId: ${userId}`);
      return false;
    }

    const now = this.now();
    const { userNotificationPreferences } = this.tables;
    const effectiveSourceId = sourceId ?? '';

    const setData = {
      notifyOnMessage: prefs.enableWebPush,
      notifyOnDirectMessage: prefs.enableDirectMessages,
      notifyOnEmoji: prefs.notifyOnEmoji,
      notifyOnNewNode: prefs.notifyOnNewNode,
      notifyOnTraceroute: prefs.notifyOnTraceroute,
      notifyOnInactiveNode: prefs.notifyOnInactiveNode,
      notifyOnServerEvents: prefs.notifyOnServerEvents,
      prefixWithNodeName: prefs.prefixWithNodeName,
      appriseEnabled: prefs.enableApprise,
      appriseUrls: JSON.stringify(prefs.appriseUrls),
      enabledChannels: JSON.stringify(prefs.enabledChannels),
      monitoredNodes: JSON.stringify(prefs.monitoredNodes),
      whitelist: JSON.stringify(prefs.whitelist),
      blacklist: JSON.stringify(prefs.blacklist),
      notifyOnMqtt: prefs.notifyOnMqtt,
      mutedChannels: JSON.stringify(prefs.mutedChannels ?? []),
      mutedDMs: JSON.stringify(prefs.mutedDMs ?? []),
      updatedAt: now,
    };

    try {
      if (this.isSQLite()) {
        // SQLite doesn't have notifyOnChannelMessage column
        await (this.db as any)
          .insert(userNotificationPreferences)
          .values({
            userId,
            sourceId: effectiveSourceId,
            ...setData,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [userNotificationPreferences.userId, userNotificationPreferences.sourceId],
            set: setData,
          });
      } else if (this.isMySQL()) {
        const db = this.getMysqlDb();
        await db
          .insert(userNotificationPreferences)
          .values({
            userId,
            sourceId: effectiveSourceId,
            notifyOnChannelMessage: false,
            ...setData,
            createdAt: now,
          })
          .onDuplicateKeyUpdate({ set: setData });
      } else {
        // PostgreSQL
        await (this.db as any)
          .insert(userNotificationPreferences)
          .values({
            userId,
            sourceId: effectiveSourceId,
            notifyOnChannelMessage: false,
            ...setData,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [userNotificationPreferences.userId, userNotificationPreferences.sourceId],
            set: setData,
          });
      }
      return true;
    } catch (error) {
      logger.error(`Failed to save preferences for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Get users who have a specific notification service enabled
   */
  async getUsersWithServiceEnabled(service: 'web_push' | 'apprise'): Promise<number[]> {
    try {
      const { userNotificationPreferences } = this.tables;
      const column = service === 'web_push'
        ? userNotificationPreferences.notifyOnMessage
        : userNotificationPreferences.appriseEnabled;

      const rows = await this.db
        .select({ userId: userNotificationPreferences.userId })
        .from(userNotificationPreferences)
        .where(eq(column, true));

      // Dedup: a user with prefs rows for multiple sources would appear N times
      // and produce N duplicate notifications during preference broadcasts.
      const ids = rows.map((row: any) => row.userId as number);
      return Array.from(new Set<number>(ids));
    } catch (error) {
      logger.debug('No user_notification_preferences table yet, returning empty array');
      return [];
    }
  }

  /**
   * Get users who have Apprise enabled (specific helper for AppriseNotificationService)
   */
  async getUsersWithAppriseEnabled(): Promise<number[]> {
    return this.getUsersWithServiceEnabled('apprise');
  }

  /**
   * Get users who have inactive node notifications enabled and at least one notification channel active
   */
  async getUsersWithInactiveNodeNotifications(): Promise<Array<{ userId: number; monitoredNodes: string | null }>> {
    try {
      const { userNotificationPreferences: t } = this.tables;
      const rows = await this.db
        .select({ userId: t.userId, monitoredNodes: t.monitoredNodes })
        .from(t)
        .where(and(
          eq(t.notifyOnInactiveNode, true),
          or(eq(t.notifyOnMessage, true), eq(t.appriseEnabled, true))
        ));
      return rows;
    } catch (error) {
      logger.debug('Failed to query users with inactive node notifications:', error);
      return [];
    }
  }

  // ============ READ MESSAGE TRACKING ============

  /**
   * Mark channel messages as read for a user.
   * Keeps branching: raw SQL with INSERT...SELECT, different conflict handling per dialect.
   */
  async markChannelMessagesAsRead(
    channelId: number,
    userId: number | null,
    beforeTimestamp?: number
  ): Promise<number> {
    const now = this.now();
    const effectiveUserId = userId ?? 0;

    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        // Get message IDs for the channel
        let query = db
          .select({ id: messagesSqlite.id })
          .from(messagesSqlite)
          .where(
            and(
              eq(messagesSqlite.channel, channelId),
              eq(messagesSqlite.portnum, 1)
            )
          );

        if (beforeTimestamp !== undefined) {
          query = db
            .select({ id: messagesSqlite.id })
            .from(messagesSqlite)
            .where(
              and(
                eq(messagesSqlite.channel, channelId),
                eq(messagesSqlite.portnum, 1),
                lte(messagesSqlite.timestamp, beforeTimestamp)
              )
            );
        }

        const messages = await query;
        if (messages.length === 0) return 0;

        // Insert read records (ignoring conflicts)
        let inserted = 0;
        for (const msg of messages) {
          try {
            await db.insert(readMessagesSqlite).values({
              userId: effectiveUserId,
              messageId: msg.id,
              readAt: now,
            }).onConflictDoNothing();
            inserted++;
          } catch {
            // Ignore duplicates
          }
        }
        return inserted;
      } else if (this.isPostgres()) {
        const db = this.getPostgresDb();
        // Use INSERT...SELECT with WHERE NOT EXISTS to avoid duplicates
        // (ON CONFLICT requires a unique constraint which may not exist on all installs)
        let result;
        if (beforeTimestamp !== undefined) {
          result = await db.execute(sql`
            INSERT INTO read_messages (${this.col('messageId')}, ${this.col('userId')}, ${this.col('readAt')})
            SELECT m.id, ${effectiveUserId}, ${now} FROM messages m
            WHERE m.channel = ${channelId}
              AND m.portnum = 1
              AND m.timestamp <= ${beforeTimestamp}
              AND NOT EXISTS (
                SELECT 1 FROM read_messages rm
                WHERE rm.${this.col('messageId')} = m.id AND rm.${this.col('userId')} = ${effectiveUserId}
              )
          `);
        } else {
          result = await db.execute(sql`
            INSERT INTO read_messages (${this.col('messageId')}, ${this.col('userId')}, ${this.col('readAt')})
            SELECT m.id, ${effectiveUserId}, ${now} FROM messages m
            WHERE m.channel = ${channelId}
              AND m.portnum = 1
              AND NOT EXISTS (
                SELECT 1 FROM read_messages rm
                WHERE rm.${this.col('messageId')} = m.id AND rm.${this.col('userId')} = ${effectiveUserId}
              )
          `);
        }
        return Number(result.rowCount ?? 0);
      } else {
        // MySQL
        const db = this.getMysqlDb();
        // MySQL uses INSERT IGNORE for upsert behavior
        if (beforeTimestamp !== undefined) {
          const [result] = await db.execute(sql`
            INSERT IGNORE INTO read_messages (messageId, userId, readAt)
            SELECT id, ${effectiveUserId}, ${now} FROM messages
            WHERE channel = ${channelId}
              AND portnum = 1
              AND timestamp <= ${beforeTimestamp}
          `);
          return Number((result as any).affectedRows ?? 0);
        } else {
          const [result] = await db.execute(sql`
            INSERT IGNORE INTO read_messages (messageId, userId, readAt)
            SELECT id, ${effectiveUserId}, ${now} FROM messages
            WHERE channel = ${channelId}
              AND portnum = 1
          `);
          return Number((result as any).affectedRows ?? 0);
        }
      }
    } catch (error) {
      logger.error(`Failed to mark channel ${channelId} messages as read:`, error);
      return 0;
    }
  }

  /**
   * Mark DM messages as read between two nodes for a user.
   * Keeps branching: raw SQL with INSERT...SELECT, different conflict handling per dialect.
   */
  async markDMMessagesAsRead(
    localNodeId: string,
    remoteNodeId: string,
    userId: number | null,
    beforeTimestamp?: number
  ): Promise<number> {
    const now = this.now();
    const effectiveUserId = userId ?? 0;

    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        // Get message IDs for the DM conversation
        let baseCondition = and(
          or(
            and(
              eq(messagesSqlite.fromNodeId, localNodeId),
              eq(messagesSqlite.toNodeId, remoteNodeId)
            ),
            and(
              eq(messagesSqlite.fromNodeId, remoteNodeId),
              eq(messagesSqlite.toNodeId, localNodeId)
            )
          ),
          eq(messagesSqlite.portnum, 1),
          eq(messagesSqlite.channel, -1)
        );

        let query = db
          .select({ id: messagesSqlite.id })
          .from(messagesSqlite)
          .where(baseCondition);

        if (beforeTimestamp !== undefined) {
          query = db
            .select({ id: messagesSqlite.id })
            .from(messagesSqlite)
            .where(
              and(
                baseCondition,
                lte(messagesSqlite.timestamp, beforeTimestamp)
              )
            );
        }

        const messages = await query;
        if (messages.length === 0) return 0;

        // Insert read records
        let inserted = 0;
        for (const msg of messages) {
          try {
            await db.insert(readMessagesSqlite).values({
              userId: effectiveUserId,
              messageId: msg.id,
              readAt: now,
            }).onConflictDoNothing();
            inserted++;
          } catch {
            // Ignore duplicates
          }
        }
        return inserted;
      } else if (this.isPostgres()) {
        const db = this.getPostgresDb();
        let result;
        if (beforeTimestamp !== undefined) {
          result = await db.execute(sql`
            INSERT INTO read_messages (${this.col('messageId')}, ${this.col('userId')}, ${this.col('readAt')})
            SELECT m.id, ${effectiveUserId}, ${now} FROM messages m
            WHERE ((m.${this.col('fromNodeId')} = ${localNodeId} AND m.${this.col('toNodeId')} = ${remoteNodeId})
                OR (m.${this.col('fromNodeId')} = ${remoteNodeId} AND m.${this.col('toNodeId')} = ${localNodeId}))
              AND m.portnum = 1
              AND m.channel = -1
              AND m.timestamp <= ${beforeTimestamp}
              AND NOT EXISTS (
                SELECT 1 FROM read_messages rm
                WHERE rm.${this.col('messageId')} = m.id AND rm.${this.col('userId')} = ${effectiveUserId}
              )
          `);
        } else {
          result = await db.execute(sql`
            INSERT INTO read_messages (${this.col('messageId')}, ${this.col('userId')}, ${this.col('readAt')})
            SELECT m.id, ${effectiveUserId}, ${now} FROM messages m
            WHERE ((m.${this.col('fromNodeId')} = ${localNodeId} AND m.${this.col('toNodeId')} = ${remoteNodeId})
                OR (m.${this.col('fromNodeId')} = ${remoteNodeId} AND m.${this.col('toNodeId')} = ${localNodeId}))
              AND m.portnum = 1
              AND m.channel = -1
              AND NOT EXISTS (
                SELECT 1 FROM read_messages rm
                WHERE rm.${this.col('messageId')} = m.id AND rm.${this.col('userId')} = ${effectiveUserId}
              )
          `);
        }
        return Number(result.rowCount ?? 0);
      } else {
        // MySQL
        const db = this.getMysqlDb();
        if (beforeTimestamp !== undefined) {
          const [result] = await db.execute(sql`
            INSERT IGNORE INTO read_messages (messageId, userId, readAt)
            SELECT id, ${effectiveUserId}, ${now} FROM messages
            WHERE ((fromNodeId = ${localNodeId} AND toNodeId = ${remoteNodeId})
                OR (fromNodeId = ${remoteNodeId} AND toNodeId = ${localNodeId}))
              AND portnum = 1
              AND channel = -1
              AND timestamp <= ${beforeTimestamp}
          `);
          return Number((result as any).affectedRows ?? 0);
        } else {
          const [result] = await db.execute(sql`
            INSERT IGNORE INTO read_messages (messageId, userId, readAt)
            SELECT id, ${effectiveUserId}, ${now} FROM messages
            WHERE ((fromNodeId = ${localNodeId} AND toNodeId = ${remoteNodeId})
                OR (fromNodeId = ${remoteNodeId} AND toNodeId = ${localNodeId}))
              AND portnum = 1
              AND channel = -1
          `);
          return Number((result as any).affectedRows ?? 0);
        }
      }
    } catch (error) {
      logger.error(`Failed to mark DM messages as read:`, error);
      return 0;
    }
  }

  /**
   * Mark all DM messages as read for the local node.
   * Keeps branching: raw SQL with INSERT...SELECT, different conflict handling per dialect.
   */
  async markAllDMMessagesAsRead(
    localNodeId: string,
    userId: number | null
  ): Promise<number> {
    const now = this.now();
    const effectiveUserId = userId ?? 0;

    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        // Get all DM message IDs involving the local node
        const messages = await db
          .select({ id: messagesSqlite.id })
          .from(messagesSqlite)
          .where(
            and(
              or(
                eq(messagesSqlite.fromNodeId, localNodeId),
                eq(messagesSqlite.toNodeId, localNodeId)
              ),
              eq(messagesSqlite.portnum, 1),
              eq(messagesSqlite.channel, -1)
            )
          );

        if (messages.length === 0) return 0;

        // Insert read records
        let inserted = 0;
        for (const msg of messages) {
          try {
            await db.insert(readMessagesSqlite).values({
              userId: effectiveUserId,
              messageId: msg.id,
              readAt: now,
            }).onConflictDoNothing();
            inserted++;
          } catch {
            // Ignore duplicates
          }
        }
        return inserted;
      } else if (this.isPostgres()) {
        const db = this.getPostgresDb();
        const result = await db.execute(sql`
          INSERT INTO read_messages (${this.col('messageId')}, ${this.col('userId')}, ${this.col('readAt')})
          SELECT m.id, ${effectiveUserId}, ${now} FROM messages m
          WHERE (m.${this.col('fromNodeId')} = ${localNodeId} OR m.${this.col('toNodeId')} = ${localNodeId})
            AND m.portnum = 1
            AND m.channel = -1
            AND NOT EXISTS (
              SELECT 1 FROM read_messages rm
              WHERE rm.${this.col('messageId')} = m.id AND rm.${this.col('userId')} = ${effectiveUserId}
            )
        `);
        return Number(result.rowCount ?? 0);
      } else {
        // MySQL
        const db = this.getMysqlDb();
        const [result] = await db.execute(sql`
          INSERT IGNORE INTO read_messages (messageId, userId, readAt)
          SELECT id, ${effectiveUserId}, ${now} FROM messages
          WHERE (fromNodeId = ${localNodeId} OR toNodeId = ${localNodeId})
            AND portnum = 1
            AND channel = -1
        `);
        return Number((result as any).affectedRows ?? 0);
      }
    } catch (error) {
      logger.error(`Failed to mark all DM messages as read:`, error);
      return 0;
    }
  }

  /**
   * Mark specific messages as read by their IDs.
   * Keeps branching: raw SQL with different conflict handling per dialect.
   */
  async markMessagesAsReadByIds(
    messageIds: string[],
    userId: number | null
  ): Promise<void> {
    if (messageIds.length === 0) return;

    const now = this.now();
    const effectiveUserId = userId ?? 0;

    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        for (const messageId of messageIds) {
          try {
            await db.insert(readMessagesSqlite).values({
              userId: effectiveUserId,
              messageId,
              readAt: now,
            }).onConflictDoNothing();
          } catch {
            // Ignore duplicates
          }
        }
      } else if (this.isPostgres()) {
        const db = this.getPostgresDb();
        for (const messageId of messageIds) {
          await db.execute(sql`
            INSERT INTO read_messages (${this.col('messageId')}, ${this.col('userId')}, ${this.col('readAt')})
            SELECT ${messageId}, ${effectiveUserId}, ${now}
            WHERE NOT EXISTS (
              SELECT 1 FROM read_messages rm
              WHERE rm.${this.col('messageId')} = ${messageId} AND rm.${this.col('userId')} = ${effectiveUserId}
            )
          `);
        }
      } else {
        // MySQL
        const db = this.getMysqlDb();
        for (const messageId of messageIds) {
          await db.execute(sql`
            INSERT IGNORE INTO read_messages (messageId, userId, readAt)
            VALUES (${messageId}, ${effectiveUserId}, ${now})
          `);
        }
      }
    } catch (error) {
      logger.error(`Failed to mark messages as read by IDs:`, error);
    }
  }

  // ============ UNREAD COUNTS (Drizzle, all backends) ============

  /**
   * Build a `read_messages` LEFT JOIN ON-clause that mirrors the legacy
   * `m.id = rm.messageId AND rm.userId IS NULL` (anonymous) or
   * `m.id = rm.messageId AND rm.userId = ?` (authenticated) pattern used by
   * the unread-count queries.
   *
   * Note: the SQLite schema uses `messageId` as the PRIMARY KEY (no separate
   * `userId` per row prior to multi-user). The PG/MySQL schemas use `userId`
   * as a real column. Drizzle handles the column-name mapping per dialect.
   */
  private unreadJoinOn(userId: number | null) {
    const messages = this.tables.messages;
    const readMessages = this.tables.readMessages;
    if (userId === null) {
      // Anonymous: any read row at all blocks the message from showing as unread
      return eq(messages.id, readMessages.messageId);
    }
    return and(
      eq(messages.id, readMessages.messageId),
      eq(readMessages.userId, userId)
    );
  }

  /**
   * Count unread channel messages grouped by channel (excludes DMs / channel = -1).
   * Returns `{ [channelId]: number }`.
   */
  async getUnreadCountsByChannelAsync(
    userId: number | null,
    localNodeId?: string
  ): Promise<{ [channelId: number]: number }> {
    const messages = this.tables.messages;
    const readMessages = this.tables.readMessages;

    const conditions = [
      isNull(readMessages.messageId),
      ne(messages.channel, -1),
      eq(messages.portnum, 1),
    ];
    if (localNodeId) {
      conditions.push(ne(messages.fromNodeId, localNodeId));
    }

    try {
      const rows: any[] = await this.db
        .select({
          channel: messages.channel,
          count: sql<number>`COUNT(*)`,
        })
        .from(messages)
        .leftJoin(readMessages, this.unreadJoinOn(userId)!)
        .where(and(...conditions))
        .groupBy(messages.channel);

      const counts: { [channelId: number]: number } = {};
      for (const row of rows) {
        counts[Number(row.channel)] = Number(row.count);
      }
      return counts;
    } catch (error) {
      logger.error('Error getting unread counts by channel:', error);
      return {};
    }
  }

  /**
   * Count unread DMs from a single remote node to the local node.
   */
  async getUnreadDMCountAsync(
    localNodeId: string,
    remoteNodeId: string,
    userId: number | null
  ): Promise<number> {
    const messages = this.tables.messages;
    const readMessages = this.tables.readMessages;

    try {
      const rows: any[] = await this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(messages)
        .leftJoin(readMessages, this.unreadJoinOn(userId)!)
        .where(
          and(
            isNull(readMessages.messageId),
            eq(messages.portnum, 1),
            eq(messages.channel, -1),
            eq(messages.fromNodeId, remoteNodeId),
            eq(messages.toNodeId, localNodeId)
          )
        );
      return Number(rows[0]?.count ?? 0);
    } catch (error) {
      logger.error('Error getting unread DM count:', error);
      return 0;
    }
  }

  /**
   * Count unread DMs for the local node grouped by remote sender.
   * Returns `{ [fromNodeId]: number }`.
   */
  async getBatchUnreadDMCountsAsync(
    localNodeId: string,
    userId: number | null
  ): Promise<{ [fromNodeId: string]: number }> {
    const messages = this.tables.messages;
    const readMessages = this.tables.readMessages;

    try {
      const rows: any[] = await this.db
        .select({
          fromNodeId: messages.fromNodeId,
          count: sql<number>`COUNT(*)`,
        })
        .from(messages)
        .leftJoin(readMessages, this.unreadJoinOn(userId)!)
        .where(
          and(
            isNull(readMessages.messageId),
            eq(messages.portnum, 1),
            eq(messages.channel, -1),
            eq(messages.toNodeId, localNodeId)
          )
        )
        .groupBy(messages.fromNodeId);

      const counts: { [fromNodeId: string]: number } = {};
      for (const row of rows) {
        counts[row.fromNodeId] = Number(row.count);
      }
      return counts;
    } catch (error) {
      logger.error('Error getting batch unread DM counts:', error);
      return {};
    }
  }

  // ============ PRIVATE HELPERS ============

  /**
   * Map a database row to DbPushSubscription
   */
  private mapSubscriptionRow(row: any): DbPushSubscription {
    return this.normalizeBigInts({
      id: row.id,
      userId: row.userId,
      sourceId: row.sourceId,
      endpoint: row.endpoint,
      p256dhKey: row.p256dhKey,
      authKey: row.authKey,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
    });
  }

  /**
   * Map a database row to NotificationPreferences
   */
  private mapPreferencesRow(row: any): NotificationPreferences {
    // Parse JSON fields safely
    const parseJsonArray = (value: string | null | undefined): string[] | number[] => {
      if (!value) return [];
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    };

    return {
      enableWebPush: Boolean(row.notifyOnMessage),
      enableApprise: Boolean(row.appriseEnabled),
      enabledChannels: parseJsonArray(row.enabledChannels) as number[],
      enableDirectMessages: Boolean(row.notifyOnDirectMessage),
      notifyOnEmoji: row.notifyOnEmoji !== undefined ? Boolean(row.notifyOnEmoji) : true,
      notifyOnMqtt: row.notifyOnMqtt !== undefined ? Boolean(row.notifyOnMqtt) : true,
      notifyOnNewNode: row.notifyOnNewNode !== undefined ? Boolean(row.notifyOnNewNode) : true,
      notifyOnTraceroute: row.notifyOnTraceroute !== undefined ? Boolean(row.notifyOnTraceroute) : true,
      notifyOnInactiveNode: row.notifyOnInactiveNode !== undefined ? Boolean(row.notifyOnInactiveNode) : false,
      notifyOnServerEvents: row.notifyOnServerEvents !== undefined ? Boolean(row.notifyOnServerEvents) : false,
      prefixWithNodeName: row.prefixWithNodeName !== undefined ? Boolean(row.prefixWithNodeName) : false,
      monitoredNodes: parseJsonArray(row.monitoredNodes) as string[],
      whitelist: parseJsonArray(row.whitelist) as string[],
      blacklist: parseJsonArray(row.blacklist) as string[],
      appriseUrls: parseJsonArray(row.appriseUrls) as string[],
      mutedChannels: parseJsonArray(row.mutedChannels) as unknown as MutedChannel[],
      mutedDMs: parseJsonArray(row.mutedDMs) as unknown as MutedDM[],
    };
  }
}
