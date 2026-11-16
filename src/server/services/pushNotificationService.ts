import * as webpush from 'web-push';
import { getEnvironmentConfig } from '../config/environment.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import type { DbPushSubscription } from '../../db/types.js';
import { fitWebPushPayload } from '../utils/pushPayloadSize.js';
import { getUserNotificationPreferencesAsync, shouldFilterNotificationAsync, applyNodeNamePrefixAsync, renderMessagePayloadForUserAsync, messageReadableByUserAsync, payloadBlockedForUserAsync, pushSourceAllowedAsync, userReadsAnySourceAsync, type NotificationMuteVenue } from '../utils/notificationFiltering.js';
import { MESH_PREFERENCES_SOURCE_ID } from '../../utils/notificationDefaults.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';
import { resolveLocalNodeNameForSource } from '../utils/localNodeNameForSource.js';
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
  /**
   * MeshCore keyed channel message (#5551): only recipients with access to this
   * channel key get the event. Server-side input; never sent on the wire.
   */
  keyFingerprint?: string | null;
  /**
   * Venue of an event that follows a mute (a mention): a recipient who muted
   * it is skipped. Server-side input; never sent on the wire.
   */
  muteVenue?: NotificationMuteVenue;
  /**
   * New-node alert (#5729, decision 5): sources where this node was already
   * known before this source announced it. A recipient who can read any of
   * them heard of the node from there first and is skipped. Server-side
   * input; never sent on the wire.
   */
  knownOnSourceIds?: string[];
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

/**
 * The anonymous account's id, for a subscription row with no user. One
 * subscription now covers the whole mesh (#5729), so such a row is gated per
 * source by what the anonymous account may read. Null = no active anonymous
 * account: the row gets nothing.
 */
