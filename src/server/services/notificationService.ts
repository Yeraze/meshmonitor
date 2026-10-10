import { logger } from '../../utils/logger.js';
import { getHardwareModelName } from '../../utils/nodeHelpers.js';
import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService, AppriseNotificationPayload } from './appriseNotificationService.js';
import { desktopNotificationService } from './desktopNotificationService.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';

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
  /**
   * Message notifications only (#5593). When set, each delivery wrapper
   * renders the recipient's own title/body template from these values AFTER
   * its filter decision; `title`/`body` above are then only a fallback.
   */
  message?: MessageTemplateContext;
}

export interface NotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
  viaMqtt?: boolean;
  /** #5720: the packet is a protocol tapback (Meshtastic `emoji === 1`). */
  isTapback?: boolean;
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
              sourceName: payload.sourceName,
              message: payload.message
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
              sourceName: payload.sourceName,
              message: payload.message
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
      // #4845: title carries the service, body says which instance detected it.
      const payload: NotificationPayload = {
        title: `New Meshtastic Node Detected`,
        body: `${longName} (${shortName}) detected by ${sourceName}${hwModelText}${hopsText}`,
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
   * Send a "new node discovered" notification for a MeshCore source
   * (bypasses normal filtering). Only sends if the user has notifyOnNewNode
   * enabled for this source. MeshCore advertises a display name and a device
   * type (Companion / Repeater / Room Server) but has no Meshtastic-style
   * shortName, hardware model, or hops-away count, so the payload is built from
   * the fields MeshCore actually provides. The caller is responsible for
   * firing this only the first time a node is discovered (see meshcoreManager
   * contact-advert handling), so there is no incomplete→complete gating here.
   */
  public async notifyNewMeshCoreNode(
    publicKey: string,
    displayName: string,
    deviceTypeLabel: string | undefined,
    sourceId: string,
    sourceName: string
  ): Promise<void> {
    try {
      const typeText = deviceTypeLabel ? ` - ${deviceTypeLabel}` : '';
      // #4845: title carries the service, body says which instance detected it.
      const payload: NotificationPayload = {
        title: `New MeshCore Device Detected`,
        body: `${displayName} detected by ${sourceName}${typeText}`,
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

      logger.info(`📤 Sent new MeshCore node notification for ${displayName} [${publicKey.substring(0, 16)}…] on ${sourceId}`);
    } catch (error) {
      logger.error('❌ Error sending new MeshCore node notification:', error);
    }
  }

  /**
   * Send notification for successful traceroute (bypasses normal filtering)
   * Only sends if user has notifyOnTraceroute enabled
   *
   * `fromNodeId` is the node that ASKED and `toNodeId` the node that answered,
   * so the title reads the way the trace ran. The caller holds a reply
   * packet, whose own from/to are the other way round.
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
        // Source once (#5593): on the body, where a long node pair in the
        // title cannot push it off the screen.
        title: `🗺️ Traceroute: ${fromNodeId} → ${toNodeId}`,
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
   *
   * #4020: returns an aggregated sent/failed/filtered count across all
   * sub-services so callers (e.g. lowBatteryNotificationService,
   * inactiveNodeNotificationService) can tell whether a matched alert
   * actually reached anyone, instead of firing-and-forgetting.
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnLowBattery' | 'notifyOnServerEvents' | 'notifyOnWaypoint',
    payload: NotificationPayload,
    targetUserId?: number
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    // Send to users with the preference enabled, scoped to the payload's sourceId
    const results = await Promise.allSettled([
      pushNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, targetUserId, payload.sourceId),
      appriseNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, targetUserId, payload.sourceId),
      desktopNotificationService.broadcastToPreferenceUsers(preferenceKey, payload, payload.sourceId)
    ]);

    const totals = { sent: 0, failed: 0, filtered: 0 };
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        totals.sent += result.value.sent ?? 0;
        totals.failed += result.value.failed ?? 0;
        totals.filtered += result.value.filtered ?? 0;
      }
    }
    return totals;
  }
}

export const notificationService = new NotificationService();
