import webpush from 'web-push';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import type { DbPushSubscription } from '../../db/types.js';
import { getUserNotificationPreferencesAsync, shouldFilterNotificationAsync, applyNodeNamePrefixAsync, renderMessagePayloadForUserAsync } from '../utils/notificationFiltering.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import { notificationDedup, dedupTag, joinSourceNames, type DedupClaim, type NotificationDedupSpec } from './notificationDedup.js';

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
  /**
   * With a `tag`: false replaces the shown notification without alerting the
   * user again. Set on every deduped notification (#5729).
   */
  renotify?: boolean;
  /** Phase C: source this notification originated from (optional for back-compat with broadcastWithFiltering paths). */
  sourceId?: string;
  /** Phase C: human-readable source name. */
  sourceName?: string;
  /**
   * Message notifications only (#5593): the values `broadcastWithFiltering`
   * renders each recipient's title/body template from. Never sent on the wire.
   */
  message?: MessageTemplateContext;
  /** Cross-source dedup (#5729); see `notificationDedup.ts`. Never sent on the wire. */
  dedup?: NotificationDedupSpec;
}

/**
 * Dedup recipient for one push subscription (#5729). The browser is the unit:
 * a user's phone subscribed on source A and laptop on source B must each still
 * get their one notification. The user id is part of the key so that an
 * endpoint whose rows belong to different users never mixes their source
 * lists.
 */
