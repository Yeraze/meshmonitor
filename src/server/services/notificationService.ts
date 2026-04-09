import { logger } from '../../utils/logger.js';
import { getHardwareModelName } from '../../utils/nodeHelpers.js';
import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService, AppriseNotificationPayload } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';

export interface NotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name used to prefix title/body. */
  sourceName: string;
  /** Navigation data for push notifications - allows opening specific channel/DM when clicked */
  data?: {
    type: 'channel' | 'dm';
    channelId?: number;
    messageId?: string;
    senderNodeId?: string;
  };
}

export interface NotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
  viaMqtt?: boolean;
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name. */
  sourceName: string;
}

export interface BroadcastResult {
  webPush: {
    sent: number;
    failed: number;
    filtered: number;
  };
  apprise: {
    sent: number;
    failed: number;
    filtered: number;
  };
  total: {
    sent: number;
    failed: number;
    filtered: number;
  };
}

/**
 * Unified Notification Service
 *
 * Dispatches notifications to both Web Push and Apprise based on user preferences.
 * Users can enable/disable each service independently, and both use the same filtering logic.
 */
class NotificationService {
  /**
   * Broadcast a notification to all enabled notification services
   * Automatically routes to Web Push and/or Apprise based on user preferences
   */
  public async broadcast(
    payload: NotificationPayload,
    filterContext: NotificationFilterContext
  ): Promise<BroadcastResult> {
    logger.debug(`📢 Broadcasting notification: "${payload.title}"`);

    // Dispatch to all services in parallel
    const results = await Promise.allSettled([
      // Web Push
      pushNotificationService.isAvailable()
        ? pushNotificationService.broadcastWithFiltering(payload, filterContext)
        : Promise.resolve({ sent: 0, failed: 0, filtered: 0 }),

      // Apprise
      appriseNotificationService.isAvailable()
        ? appriseNotificationService.broadcastWithFiltering(
            {
              title: payload.title,
              body: payload.body,
              type: payload.type,
              sourceId: payload.sourceId,
              sourceName: payload.sourceName
            } as AppriseNotificationPayload,
            filterContext
          )
        : Promise.resolve({ sent: 0, failed: 0, filtered: 0 }),

      // Desktop (native OS notifications)
      desktopNotificationService.isAvailable()
        ? desktopNotificationService.broadcastWithFiltering(
            {
              title: payload.title,
              body: payload.body,
              type: payload.type,
              sourceId: payload.sourceId,
              sourceName: payload.sourceName
            },
            filterContext
          )
        : Promise.resolve({ sent: 0, failed: 0, filtered: 0 })
    ]);

    // Extract results (handling rejections gracefully)
    const webPushResult = results[0].status === 'fulfilled'
      ? results[0].value
      : { sent: 0, failed: 0, filtered: 0 };

    const appriseResult = results[1].status === 'fulfilled'
      ? results[1].value
      : { sent: 0, failed: 0, filtered: 0 };

    const desktopResult = results[2].status === 'fulfilled'
      ? results[2].value
      : { sent: 0, failed: 0, filtered: 0 };

    // Log any failures
    if (results[0].status === 'rejected') {
      logger.error('❌ Web Push broadcast failed:', results[0].reason);
    }
    if (results[1].status === 'rejected') {
      logger.error('❌ Apprise broadcast failed:', results[1].reason);
    }
    if (results[2].status === 'rejected') {
      logger.error('❌ Desktop notification broadcast failed:', results[2].reason);
    }

    // Calculate totals
    const total = {
      sent: webPushResult.sent + appriseResult.sent + desktopResult.sent,
      failed: webPushResult.failed + appriseResult.failed + desktopResult.failed,
      filtered: webPushResult.filtered + appriseResult.filtered + desktopResult.filtered
    };

    logger.info(
      `📊 Broadcast complete: ${total.sent} sent, ${total.failed} failed, ${total.filtered} filtered ` +
      `(Push: ${webPushResult.sent}/${webPushResult.failed}/${webPushResult.filtered}, ` +
      `Apprise: ${appriseResult.sent}/${appriseResult.failed}/${appriseResult.filtered}, ` +
      `Desktop: ${desktopResult.sent}/${desktopResult.failed}/${desktopResult.filtered})`
    );

    return {
      webPush: webPushResult,
      apprise: appriseResult,
      total
    };
  }

