import webpush from 'web-push';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';
import databaseService, { DbPushSubscription } from '../../services/database.js';
import { getUserNotificationPreferences, shouldFilterNotification as shouldFilterNotificationUtil } from '../utils/notificationFiltering.js';

export interface PushNotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: any;
  requireInteraction?: boolean;
  silent?: boolean;
}

class PushNotificationService {
  private isConfigured = false;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    // Try to load from environment first (for backward compatibility)
    const config = getEnvironmentConfig();
    let publicKey = config.vapidPublicKey;
    let privateKey = config.vapidPrivateKey;
    let subject = config.vapidSubject;

    // If not in environment, check database and auto-generate if needed
    if (!publicKey || !privateKey) {
      const storedPublicKey = databaseService.getSetting('vapid_public_key');
      const storedPrivateKey = databaseService.getSetting('vapid_private_key');
      const storedSubject = databaseService.getSetting('vapid_subject');

      if (!storedPublicKey || !storedPrivateKey) {
        // Auto-generate VAPID keys on first run
        logger.info('🔑 No VAPID keys found, generating new keys...');
        const vapidKeys = webpush.generateVAPIDKeys();

        databaseService.setSetting('vapid_public_key', vapidKeys.publicKey);
        databaseService.setSetting('vapid_private_key', vapidKeys.privateKey);
        databaseService.setSetting('vapid_subject', storedSubject || 'mailto:admin@meshmonitor.local');

        publicKey = vapidKeys.publicKey;
        privateKey = vapidKeys.privateKey;
        subject = storedSubject || 'mailto:admin@meshmonitor.local';

        logger.info('✅ Generated and saved new VAPID keys to database');
      } else {
        publicKey = storedPublicKey;
        privateKey = storedPrivateKey;
        subject = storedSubject || 'mailto:admin@meshmonitor.local';
        logger.info('✅ Loaded VAPID keys from database');
      }
    }

    if (!publicKey || !privateKey) {
      logger.error('❌ Failed to obtain VAPID keys');
      this.isConfigured = false;
      return;
    }

