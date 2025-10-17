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
}

export const notificationService = new NotificationService();