  /**
   * Get availability status of notification services
   */
  public getServiceStatus(): {
    webPush: boolean;
    apprise: boolean;
    anyAvailable: boolean;
  } {
    const webPush = pushNotificationService.isAvailable();
    const apprise = appriseNotificationService.isAvailable();

    return {
      webPush,
      apprise,
      anyAvailable: webPush || apprise
    };
  }

  /**
   * Send notification for newly discovered node (bypasses normal filtering)
   * Only sends if user has notifyOnNewNode enabled.
   * Called when a node transitions from incomplete to complete (has longName, shortName, hwModel).
   */
  public async notifyNewNode(
    nodeId: string,
    longName: string,
    shortName: string,
    hwModel: number | undefined,
    hopsAway: number | undefined,
    sourceId: string,
    sourceName: string
  ): Promise<void> {
    try {
      const hopsText = hopsAway !== undefined ? ` (${hopsAway} ${hopsAway === 1 ? 'hop' : 'hops'} away)` : '';
      const hwModelText = hwModel !== undefined ? ` - ${getHardwareModelName(hwModel) || 'Unknown'}` : '';
      const payload: NotificationPayload = {
        title: `[${sourceName}] 🆕 New Node Discovered`,
        body: `[${sourceName}] ${longName} (${shortName})${hwModelText}${hopsText}`,
        type: 'info',
        sourceId,
        sourceName
      };

      // Send to users with notifyOnNewNode enabled, scoped to this source
      await Promise.allSettled([
        pushNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', payload, undefined, sourceId),
        appriseNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', payload, undefined, sourceId),
        desktopNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', payload, sourceId)
      ]);

      logger.info(`📤 Sent new node notification for ${longName} (${shortName}) [${nodeId}] on ${sourceId}`);
    } catch (error) {
      logger.error('❌ Error sending new node notification:', error);
    }
  }

  /**
   * Send notification for successful traceroute (bypasses normal filtering)
   * Only sends if user has notifyOnTraceroute enabled
   */
  public async notifyTraceroute(
    fromNodeId: string,
    toNodeId: string,
    routeText: string,
    sourceId: string,
    sourceName: string
  ): Promise<void> {
    try {
      const payload: NotificationPayload = {
        title: `[${sourceName}] 🗺️ Traceroute: ${fromNodeId} → ${toNodeId}`,
        body: `[${sourceName}] ${routeText}`,
        type: 'success',
        sourceId,
        sourceName
      };

      // Send to users with notifyOnTraceroute enabled, scoped to this source
      await Promise.allSettled([
        pushNotificationService.broadcastToPreferenceUsers('notifyOnTraceroute', payload, undefined, sourceId),
        appriseNotificationService.broadcastToPreferenceUsers('notifyOnTraceroute', payload, undefined, sourceId),
        desktopNotificationService.broadcastToPreferenceUsers('notifyOnTraceroute', payload, sourceId)
      ]);

      logger.info(`📤 Sent traceroute notification for ${fromNodeId} → ${toNodeId} on ${sourceId}`);
    } catch (error) {
      logger.error('❌ Error sending traceroute notification:', error);
    }
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Phase C: scoped to a specific sourceId (preferences and permissions are per-source)
   * Optionally target a specific user ID
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnServerEvents',
    payload: NotificationPayload,
    targetUserId?: number
  ): Promise<void> {
    // Send to users with the preference enabled, scoped to the payload's sourceId
    await Promise.allSettled([
      pushNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, targetUserId, payload.sourceId),
      appriseNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, targetUserId, payload.sourceId),
      desktopNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, payload.sourceId)
    ]);
  }
}

export const notificationService = new NotificationService();