function pushDedupRecipient(subscription: DbPushSubscription): string {
  return `push:${subscription.userId ?? 'anon'}:${subscription.endpoint}`;
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

        const storedPublicKey = await databaseService.settings.getSetting('vapid_public_key');
        const storedPrivateKey = await databaseService.settings.getSetting('vapid_private_key');
        const storedSubject = await databaseService.settings.getSetting('vapid_subject');

        if (!storedPublicKey || !storedPrivateKey) {
          // Auto-generate VAPID keys on first run
          logger.info('🔑 No VAPID keys found, generating new keys...');
          const vapidKeys = webpush.generateVAPIDKeys();

          await databaseService.settings.setSetting('vapid_public_key', vapidKeys.publicKey);
          await databaseService.settings.setSetting('vapid_private_key', vapidKeys.privateKey);
          await databaseService.settings.setSetting('vapid_subject', storedSubject || 'mailto:admin@meshmonitor.local');

          publicKey = vapidKeys.publicKey;
          privateKey = vapidKeys.privateKey;
          subject = storedSubject || 'mailto:admin@meshmonitor.local';

          logger.info('✅ Generated and saved new VAPID keys to database');
        } else {
          publicKey = storedPublicKey;
          privateKey = storedPrivateKey;
          subject = storedSubject || 'mailto:admin@meshmonitor.local';
          logger.debug('✅ Loaded VAPID keys from database');
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
    return databaseService.settings.getSetting('vapid_public_key');
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
    const subject = await databaseService.settings.getSetting('vapid_subject');
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
    await databaseService.settings.setSetting('vapid_subject', subject);
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
    userAgent: string | undefined,
    sourceId: string
  ): Promise<void> {
    try {
      const keys = subscription.keys;
      if (!keys || !keys.p256dh || !keys.auth) {
        throw new Error('Invalid subscription: missing keys');
      }
      if (!sourceId) {
        throw new Error('sourceId is required for saveSubscription');
      }

      if (!databaseService.notificationsRepo) {
        throw new Error('Notifications repository not initialized');
      }

      await databaseService.notificationsRepo.saveSubscription({
        userId: userId ?? null,
        sourceId,
        endpoint: subscription.endpoint,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
        userAgent: userAgent ?? null,
      });

      logger.info(`✅ Saved push subscription for ${userId ? `user ${userId}` : 'anonymous user'} on source ${sourceId}`);
    } catch (error) {
      logger.error('❌ Failed to save push subscription:', error);
      throw error;
    }
  }

  /**
   * Remove push subscription rows from the database.
   *
   * With `sourceId`, removes only that source's row(s) for the endpoint, so
   * the same browser stays subscribed on its other sources (#5493). Without
   * it, removes every row for the endpoint.
   */
  public async removeSubscription(endpoint: string, sourceId?: string): Promise<void> {
    try {
      if (!databaseService.notificationsRepo) {
        throw new Error('Notifications repository not initialized');
      }

      await databaseService.notificationsRepo.removeSubscription(endpoint, sourceId);
      logger.info(sourceId
        ? `✅ Removed push subscription for source ${sourceId}`
        : '✅ Removed push subscription for all sources');
    } catch (error) {
      logger.error('❌ Failed to remove push subscription:', error);
      throw error;
    }
  }

  /**
   * Distinct sourceIds that still hold a subscription row for this endpoint.
   */
  public async getSubscriptionSourceIds(endpoint: string): Promise<string[]> {
    if (!databaseService.notificationsRepo) {
      throw new Error('Notifications repository not initialized');
    }
    return databaseService.notificationsRepo.getSubscriptionSourceIds(endpoint);
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
  public async getAllSubscriptionsAsync(sourceId?: string): Promise<DbPushSubscription[]> {
    try {
      if (!databaseService.notificationsRepo) {
        logger.debug('Notifications repository not initialized');
        return [];
      }

      return databaseService.notificationsRepo.getAllSubscriptions(sourceId);
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

      // Render and dedup inputs are server-side only: keep them off the wire.
      const wirePayload: PushNotificationPayload = { ...payload };
      delete wirePayload.message;
      delete wirePayload.dedup;

      await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(wirePayload),
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
        // No sourceId on purpose: the push service says the ENDPOINT is dead,
        // so every source's row for it is dead too (#5493).
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
        // No sourceId on purpose: an invalid endpoint is invalid for every
        // source, so remove all of its rows (#5493).
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

    logger.debug(`📢 Broadcasting push notification to ${subscriptions.length} subscriptions`);

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
      /** #5720: the packet is a protocol tapback (Meshtastic `emoji === 1`). */
      isTapback?: boolean;
      sourceId: string;
      sourceName: string;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    // Phase B: only subscriptions bound to this source
    const subscriptions = await this.getAllSubscriptionsAsync(filterContext.sourceId);
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.debug(`📢 Broadcasting push notification for source ${filterContext.sourceId} to ${subscriptions.length} subscriptions with filtering`);

    // Get local node name for prefix
    const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const localNodeInfo = mgr.getLocalNodeInfo();
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

      // Cross-source dedup (#5729), AFTER this source's permission and filter
      // passed for this recipient: only a copy that would have been sent
      // counts, and only its source is ever named.
      //   first      → send as before, tagged so a later copy can replace it.
      //   additional → another source heard the same packet: replace the
      //                shown notification, silently, with one that lists them.
      //   duplicate  → nothing.
      const recipient = pushDedupRecipient(subscription);
      let claim: DedupClaim | null = null;
      if (payload.dedup) {
        claim = notificationDedup.claim(recipient, payload.dedup.key, {
          sourceId: filterContext.sourceId,
          sourceName: filterContext.sourceName,
        });
        if (claim.outcome === 'duplicate') {
          filtered++;
          continue;
        }
      }
      const isUpdate = claim?.outcome === 'additional';
      // An update keeps the look of the notification it replaces: the first
      // source's templates and prefix setting, with every source named.
      const renderSourceId = isUpdate && claim ? claim.sources[0].sourceId : filterContext.sourceId;
      const shownSourceName = isUpdate && claim ? joinSourceNames(claim.sources) : filterContext.sourceName;
      const renderInput = isUpdate && payload.message
        ? { ...payload, message: { ...payload.message, sourceName: shownSourceName } }
        : payload;

      // Render AFTER the filter decision (#5593): the user's templates shape
      // the text only, never whether a notification is sent.
      const rendered = await renderMessagePayloadForUserAsync(userId, renderInput, renderSourceId, shownSourceName);

      // Apply node name prefix if user has it enabled (per-source prefs)
      const body = await applyNodeNamePrefixAsync(userId, rendered.body, localNodeName, renderSourceId);
      // `message` and `dedup` are server-side inputs, not wire data: keep them
      // out of the push payload.
      const notificationPayload: PushNotificationPayload = { ...payload, title: rendered.title, body };
      delete notificationPayload.message;
      delete notificationPayload.dedup;
      if (payload.dedup) {
        notificationPayload.tag = dedupTag(payload.dedup.key);
        notificationPayload.renotify = false;
        if (isUpdate) notificationPayload.silent = true;
      }

      const success = await this.sendToSubscription(subscription, notificationPayload);
      if (success) {
        sent++;
      } else {
        failed++;
        // A first copy that never arrived must not block another source's copy.
        if (payload.dedup && claim?.outcome === 'first') {
          notificationDedup.release(recipient, payload.dedup.key, filterContext.sourceId);
        }
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
      /** #5720: the packet is a protocol tapback (Meshtastic `emoji === 1`). */
      isTapback?: boolean;
      sourceId: string;
      sourceName: string;
    }
  ): Promise<boolean> {
    // Anonymous users get all notifications (no filtering) - they've opted in by subscribing
    if (!userId) {
      logger.debug('Anonymous user - no filtering applied (user opted in by subscribing)');
      return false;
    }

    // Phase B: permission check — user must have messages:read on this source
    try {
      const allowed = await databaseService.checkPermissionAsync(userId, 'messages', 'read', filterContext.sourceId);
      if (!allowed) {
        logger.debug(`🔒 User ${userId} lacks messages:read on source ${filterContext.sourceId}`);
        return true;
      }
    } catch (error) {
      logger.error(`Permission check failed for user ${userId}:`, error);
      return true;
    }

    // Check if user has web push enabled (per-source preferences)
    const prefs = await getUserNotificationPreferencesAsync(userId, filterContext.sourceId);
    if (prefs && !prefs.enableWebPush) {
      logger.debug(`🔇 Web Push disabled for user ${userId} on source ${filterContext.sourceId}`);
      return true; // Filter - user has disabled web push
    }

    // Use shared filtering utility (will re-check permission, prefs per source)
    return shouldFilterNotificationAsync(userId, filterContext);
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Used for special notifications like new nodes, traceroutes, and inactive nodes
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnLowBattery' | 'notifyOnServerEvents' | 'notifyOnWaypoint',
    payload: PushNotificationPayload,
    targetUserId?: number,
    sourceId?: string
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    // Phase C: scope preference broadcasts by sourceId so prefs/permissions are per-source.
    // sourceId defaults to the payload's sourceId if not explicitly given.
    const effectiveSourceId = sourceId ?? payload.sourceId;
    // An untargeted broadcast (new node, traceroute, server event) is about one
    // source, so it goes only to browsers subscribed on THAT source — the same
    // rule message pushes follow. It used to go to every subscription row of
    // every source, so a browser subscribed on A received B's new-node pushes
    // (twice, if it was subscribed on B as well: one endpoint, two rows), even
    // after the user unsubscribed from B (#5493). That mattered little while a
    // source with no saved preferences borrowed another source's row; with the
    // built-in defaults (new-node and traceroute alerts on) it would notify
    // for every source the user can read.
    //
    // A targeted alert (low battery, inactive node, waypoint) keeps every
    // subscription of that user: the check service already decided this user
    // must hear about it, wherever they set up delivery (#4020).
    const subscriptions = targetUserId === undefined && effectiveSourceId
      ? await this.getAllSubscriptionsAsync(effectiveSourceId)
      : await this.getAllSubscriptionsAsync();
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.debug(`📢 Broadcasting ${preferenceKey} notification to ${subscriptions.length} subscriptions${targetUserId ? ` (target user: ${targetUserId})` : ''}`);

    // Get local node name for prefix
    // First try the live connection, then fall back to database (for startup before connection)
    let localNodeName: string | null = null;
    const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const localNodeInfo = mgr.getLocalNodeInfo();
    if (localNodeInfo?.longName) {
      localNodeName = localNodeInfo.longName;
    } else {
      // Fall back to database - get localNodeNum from settings and look up the node
      const localNodeNumStr = await databaseService.settings.getLocalNodeNumForSource(mgr.sourceId);
      if (localNodeNumStr) {
        const localNodeNum = parseInt(localNodeNumStr, 10);
        const localNode = await databaseService.nodesRepo?.getNode(localNodeNum, mgr.sourceId);
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

      // Phase C: per-source permission check
      if (effectiveSourceId) {
        try {
          const allowed = await databaseService.checkPermissionAsync(userId, 'messages', 'read', effectiveSourceId);
          if (!allowed) {
            filtered++;
            continue;
          }
        } catch (err) {
          logger.error(`Permission check failed for user ${userId}:`, err);
          filtered++;
          continue;
        }
      }

      // #4020: the targeted alert pipeline (low-battery, inactive-node) already
      // decided this user should be notified — the check service is the sole
      // authority on intent, so we must not re-gate on prefs[preferenceKey]
      // here (that flag can live on a DIFFERENT (userId, sourceId) row than
      // the one whose subscription we're about to send to, and re-checking it
      // against effectiveSourceId's row alone was exactly how alerts silently
      // vanished). We still require a channel to actually be usable: any of
      // the user's rows has enableWebPush true (an existing subscription is
      // already guaranteed since we're iterating this user's subscriptions).
      if (targetUserId !== undefined) {
        const rows = await databaseService.notifications.getUserPreferenceRows(userId);
        const hasWebPush = rows.some((r) => r.prefs.enableWebPush);
        if (!hasWebPush) {
          filtered++;
          continue;
        }
      } else {
        // Untargeted broadcasts (new node, traceroute, server events) keep the
        // original single-row, single-source gate.
        const prefs = await getUserNotificationPreferencesAsync(userId, effectiveSourceId);
        if (!prefs || !prefs.enableWebPush || !prefs[preferenceKey]) {
          filtered++;
          continue;
        }
      }

      // Cross-source dedup (#5729), after every gate above passed for this
      // recipient. Same three outcomes as `broadcastWithFiltering`. An event
      // with no `merged` text cannot name several sources, so its later
      // copies are dropped.
      const recipient = pushDedupRecipient(subscription);
      const dedupSourceId = effectiveSourceId ?? '';
      let claim: DedupClaim | null = null;
      let base: PushNotificationPayload = payload;
      if (payload.dedup) {
        claim = notificationDedup.claim(recipient, payload.dedup.key, {
          sourceId: dedupSourceId,
          sourceName: payload.sourceName ?? dedupSourceId,
        });
        if (claim.outcome === 'duplicate' || (claim.outcome === 'additional' && !payload.dedup.merged)) {
          filtered++;
          continue;
        }
        base = { ...payload, tag: dedupTag(payload.dedup.key), renotify: false };
        if (claim.outcome === 'additional' && payload.dedup.merged) {
          const merged = payload.dedup.merged(claim.sources.map(s => s.sourceName));
          base = { ...base, title: merged.title, body: merged.body, silent: true };
        }
      }

      // Apply node name prefix if user has it enabled
      const prefixedBody = await applyNodeNamePrefixAsync(userId, base.body, localNodeName, effectiveSourceId);
      const notificationPayload = prefixedBody !== base.body
        ? { ...base, body: prefixedBody }
        : base;

      const success = await this.sendToSubscription(subscription, notificationPayload);
      if (success) {
        sent++;
      } else {
        failed++;
        if (payload.dedup && claim?.outcome === 'first') {
          notificationDedup.release(recipient, payload.dedup.key, dedupSourceId);
        }
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