    try {
      webpush.setVapidDetails(
        subject || 'mailto:admin@meshmonitor.local',
        publicKey,
        privateKey
      );
      this.isConfigured = true;
      logger.info('✅ Push notification service configured with VAPID keys');
    } catch (error) {
      logger.error('❌ Failed to configure push notification service:', error);
      this.isConfigured = false;
    }
  }

  /**
   * Check if push notifications are configured
   */
  public isAvailable(): boolean {
    return this.isConfigured;
  }

  /**
   * Get the public VAPID key for client-side subscription
   */
  public getPublicKey(): string | null {
    const config = getEnvironmentConfig();
    if (config.vapidPublicKey) {
      return config.vapidPublicKey;
    }
    return databaseService.getSetting('vapid_public_key');
  }

  /**
   * Get VAPID configuration status
   */
  public getVapidStatus(): {
    configured: boolean;
    publicKey: string | null;
    subject: string | null;
    subscriptionCount: number;
  } {
    const publicKey = this.getPublicKey();
    const subject = databaseService.getSetting('vapid_subject');
    const subscriptions = this.getAllSubscriptions();

    return {
      configured: this.isConfigured,
      publicKey,
      subject,
      subscriptionCount: subscriptions.length
    };
  }

  /**
   * Update VAPID subject (contact email)
   */
  public updateVapidSubject(subject: string): void {
    if (!subject.startsWith('mailto:')) {
      throw new Error('VAPID subject must start with mailto:');
    }
    databaseService.setSetting('vapid_subject', subject);
    logger.info(`✅ Updated VAPID subject to: ${subject}`);
    // Reinitialize to apply new subject
    this.initialize();
  }

  /**
   * Save a push subscription to the database
   */
  public async saveSubscription(
    userId: number | undefined,
    subscription: PushSubscription,
    userAgent?: string
  ): Promise<void> {
    try {
      const keys = subscription.keys;
      if (!keys || !keys.p256dh || !keys.auth) {
        throw new Error('Invalid subscription: missing keys');
      }

      const now = Date.now();
      const stmt = databaseService.db.prepare(`
        INSERT OR REPLACE INTO push_subscriptions
        (user_id, endpoint, p256dh_key, auth_key, user_agent, created_at, updated_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        userId || null,
        subscription.endpoint,
        keys.p256dh,
        keys.auth,
        userAgent || null,
        now,
        now,
        now
      );

      logger.info(`✅ Saved push subscription for ${userId ? `user ${userId}` : 'anonymous user'}`);
    } catch (error) {
      logger.error('❌ Failed to save push subscription:', error);
      throw error;
    }
  }

  /**
   * Remove a push subscription from the database
   */
  public async removeSubscription(endpoint: string): Promise<void> {
    try {
      const stmt = databaseService.db.prepare(`
        DELETE FROM push_subscriptions WHERE endpoint = ?
      `);
      stmt.run(endpoint);
      logger.info('✅ Removed push subscription');
    } catch (error) {
      logger.error('❌ Failed to remove push subscription:', error);
      throw error;
    }
  }

  /**
   * Get all subscriptions for a user
   */
  public getUserSubscriptions(userId?: number): DbPushSubscription[] {
    try {
      const stmt = databaseService.db.prepare(`
        SELECT * FROM push_subscriptions
        WHERE user_id = ? OR (user_id IS NULL AND ? IS NULL)
        ORDER BY created_at DESC
      `);
      const rows = stmt.all(userId || null, userId || null) as any[];
      // Map snake_case database columns to camelCase
      return rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        endpoint: row.endpoint,
        p256dhKey: row.p256dh_key,
        authKey: row.auth_key,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastUsedAt: row.last_used_at
      }));
    } catch (error) {
      logger.error('❌ Failed to get user subscriptions:', error);
      return [];
    }
  }

  /**
   * Get all active subscriptions
   */
  public getAllSubscriptions(): DbPushSubscription[] {
    try {
      const stmt = databaseService.db.prepare(`
        SELECT * FROM push_subscriptions
        ORDER BY created_at DESC
      `);
      const rows = stmt.all() as any[];
      // Map snake_case database columns to camelCase
      return rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        endpoint: row.endpoint,
        p256dhKey: row.p256dh_key,
        authKey: row.auth_key,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastUsedAt: row.last_used_at
      }));
    } catch (error) {
      logger.error('❌ Failed to get all subscriptions:', error);
      return [];
    }
  }

  /**
   * Send a push notification to a specific subscription
   */
  public async sendToSubscription(
    subscription: DbPushSubscription,
    payload: PushNotificationPayload
  ): Promise<boolean> {
    if (!this.isConfigured) {
      logger.warn('⚠️ Push notifications not configured, skipping send');
      return false;
    }

    try {
      const pushSubscription = {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dhKey,
          auth: subscription.authKey
        }
      };

      await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(payload)
      );

      // Update last_used_at
      const stmt = databaseService.db.prepare(`
        UPDATE push_subscriptions
        SET last_used_at = ?
        WHERE endpoint = ?
      `);
      stmt.run(Date.now(), subscription.endpoint);

      logger.debug(`✅ Sent push notification to subscription ${subscription.id}`);
      return true;
    } catch (error: any) {
      const statusCode = error.statusCode || error.status;

      // Handle expired/invalid/gone subscriptions - remove them
      if (statusCode === 404 || statusCode === 410) {
        logger.warn(`⚠️ Subscription expired/gone (${statusCode}), removing: ${subscription.endpoint}`);
        await this.removeSubscription(subscription.endpoint);
      }
      // Handle payload too large - log but don't remove subscription
      else if (statusCode === 413) {
        logger.error(`❌ Push notification payload too large for subscription ${subscription.id}`);
      }
      // Handle rate limiting - log but don't remove subscription
      else if (statusCode === 429) {
        logger.warn(`⚠️ Rate limited sending to subscription ${subscription.id}, will retry later`);
      }
      // Handle other client errors (400-499) - might indicate invalid subscription
      else if (statusCode >= 400 && statusCode < 500) {
        logger.warn(`⚠️ Client error (${statusCode}) sending to subscription ${subscription.id}, removing`);
        await this.removeSubscription(subscription.endpoint);
      }
      // Handle server errors (500-599) - temporary issue, don't remove
      else if (statusCode >= 500 && statusCode < 600) {
        logger.error(`❌ Server error (${statusCode}) sending push notification to subscription ${subscription.id}`);
      }
      // Handle network/unknown errors
      else {
        logger.error(`❌ Failed to send push notification to subscription ${subscription.id}:`, error);
      }
      return false;
    }
  }

  /**
   * Send a push notification to all subscriptions for a user
   */
  public async sendToUser(
    userId: number | undefined,
    payload: PushNotificationPayload
  ): Promise<{ sent: number; failed: number }> {
    const subscriptions = this.getUserSubscriptions(userId);
    let sent = 0;
    let failed = 0;

    for (const subscription of subscriptions) {
      const success = await this.sendToSubscription(subscription, payload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    return { sent, failed };
  }

  /**
   * Broadcast a push notification to all subscriptions
   */
  public async broadcast(payload: PushNotificationPayload): Promise<{ sent: number; failed: number }> {
    const subscriptions = this.getAllSubscriptions();
    let sent = 0;
    let failed = 0;

    logger.info(`📢 Broadcasting push notification to ${subscriptions.length} subscriptions`);

    for (const subscription of subscriptions) {
      const success = await this.sendToSubscription(subscription, payload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    logger.info(`📢 Broadcast complete: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  }

  /**
   * Broadcast a push notification with per-user filtering
   */
  public async broadcastWithFiltering(
    payload: PushNotificationPayload,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    const subscriptions = this.getAllSubscriptions();
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.info(`📢 Broadcasting push notification to ${subscriptions.length} subscriptions with filtering`);

    for (const subscription of subscriptions) {
      // Get user preferences
      const userId = subscription.userId;

      // Skip if user should be filtered
      if (this.shouldFilterNotification(userId, filterContext)) {
        logger.debug(`🔇 Filtered notification for user ${userId || 'anonymous'}: ${filterContext.messageText.substring(0, 30)}...`);
        filtered++;
        continue;
      }

      const success = await this.sendToSubscription(subscription, payload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    logger.info(`📢 Broadcast complete: ${sent} sent, ${failed} failed, ${filtered} filtered`);
    return { sent, failed, filtered };
  }

  /**
   * Check if notification should be filtered for a user based on their preferences
   *
   * Design Note: Anonymous users receive all notifications by default because:
   * 1. They haven't configured preferences yet (can't know what they want)
   * 2. They've explicitly subscribed to push notifications (opt-in consent)
   * 3. MeshMonitor is typically for private mesh networks (trusted environment)
   * 4. Users can unsubscribe at any time or set up authentication + preferences
   */
  private shouldFilterNotification(
    userId: number | null | undefined,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
    }
  ): boolean {
    // Anonymous users get all notifications (no filtering) - they've opted in by subscribing
    if (!userId) {
      logger.debug('Anonymous user - no filtering applied (user opted in by subscribing)');
      return false;
    }

    // Check if user has web push enabled
    const prefs = getUserNotificationPreferences(userId);
    if (prefs && !prefs.enableWebPush) {
      logger.debug(`🔇 Web Push disabled for user ${userId}`);
      return true; // Filter - user has disabled web push
    }

    // Use shared filtering utility
    return shouldFilterNotificationUtil(userId, filterContext);
  }
}

// Web Push subscription type (matches browser PushSubscription interface)
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export const pushNotificationService = new PushNotificationService();