async function resolveAnonymousUserIdAsync(): Promise<number | null> {
  try {
    const anon = await databaseService.findUserByUsernameAsync('anonymous');
    return anon && anon.isActive ? anon.id : null;
  } catch (error) {
    logger.error('Failed to resolve the anonymous account for push gating:', error);
    return null;
  }
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

      // One subscription per browser for the whole mesh (#5729): `sourceId`
      // only proved the caller may read a source; the row is mesh-wide and
      // the user's preferences decide which sources notify.
      await databaseService.notificationsRepo.saveSubscription({
        userId: userId ?? null,
        sourceId: MESH_PREFERENCES_SOURCE_ID,
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
   * Move a browser's rows from its old push endpoint to its new one (#5863).
   *
   * The service worker's `pushsubscriptionchange` handler cannot know which
   * sources the browser subscribed on, but the server does: it copies each
   * row's user and source to the new endpoint, then drops the old rows.
   *
   * A row owned by a user moves only when that same user asks, so holding an
   * old endpoint URL is not enough to redirect someone's notifications.
   * Anonymous rows move on the endpoint alone, the same proof
   * `/unsubscribe-all` relies on.
   */
  public async renewSubscription(
    oldEndpoint: string,
    subscription: PushSubscription,
    requesterUserId: number | undefined,
    userAgent: string | undefined,
  ): Promise<{ renewed: number; skipped: number }> {
    const repo = databaseService.notificationsRepo;
    if (!repo) {
      throw new Error('Notifications repository not initialized');
    }
    const keys = subscription.keys;
    if (!keys || !keys.p256dh || !keys.auth) {
      throw new Error('Invalid subscription: missing keys');
    }

    const rows = await repo.getSubscriptionsByEndpoint(oldEndpoint);
    let renewed = 0;
    let skipped = 0;
    for (const row of rows) {
      const owner = row.userId ?? null;
      if (!row.sourceId || (owner !== null && owner !== (requesterUserId ?? null))) {
        skipped++;
        continue;
      }
      // Write the new row before removing the old one, so a failure part way
      // through never leaves the browser with no row at all.
      await repo.saveSubscription({
        userId: owner,
        sourceId: row.sourceId,
        endpoint: subscription.endpoint,
        p256dhKey: keys.p256dh,
        authKey: keys.auth,
        userAgent: userAgent ?? row.userAgent ?? null,
      });
      if (oldEndpoint !== subscription.endpoint) {
        await repo.removeSubscriptionRow(oldEndpoint, row.sourceId, owner);
      }
      renewed++;
    }

    logger.info(`🔄 Renewed push subscription: ${renewed} row(s) moved, ${skipped} skipped`);
    return { renewed, skipped };
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
      delete wirePayload.keyFingerprint;
      delete wirePayload.muteVenue;
      delete wirePayload.knownOnSourceIds;

      await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(fitWebPushPayload(wirePayload)),
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
      /** MeshCore keyed channel message (#5551): recipient needs access to this key. */
      keyFingerprint?: string | null;
      /** DM / room mute key (`mutedDMs.nodeUuid`), so a per-DM mute applies. */
      nodeUuid?: string;
      sourceId: string;
      sourceName: string;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    // One subscription per browser for the whole mesh (#5729): every row is a
    // candidate, and each is gated below on this source's permission, the
    // user's preferences and their push source list.
    const subscriptions = await this.getAllSubscriptionsAsync();
    const anonymousUserId = subscriptions.some(sub => !sub.userId) ? await resolveAnonymousUserIdAsync() : null;
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.debug(`📢 Broadcasting push notification for source ${filterContext.sourceId} to ${subscriptions.length} subscriptions with filtering`);

    // Prefix names the node of the source this message arrived on (#6251).
    const localNodeName = await resolveLocalNodeNameForSource(filterContext.sourceId);

    for (const subscription of subscriptions) {
      // Get user preferences
      const userId = subscription.userId;

      // Skip if user should be filtered
      if (await this.shouldFilterNotificationAsync(userId, filterContext, anonymousUserId)) {
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
          navData: payload.data,
        });
        if (claim.outcome === 'duplicate') {
          filtered++;
          continue;
        }
      }
      const isUpdate = claim?.outcome === 'additional';
      // An update keeps the look of the notification it replaces: the first
      // source's templates and prefix setting, with every source named.
      // `claim.sources` is in arrival order (the store only appends), so [0]
      // is the source whose copy was shown first, not the current one.
      const renderSourceId = isUpdate && claim ? claim.sources[0].sourceId : filterContext.sourceId;
      const shownSourceName = isUpdate && claim ? joinSourceNames(claim.sources) : filterContext.sourceName;
      const renderInput = isUpdate && payload.message
        ? { ...payload, message: { ...payload.message, sourceName: shownSourceName } }
        : payload;

      // Render AFTER the filter decision (#5593): the user's templates shape
      // the text only, never whether a notification is sent.
      const rendered = await renderMessagePayloadForUserAsync(userId, renderInput, renderSourceId, shownSourceName, 'push');

      // Apply node name prefix if user has it enabled (per-source prefs)
      const body = await applyNodeNamePrefixAsync(userId, rendered.body, localNodeName, renderSourceId);
      // `message` and `dedup` are server-side inputs, not wire data: keep them
      // out of the push payload.
      const notificationPayload: PushNotificationPayload = { ...payload, title: rendered.title, body };
      delete notificationPayload.message;
      delete notificationPayload.dedup;
      delete notificationPayload.keyFingerprint;
      delete notificationPayload.muteVenue;
      if (payload.dedup) {
        notificationPayload.tag = dedupTag(payload.dedup.key);
        notificationPayload.renotify = false;
        if (isUpdate) notificationPayload.silent = true;
        // A click opens the source that heard it FIRST (#5729, decision 3),
        // not whichever source's copy last updated the notification.
        if (isUpdate && claim && claim.sources[0].navData !== undefined) {
          notificationPayload.data = claim.sources[0].navData;
        }
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
    subscriptionUserId: number | null | undefined,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
      viaMqtt?: boolean;
      /** #5720: the packet is a protocol tapback (Meshtastic `emoji === 1`). */
      isTapback?: boolean;
      /** MeshCore keyed channel message (#5551): recipient needs access to this key. */
      keyFingerprint?: string | null;
      /** DM / room mute key (`mutedDMs.nodeUuid`), so a per-DM mute applies. */
      nodeUuid?: string;
      sourceId: string;
      sourceName: string;
    },
    anonymousUserId: number | null,
  ): Promise<boolean> {
    // A row with no user (subscribed before the anonymous account existed)
    // gets no preference filtering — it opted in by subscribing — but one row
    // now covers the whole mesh (#5729), so it is gated per source on what
    // the anonymous account may read. A keyed MeshCore message never reaches
    // it: it has no key access.
    if (!subscriptionUserId) {
      if (filterContext.keyFingerprint) {
        logger.debug('Anonymous user - keyed message filtered');
        return true;
      }
      if (anonymousUserId === null) return true;
      try {
        const allowed = await databaseService.checkPermissionAsync(anonymousUserId, 'messages', 'read', filterContext.sourceId);
        return !allowed;
      } catch (error) {
        logger.error(`Anonymous permission check failed on source ${filterContext.sourceId}:`, error);
        return true;
      }
    }
    const userId = subscriptionUserId;

    // Phase B: permission check — user must have messages:read on this source
    // and, for a keyed MeshCore message, access to its channel key.
    if (!(await messageReadableByUserAsync(userId, filterContext.sourceId, filterContext.keyFingerprint))) {
      logger.debug(`🔒 User ${userId} cannot read this message on source ${filterContext.sourceId}`);
      return true;
    }

    // Check if user has web push enabled (per-source preferences)
    const prefs = await getUserNotificationPreferencesAsync(userId, filterContext.sourceId);
    if (prefs && !prefs.enableWebPush) {
      logger.debug(`🔇 Web Push disabled for user ${userId} on source ${filterContext.sourceId}`);
      return true; // Filter - user has disabled web push
    }

    // The user's push source list (#5729): the filter that used to be "which
    // sources this browser subscribed on".
    if (!(await pushSourceAllowedAsync(userId, filterContext.sourceId))) {
      logger.debug(`🔇 Source ${filterContext.sourceId} not in user ${userId}'s Web Push sources`);
      return true;
    }

    // Use shared filtering utility (will re-check permission, prefs per source)
    return shouldFilterNotificationAsync(userId, filterContext);
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Used for special notifications like new nodes, traceroutes, and inactive nodes
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnLowBattery' | 'notifyOnServerEvents' | 'notifyOnWaypoint' | 'notifyOnMention' | 'notifyOnAutoTrace',
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
    //
    // #5729: a subscription now covers the whole mesh, so "subscribed on that
    // source" is the user's push source list, checked per row below.
    const subscriptions = await this.getAllSubscriptionsAsync();
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    logger.debug(`📢 Broadcasting ${preferenceKey} notification to ${subscriptions.length} subscriptions${targetUserId ? ` (target user: ${targetUserId})` : ''}`);

    // Prefix names the node of the source the notification is about, not
    // the primary Meshtastic source (#6251).
    const localNodeName = await resolveLocalNodeNameForSource(effectiveSourceId);

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

      // Keyed MeshCore message / muted venue (mentions): a gate on the payload.
      if ((payload.keyFingerprint || payload.muteVenue) && await payloadBlockedForUserAsync(userId, effectiveSourceId, payload)) {
        filtered++;
        continue;
      }

      // New node already known on a source this user reads (#5729).
      if (await userReadsAnySourceAsync(userId, payload.knownOnSourceIds)) {
        filtered++;
        continue;
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
        if (effectiveSourceId && !(await pushSourceAllowedAsync(userId, effectiveSourceId))) {
          filtered++;
          continue;
        }
      }

      // Cross-source dedup (#5729), after every gate above passed for this
      // recipient. Same three outcomes as `broadcastWithFiltering`. An event
      // with no `merged` text cannot name several sources, so its later
      // copies are dropped.
      const recipient = pushDedupRecipient(subscription);
      // Every caller that sets `dedup` also sets a source. '' is only the
      // fallback for a payload with none; all such copies then read as one
      // source, so they collapse to the first and no source list is built.
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
      const prefixed = prefixedBody !== base.body
        ? { ...base, body: prefixedBody }
        : base;
      // Server-side gate inputs stay off the wire (sendToSubscription strips
      // them too; this keeps the payload clean at the call boundary).
      const { keyFingerprint: _kf, muteVenue: _mv, knownOnSourceIds: _ko, ...notificationPayload } = prefixed;

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
