/**
 * Notifications Repository
 *
 * Handles all notification-related database operations including:
 * - Push subscriptions (CRUD)
 * - User notification preferences (CRUD)
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc } from 'drizzle-orm';
import {
  pushSubscriptionsSqlite,
  pushSubscriptionsPostgres,
  userNotificationPreferencesSqlite,
  userNotificationPreferencesPostgres,
} from '../schema/notifications.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbPushSubscription } from '../types.js';
import { logger } from '../../utils/logger.js';

// Re-export for convenience
export type { DbPushSubscription } from '../types.js';

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
}

/**
 * Input for creating/updating push subscriptions
 */
export interface PushSubscriptionInput {
  userId?: number | null;
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
  async getAllSubscriptions(): Promise<DbPushSubscription[]> {
    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        const rows = await db
          .select()
          .from(pushSubscriptionsSqlite)
          .orderBy(desc(pushSubscriptionsSqlite.createdAt));
        return rows.map(row => this.mapSubscriptionRow(row));
      } else {
        // PostgreSQL and MySQL use the same code path
        const db = this.getPostgresDb();
        const rows = await db
          .select()
          .from(pushSubscriptionsPostgres)
          .orderBy(desc(pushSubscriptionsPostgres.createdAt));
        return rows.map(row => this.mapSubscriptionRow(row));
      }
    } catch (error) {
      logger.error('❌ Failed to get all subscriptions:', error);
      return [];
    }
  }

  /**
   * Get push subscriptions for a specific user
   */
  async getUserSubscriptions(userId: number | null | undefined): Promise<DbPushSubscription[]> {
    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        const rows = userId
          ? await db
              .select()
              .from(pushSubscriptionsSqlite)
              .where(eq(pushSubscriptionsSqlite.userId, userId))
              .orderBy(desc(pushSubscriptionsSqlite.createdAt))
          : await db
              .select()
              .from(pushSubscriptionsSqlite)
              .orderBy(desc(pushSubscriptionsSqlite.createdAt));
        return rows.map(row => this.mapSubscriptionRow(row));
      } else {
        // PostgreSQL and MySQL use the same code path
        const db = this.getPostgresDb();
        const rows = userId
          ? await db
              .select()
              .from(pushSubscriptionsPostgres)
              .where(eq(pushSubscriptionsPostgres.userId, userId))
              .orderBy(desc(pushSubscriptionsPostgres.createdAt))
          : await db
              .select()
              .from(pushSubscriptionsPostgres)
              .orderBy(desc(pushSubscriptionsPostgres.createdAt));
        return rows.map(row => this.mapSubscriptionRow(row));
      }
    } catch (error) {
      logger.error('❌ Failed to get user subscriptions:', error);
      return [];
    }
  }

  /**
   * Save a push subscription (insert or update by endpoint)
   */
  async saveSubscription(input: PushSubscriptionInput): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(pushSubscriptionsSqlite)
        .values({
          userId: input.userId ?? null,
          endpoint: input.endpoint,
          p256dhKey: input.p256dhKey,
          authKey: input.authKey,
          userAgent: input.userAgent ?? null,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        })
        .onConflictDoUpdate({
          target: pushSubscriptionsSqlite.endpoint,
          set: {
            userId: input.userId ?? null,
            p256dhKey: input.p256dhKey,
            authKey: input.authKey,
            userAgent: input.userAgent ?? null,
            updatedAt: now,
            lastUsedAt: now,
          },
        });
    } else {
      // PostgreSQL and MySQL use the same code path
      const db = this.getPostgresDb();
      await db
        .insert(pushSubscriptionsPostgres)
        .values({
          userId: input.userId ?? null,
          endpoint: input.endpoint,
          p256dhKey: input.p256dhKey,
          authKey: input.authKey,
          userAgent: input.userAgent ?? null,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        })
        .onConflictDoUpdate({
          target: pushSubscriptionsPostgres.endpoint,
          set: {
            userId: input.userId ?? null,
            p256dhKey: input.p256dhKey,
            authKey: input.authKey,
            userAgent: input.userAgent ?? null,
            updatedAt: now,
            lastUsedAt: now,
          },
        });
    }
  }

  /**
   * Remove a push subscription by endpoint
   */
  async removeSubscription(endpoint: string): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .delete(pushSubscriptionsSqlite)
        .where(eq(pushSubscriptionsSqlite.endpoint, endpoint));
    } else {
      // PostgreSQL and MySQL use the same code path
      const db = this.getPostgresDb();
      await db
        .delete(pushSubscriptionsPostgres)
        .where(eq(pushSubscriptionsPostgres.endpoint, endpoint));
    }
  }

  /**
   * Update the last_used_at timestamp for a subscription
   */
  async updateSubscriptionLastUsed(endpoint: string): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(pushSubscriptionsSqlite)
        .set({ lastUsedAt: now })
        .where(eq(pushSubscriptionsSqlite.endpoint, endpoint));
    } else {
      // PostgreSQL and MySQL use the same code path
      const db = this.getPostgresDb();
      await db
        .update(pushSubscriptionsPostgres)
        .set({ lastUsedAt: now })
        .where(eq(pushSubscriptionsPostgres.endpoint, endpoint));
    }
  }

  // ============ USER NOTIFICATION PREFERENCES ============

  /**
   * Get notification preferences for a user
   */
  async getUserPreferences(userId: number): Promise<NotificationPreferences | null> {
    if (!Number.isInteger(userId) || userId <= 0) {
      logger.error(`❌ Invalid userId: ${userId}`);
      return null;
    }

    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        const rows = await db
          .select()
          .from(userNotificationPreferencesSqlite)
          .where(eq(userNotificationPreferencesSqlite.userId, userId))
          .limit(1);

        if (rows.length === 0) {
          return null;
        }

        return this.mapPreferencesRow(rows[0]);
      } else {
        // PostgreSQL and MySQL use the same code path
        const db = this.getPostgresDb();
        const rows = await db
          .select()
          .from(userNotificationPreferencesPostgres)
          .where(eq(userNotificationPreferencesPostgres.userId, userId))
          .limit(1);

        if (rows.length === 0) {
          return null;
        }

        return this.mapPreferencesRow(rows[0]);
      }
    } catch (error) {
      logger.error(`❌ Failed to get preferences for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Save notification preferences for a user (insert or update)
   */
  async saveUserPreferences(userId: number, prefs: NotificationPreferences): Promise<boolean> {
    if (!Number.isInteger(userId) || userId <= 0) {
      logger.error(`❌ Invalid userId: ${userId}`);
      return false;
    }

    const now = this.now();

    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db
          .insert(userNotificationPreferencesSqlite)
          .values({
            userId,
            notifyOnMessage: prefs.enableWebPush,
            notifyOnDirectMessage: prefs.enableDirectMessages,
            notifyOnChannelMessage: false, // Deprecated, use enabledChannels
            notifyOnEmoji: prefs.notifyOnEmoji,
            notifyOnInactiveNode: prefs.notifyOnInactiveNode,
            notifyOnServerEvents: prefs.notifyOnServerEvents,
            prefixWithNodeName: prefs.prefixWithNodeName,
            appriseEnabled: prefs.enableApprise,
            appriseUrls: JSON.stringify(prefs.appriseUrls),
            notifyOnMqtt: prefs.notifyOnMqtt,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userNotificationPreferencesSqlite.userId,
            set: {
              notifyOnMessage: prefs.enableWebPush,
              notifyOnDirectMessage: prefs.enableDirectMessages,
              notifyOnEmoji: prefs.notifyOnEmoji,
              notifyOnInactiveNode: prefs.notifyOnInactiveNode,
              notifyOnServerEvents: prefs.notifyOnServerEvents,
              prefixWithNodeName: prefs.prefixWithNodeName,
              appriseEnabled: prefs.enableApprise,
              appriseUrls: JSON.stringify(prefs.appriseUrls),
              notifyOnMqtt: prefs.notifyOnMqtt,
              updatedAt: now,
            },
          });
        return true;
      } else {
        // PostgreSQL and MySQL use the same code path
        const db = this.getPostgresDb();
        await db
          .insert(userNotificationPreferencesPostgres)
          .values({
            userId,
            notifyOnMessage: prefs.enableWebPush,
            notifyOnDirectMessage: prefs.enableDirectMessages,
            notifyOnChannelMessage: false,
            notifyOnEmoji: prefs.notifyOnEmoji,
            notifyOnInactiveNode: prefs.notifyOnInactiveNode,
            notifyOnServerEvents: prefs.notifyOnServerEvents,
            prefixWithNodeName: prefs.prefixWithNodeName,
            appriseEnabled: prefs.enableApprise,
            appriseUrls: JSON.stringify(prefs.appriseUrls),
            notifyOnMqtt: prefs.notifyOnMqtt,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userNotificationPreferencesPostgres.userId,
            set: {
              notifyOnMessage: prefs.enableWebPush,
              notifyOnDirectMessage: prefs.enableDirectMessages,
              notifyOnEmoji: prefs.notifyOnEmoji,
              notifyOnInactiveNode: prefs.notifyOnInactiveNode,
              notifyOnServerEvents: prefs.notifyOnServerEvents,
              prefixWithNodeName: prefs.prefixWithNodeName,
              appriseEnabled: prefs.enableApprise,
              appriseUrls: JSON.stringify(prefs.appriseUrls),
              notifyOnMqtt: prefs.notifyOnMqtt,
              updatedAt: now,
            },
          });
        return true;
      }
    } catch (error) {
      logger.error(`❌ Failed to save preferences for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Get users who have a specific notification service enabled
   */
  async getUsersWithServiceEnabled(service: 'web_push' | 'apprise'): Promise<number[]> {
    try {
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        const column = service === 'web_push'
          ? userNotificationPreferencesSqlite.notifyOnMessage
          : userNotificationPreferencesSqlite.appriseEnabled;

        const rows = await db
          .select({ userId: userNotificationPreferencesSqlite.userId })
          .from(userNotificationPreferencesSqlite)
          .where(eq(column, true));

        return rows.map(row => row.userId);
      } else {
        // PostgreSQL and MySQL use the same code path
        const db = this.getPostgresDb();
        const column = service === 'web_push'
          ? userNotificationPreferencesPostgres.notifyOnMessage
          : userNotificationPreferencesPostgres.appriseEnabled;

        const rows = await db
          .select({ userId: userNotificationPreferencesPostgres.userId })
          .from(userNotificationPreferencesPostgres)
          .where(eq(column, true));

        return rows.map(row => row.userId);
      }
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

  // ============ PRIVATE HELPERS ============

  /**
   * Map a database row to DbPushSubscription
   */
  private mapSubscriptionRow(row: any): DbPushSubscription {
    return this.normalizeBigInts({
      id: row.id,
      userId: row.userId,
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
      enabledChannels: [], // This needs to be handled separately - stored in different format
      enableDirectMessages: Boolean(row.notifyOnDirectMessage),
      notifyOnEmoji: row.notifyOnEmoji !== undefined ? Boolean(row.notifyOnEmoji) : true,
      notifyOnMqtt: row.notifyOnMqtt !== undefined ? Boolean(row.notifyOnMqtt) : true,
      notifyOnNewNode: true, // Default to enabled
      notifyOnTraceroute: true, // Default to enabled
      notifyOnInactiveNode: row.notifyOnInactiveNode !== undefined ? Boolean(row.notifyOnInactiveNode) : false,
      notifyOnServerEvents: row.notifyOnServerEvents !== undefined ? Boolean(row.notifyOnServerEvents) : false,
      prefixWithNodeName: row.prefixWithNodeName !== undefined ? Boolean(row.prefixWithNodeName) : false,
      monitoredNodes: [], // Default to empty array
      whitelist: [], // Default to empty array
      blacklist: [], // Default to empty array
      appriseUrls: parseJsonArray(row.appriseUrls) as string[],
    };
  }
}
