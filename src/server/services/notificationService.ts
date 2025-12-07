import { logger } from '../../utils/logger.js';
import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService, AppriseNotificationPayload } from './appriseNotificationService.js';

export interface NotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
}

export interface NotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
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

    // Dispatch to both services in parallel
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
              type: payload.type
            } as AppriseNotificationPayload,
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

    // Log any failures
    if (results[0].status === 'rejected') {
      logger.error('❌ Web Push broadcast failed:', results[0].reason);
    }
    if (results[1].status === 'rejected') {
      logger.error('❌ Apprise broadcast failed:', results[1].reason);
    }

    // Calculate totals
    const total = {
      sent: webPushResult.sent + appriseResult.sent,
      failed: webPushResult.failed + appriseResult.failed,
      filtered: webPushResult.filtered + appriseResult.filtered
    };

    logger.info(
      `📊 Broadcast complete: ${total.sent} sent, ${total.failed} failed, ${total.filtered} filtered ` +
      `(Push: ${webPushResult.sent}/${webPushResult.failed}/${webPushResult.filtered}, ` +
      `Apprise: ${appriseResult.sent}/${appriseResult.failed}/${appriseResult.filtered})`
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
   * Only sends if user has notifyOnNewNode enabled
   */
  public async notifyNewNode(nodeId: string, longName: string, hopsAway: number | undefined): Promise<void> {
    try {
      const hopsText = hopsAway !== undefined ? ` (${hopsAway} ${hopsAway === 1 ? 'hop' : 'hops'} away)` : '';
      const payload: NotificationPayload = {
        title: '🆕 New Node Discovered',
        body: `${longName || nodeId}${hopsText}`,
        type: 'info'
      };

      // Send to users with notifyOnNewNode enabled
      await Promise.allSettled([
        pushNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', payload),
        appriseNotificationService.broadcastToPreferenceUsers('notifyOnNewNode', payload)
      ]);

      logger.info(`📤 Sent new node notification for ${nodeId}`);
    } catch (error) {
      logger.error('❌ Error sending new node notification:', error);
    }
  }

  /**
   * Send notification for successful traceroute (bypasses normal filtering)
   * Only sends if user has notifyOnTraceroute enabled
   */
  public async notifyTraceroute(fromNodeId: string, toNodeId: string, routeText: string): Promise<void> {
    try {
      const payload: NotificationPayload = {
        title: `🗺️ Traceroute: ${fromNodeId} → ${toNodeId}`,
        body: routeText,
        type: 'success'
      };

      // Send to users with notifyOnTraceroute enabled
      await Promise.allSettled([
        pushNotificationService.broadcastToPreferenceUsers('notifyOnTraceroute', payload),
        appriseNotificationService.broadcastToPreferenceUsers('notifyOnTraceroute', payload)
      ]);

      logger.info(`📤 Sent traceroute notification for ${fromNodeId} → ${toNodeId}`);
    } catch (error) {
      logger.error('❌ Error sending traceroute notification:', error);
    }
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Optionally target a specific user ID
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode',
    payload: NotificationPayload,
    targetUserId?: number
  ): Promise<void> {
    // Send to users with the preference enabled
    await Promise.allSettled([
      pushNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, targetUserId),
      appriseNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, targetUserId)
    ]);
  }
}

export const notificationService = new NotificationService();
