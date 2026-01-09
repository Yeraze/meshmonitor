import webpush from 'web-push';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import type { DbPushSubscription } from '../../db/types.js';
import { getUserNotificationPreferencesAsync, shouldFilterNotificationAsync, applyNodeNamePrefixAsync } from '../utils/notificationFiltering.js';
import meshtasticManager from '../meshtasticManager.js';

// Re-export DbPushSubscription for backward compatibility
export type { DbPushSubscription } from '../../db/types.js';

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
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Start async initialization - it will wait for the database to be ready
    this.initPromise = this.initializeAsync();
  }

  /**
   * Async initialization that waits for the database to be ready
   */
  private async initializeAsync(): Promise<void> {
    // Try to load from environment first (for backward compatibility)
    const config = getEnvironmentConfig();
    let publicKey = config.vapidPublicKey;
    let privateKey = config.vapidPrivateKey;
    let subject = config.vapidSubject;

    // If not in environment, check database and auto-generate if needed
    if (!publicKey || !privateKey) {
      // Wait for the database to be ready before accessing settings
      try {
        await databaseService.waitForReady();

        const storedPublicKey = await databaseService.getSettingAsync('vapid_public_key');
        const storedPrivateKey = await databaseService.getSettingAsync('vapid_private_key');
        const storedSubject = await databaseService.getSettingAsync('vapid_subject');

        if (!storedPublicKey || !storedPrivateKey) {
          // Auto-generate VAPID keys on first run
          logger.info('🔑 No VAPID keys found, generating new keys...');
          const vapidKeys = webpush.generateVAPIDKeys();

          await databaseService.setSettingAsync('vapid_public_key', vapidKeys.publicKey);
          await databaseService.setSettingAsync('vapid_private_key', vapidKeys.privateKey);
          await databaseService.setSettingAsync('vapid_subject', storedSubject || 'mailto:admin@meshmonitor.local');

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
      } catch (error) {
        // Database not ready or settings table doesn't exist (e.g., during tests)
        logger.debug('⚠️ Could not load VAPID keys from database, push notifications disabled:', error);
        this.isConfigured = false;
        return;
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

      // Log TTL configuration for visibility
      const envConfig = getEnvironmentConfig();
      const ttlMinutes = Math.round(envConfig.pushNotificationTtl / 60);
      logger.info(`✅ Push notification service configured with VAPID keys (TTL: ${envConfig.pushNotificationTtl}s / ${ttlMinutes}min)`);
    } catch (error) {
      logger.error('❌ Failed to configure push notification service:', error);
      this.isConfigured = false;
    }
  }

  /**
   * Wait for initialization to complete
   */
  async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
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
  public async getPublicKeyAsync(): Promise<string | null> {
    const config = getEnvironmentConfig();
    if (config.vapidPublicKey) {
      return config.vapidPublicKey;
    }
    return databaseService.getSettingAsync('vapid_public_key');
  }

  /**
   * Get VAPID configuration status
   */
  public async getVapidStatusAsync(): Promise<{
    configured: boolean;
    publicKey: string | null;
    subject: string | null;
    subscriptionCount: number;
  }> {
    const publicKey = await this.getPublicKeyAsync();
    const subject = await databaseService.getSettingAsync('vapid_subject');
    const subscriptions = await this.getAllSubscriptionsAsync();

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
  public async updateVapidSubject(subject: string): Promise<void> {
    if (!subject.startsWith('mailto:')) {
      throw new Error('VAPID subject must start with mailto:');
    }
    await databaseService.setSettingAsync('vapid_subject', subject);
    logger.info(`✅ Updated VAPID subject to: ${subject}`);
    // Reinitialize to apply new subject
    await this.initializeAsync();
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

      if (!databaseService.notificationsRepo) {
        throw new Error('Notifications repository not initialized');
      }

      await databaseService.notificationsRepo.saveSubscription({
        userId: userId ?? null,
        endpoint: subscription.endpoint,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
        userAgent: userAgent ?? null,
      });

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
      if (!databaseService.notificationsRepo) {
        throw new Error('Notifications repository not initialized');
      }

      await databaseService.notificationsRepo.removeSubscription(endpoint);
      logger.info('✅ Removed push subscription');
    } catch (error) {
      logger.error('❌ Failed to remove push subscription:', error);
      throw error;
    }
  }

  /**
   * Get all subscriptions for a user (async)
   */
  public async getUserSubscriptionsAsync(userId?: number): Promise<DbPushSubscription[]> {
    try {
      if (!databaseService.notificationsRepo) {
        logger.debug('Notifications repository not initialized');
        return [];
      }

      return databaseService.notificationsRepo.getUserSubscriptions(userId);
    } catch (error) {
      logger.error('❌ Failed to get user subscriptions:', error);
      return [];
    }
  }

  /**
   * Get all active subscriptions (async)
   */
  public async getAllSubscriptionsAsync(): Promise<DbPushSubscription[]> {
    try {
      if (!databaseService.notificationsRepo) {
        logger.debug('Notifications repository not initialized');
        return [];
      }

      return databaseService.notificationsRepo.getAllSubscriptions();
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

      // Get TTL (Time To Live) from config - prevents old notifications from flooding
      // when devices come back online after being offline
      const config = getEnvironmentConfig();
      const ttl = config.pushNotificationTtl;

      await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(payload),
        {
          TTL: ttl
        }
      );

      // Update last_used_at
      if (databaseService.notificationsRepo) {
        await databaseService.notificationsRepo.updateSubscriptionLastUsed(subscription.endpoint);
      }

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
    const subscriptions = await this.getUserSubscriptionsAsync(userId);
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
    const subscriptions = await this.getAllSubscriptionsAsync();
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
      viaMqtt?: boolean;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    const subscriptions = await this.getAllSubscriptionsAsync();
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.info(`📢 Broadcasting push notification to ${subscriptions.length} subscriptions with filtering`);

    // Get local node name for prefix
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    for (const subscription of subscriptions) {
      // Get user preferences
      const userId = subscription.userId;

      // Skip if user should be filtered
      if (await this.shouldFilterNotificationAsync(userId, filterContext)) {
        logger.debug(`🔇 Filtered notification for user ${userId || 'anonymous'}: ${filterContext.messageText.substring(0, 30)}...`);
        filtered++;
        continue;
      }

      // Apply node name prefix if user has it enabled
      const prefixedBody = await applyNodeNamePrefixAsync(userId, payload.body, localNodeName);
      const notificationPayload = prefixedBody !== payload.body
        ? { ...payload, body: prefixedBody }
        : payload;

      const success = await this.sendToSubscription(subscription, notificationPayload);
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
  private async shouldFilterNotificationAsync(
    userId: number | null | undefined,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
      viaMqtt?: boolean;
    }
  ): Promise<boolean> {
    // Anonymous users get all notifications (no filtering) - they've opted in by subscribing
    if (!userId) {
      logger.debug('Anonymous user - no filtering applied (user opted in by subscribing)');
      return false;
    }

    // Check if user has web push enabled
    const prefs = await getUserNotificationPreferencesAsync(userId);
    if (prefs && !prefs.enableWebPush) {
      logger.debug(`🔇 Web Push disabled for user ${userId}`);
      return true; // Filter - user has disabled web push
    }

    // Use shared filtering utility
    return shouldFilterNotificationAsync(userId, filterContext);
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Used for special notifications like new nodes, traceroutes, and inactive nodes
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnServerEvents',
    payload: PushNotificationPayload,
    targetUserId?: number
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    const subscriptions = await this.getAllSubscriptionsAsync();
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.info(`📢 Broadcasting ${preferenceKey} notification to ${subscriptions.length} subscriptions${targetUserId ? ` (target user: ${targetUserId})` : ''}`);

    // Get local node name for prefix
    // First try the live connection, then fall back to database (for startup before connection)
    let localNodeName: string | null = null;
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    if (localNodeInfo?.longName) {
      localNodeName = localNodeInfo.longName;
    } else {
      // Fall back to database - get localNodeNum from settings and look up the node
      const localNodeNumStr = await databaseService.getSettingAsync('localNodeNum');
      if (localNodeNumStr) {
        const localNodeNum = parseInt(localNodeNumStr, 10);
        const localNode = await databaseService.nodesRepo?.getNode(localNodeNum);
        if (localNode?.longName) {
          localNodeName = localNode.longName;
          logger.debug(`📢 Using node name from database for prefix: ${localNodeName}`);
        }
      }
    }

    for (const subscription of subscriptions) {
      const userId = subscription.userId;

      // Skip anonymous users for these special notifications
      if (!userId) {
        filtered++;
        continue;
      }

      // If targetUserId is specified, only send to that user
      if (targetUserId !== undefined && userId !== targetUserId) {
        filtered++;
        continue;
      }

      // Check if user has this preference enabled
      const prefs = await getUserNotificationPreferencesAsync(userId);
      if (!prefs || !prefs.enableWebPush || !prefs[preferenceKey]) {
        filtered++;
        continue;
      }

      // Apply node name prefix if user has it enabled
      const prefixedBody = await applyNodeNamePrefixAsync(userId, payload.body, localNodeName);
      const notificationPayload = prefixedBody !== payload.body
        ? { ...payload, body: prefixedBody }
        : payload;

      const success = await this.sendToSubscription(subscription, notificationPayload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    logger.info(`📢 ${preferenceKey} broadcast complete: ${sent} sent, ${failed} failed, ${filtered} filtered`);
    return { sent, failed, filtered };
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
