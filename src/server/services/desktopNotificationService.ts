/**
 * Desktop Notification Service
 *
 * Sends native OS notifications via node-notifier when running in the
 * Tauri desktop app (IS_DESKTOP=true). Integrates with the unified
 * notification pipeline alongside web push and Apprise.
 *
 * Uses the same user preference filtering as web push — the enableWebPush
 * preference controls desktop notifications in desktop mode.
 */

import notifier from 'node-notifier';
import path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { shouldFilterNotificationAsync, getUserNotificationPreferencesAsync, renderMessagePayloadForUserAsync } from '../utils/notificationFiltering.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';
import { notificationDedup, type NotificationDedupSpec } from './notificationDedup.js';

/**
 * Dedup recipient for the desktop app (#5729): the one machine. A desktop
 * notification is shown once, for the first user who passes, so the machine
 * is the unit, not the user. It never lists sources (see `claimDesktop`), so
 * a shared key cannot show one user another user's source.
 */
const DESKTOP_DEDUP_RECIPIENT = 'desktop';

export interface DesktopNotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name used to prefix title/body. */
  sourceName: string;
  /**
   * Message notifications only (#5593): the values `broadcastWithFiltering`
   * renders the recipient's title/body template from.
   */
  message?: MessageTemplateContext;
  /** Cross-source dedup (#5729); see `notificationDedup.ts`. */
  dedup?: NotificationDedupSpec;
}

export interface DesktopNotificationFilterContext {
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

class DesktopNotificationService {
  private enabled = false;

  constructor() {
    // Enable if running in desktop/Tauri mode (IS_DESKTOP is set by lib.rs)
    this.enabled = process.env.IS_DESKTOP === 'true' ||
                   process.env.ENABLE_DESKTOP_NOTIFICATIONS === 'true';

    if (this.enabled) {
      logger.info('🖥️ Desktop notification service enabled');
    }
  }

  isAvailable(): boolean {
    return this.enabled;
  }

  /**
   * Cross-source dedup (#5729). node-notifier cannot replace a notification
   * it has already shown, so the desktop sends the first copy only; that copy
   * names the source that heard the packet first. True = send it.
   */
  private claimDesktop(payload: DesktopNotificationPayload, sourceId: string): boolean {
    if (!payload.dedup) return true;
    const claim = notificationDedup.claim(DESKTOP_DEDUP_RECIPIENT, payload.dedup.key, {
      sourceId,
      sourceName: payload.sourceName,
    });
    return claim.outcome === 'first';
  }

  /**
   * Send a native OS notification
   */
  private send(payload: DesktopNotificationPayload, releaseSourceId?: string): void {
    try {
      notifier.notify({
        title: payload.title,
        message: payload.body,
        icon: path.join(process.cwd(), 'public', 'logo.png'),
        sound: true,
        wait: false,
      });
      logger.debug(`🖥️ Desktop notification sent: ${payload.title}`);
    } catch (error) {
      logger.error('❌ Failed to send desktop notification:', error);
      // A first copy that was never shown must not block another source's
      // copy (#5729), the same as the Web Push and Apprise paths.
      if (payload.dedup && releaseSourceId !== undefined) {
        notificationDedup.release(DESKTOP_DEDUP_RECIPIENT, payload.dedup.key, releaseSourceId);
      }
    }
  }

  /**
   * Broadcast notification with user preference filtering.
   * Iterates over all users, applies filtering, sends once (single desktop machine).
   */
  async broadcastWithFiltering(
    payload: DesktopNotificationPayload,
    filterContext: DesktopNotificationFilterContext
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    if (!this.enabled) return { sent: 0, failed: 0, filtered: 0 };

    let filtered = 0;

    try {
      const users = await databaseService.auth.getAllUsers();

      for (const user of users) {
        if (!user.isActive) continue;

        // Phase B: permission check — user must have messages:read on this source
        try {
          const allowed = await databaseService.checkPermissionAsync(user.id, 'messages', 'read', filterContext.sourceId);
          if (!allowed) {
            filtered++;
            continue;
          }
        } catch (error) {
          logger.error(`Permission check failed for user ${user.id}:`, error);
          filtered++;
          continue;
        }

        // Check if user has web push enabled (controls desktop notifications too) — per-source
        const prefs = await getUserNotificationPreferencesAsync(user.id, filterContext.sourceId);
        if (!prefs || !prefs.enableWebPush) continue;

        // Apply same filtering as web push
        if (await shouldFilterNotificationAsync(user.id, filterContext)) {
          filtered++;
          continue;
        }

        // Dedup AFTER the filter decision (#5729): a copy no user would have
        // been shown must not use up the event.
        if (!this.claimDesktop(payload, filterContext.sourceId)) {
          return { sent: 0, failed: 0, filtered: filtered + 1 };
        }

        // Render AFTER the filter decision (#5593), with the templates of the
        // user this single desktop notification is sent for.
        const rendered = await renderMessagePayloadForUserAsync(user.id, payload, filterContext.sourceId, filterContext.sourceName);
        this.send({ ...payload, title: rendered.title, body: rendered.body }, filterContext.sourceId);
        // Only send once — single desktop machine
        return { sent: 1, failed: 0, filtered };
      }

      return { sent: 0, failed: 0, filtered };
    } catch (error) {
      logger.error('❌ Desktop notification broadcast error:', error);
      return { sent: 0, failed: 1, filtered };
    }
  }

  /**
   * Broadcast to users with a specific preference enabled (e.g., notifyOnNewNode).
   */
  async broadcastToPreferenceUsers(
    preferenceName: string,
    payload: DesktopNotificationPayload,
    sourceId?: string
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    if (!this.enabled) return { sent: 0, failed: 0, filtered: 0 };

    // Phase C: scope preference broadcasts by sourceId
    const effectiveSourceId = sourceId ?? payload.sourceId;
    try {
      const users = await databaseService.auth.getAllUsers();

      for (const user of users) {
        if (!user.isActive) continue;

        // Phase C: per-source permission check
        if (effectiveSourceId) {
          try {
            const allowed = await databaseService.checkPermissionAsync(user.id, 'messages', 'read', effectiveSourceId);
            if (!allowed) continue;
          } catch (err) {
            logger.error(`Permission check failed for user ${user.id}:`, err);
            continue;
          }
        }

        const prefs = await getUserNotificationPreferencesAsync(user.id, effectiveSourceId);
        if (!prefs || !prefs.enableWebPush) continue;
        if (!(prefs as any)[preferenceName]) continue;

        if (!this.claimDesktop(payload, effectiveSourceId ?? payload.sourceId)) {
          return { sent: 0, failed: 0, filtered: 1 };
        }

        this.send(payload, effectiveSourceId ?? payload.sourceId);
        // Only send once — single desktop machine
        return { sent: 1, failed: 0, filtered: 0 };
      }

      return { sent: 0, failed: 0, filtered: 0 };
    } catch (error) {
      logger.error('❌ Desktop notification preference broadcast error:', error);
      return { sent: 0, failed: 1, filtered: 0 };
    }
  }
}

export const desktopNotificationService = new DesktopNotificationService();
