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
import { shouldFilterNotificationAsync, getUserNotificationPreferencesAsync } from '../utils/notificationFiltering.js';

export interface DesktopNotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name used to prefix title/body. */
  sourceName: string;
}

export interface DesktopNotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
  viaMqtt?: boolean;
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
   * Send a native OS notification
   */
  private send(payload: DesktopNotificationPayload): void {
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

    // Phase B: prefix title with source name (body kept clean — title already disambiguates source)
    const prefixedPayload: DesktopNotificationPayload = {
      ...payload,
      title: `[${filterContext.sourceName}] ${payload.title}`,
    };

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

        this.send(prefixedPayload);
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

        this.send(payload);
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
