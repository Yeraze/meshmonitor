import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { getUserNotificationPreferences, getUsersWithServiceEnabled, shouldFilterNotification as shouldFilterNotificationUtil } from '../utils/notificationFiltering.js';

export interface AppriseNotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
}

interface AppriseConfig {
  url: string;
  enabled: boolean;
}

class AppriseNotificationService {
  private config: AppriseConfig | null = null;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    // Default to internal Apprise API (bundled in container)
    const appriseUrl = databaseService.getSetting('apprise_url') || 'http://localhost:8000';
    const enabledSetting = databaseService.getSetting('apprise_enabled');

    // Default to enabled if not explicitly set (backward compatibility)
    const enabled = enabledSetting !== 'false';

    // If not set, initialize it to 'true'
    if (enabledSetting === null || enabledSetting === undefined) {
      databaseService.setSetting('apprise_enabled', 'true');
    }

    this.config = {
      url: appriseUrl,
      enabled
    };

    if (enabled) {
      logger.info(`✅ Apprise notification service configured at ${appriseUrl}`);
    } else {
      logger.debug('ℹ️  Apprise notifications disabled');
    }
  }

  /**
   * Check if Apprise is configured and enabled
   */
  public isAvailable(): boolean {
    return this.config !== null && this.config.enabled;
  }

  /**
   * Test connection to Apprise API
   */
  public async testConnection(): Promise<{ success: boolean; message: string; details?: any }> {
    if (!this.config) {
      return { success: false, message: 'Apprise not configured' };
    }

    try {
      const response = await fetch(`${this.config.url}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return {
          success: false,
          message: `Apprise API returned ${response.status}`,
          details: await response.text()
        };
      }

      const data = await response.json();
      return {
        success: true,
        message: 'Apprise API is reachable',
        details: data
      };
    } catch (error: any) {
      logger.error('❌ Failed to connect to Apprise API:', error);
      return {
        success: false,
        message: `Connection failed: ${error.message}`
      };
    }
  }

  /**
   * Configure Apprise URLs
   */
  public async configureUrls(urls: string[]): Promise<{ success: boolean; message: string }> {
    if (!this.config) {
      return { success: false, message: 'Apprise not configured' };
    }

    try {
      const response = await fetch(`${this.config.url}/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ urls })
      });

      if (!response.ok) {
        let errorDetails = '';
        try {
          const errorData = await response.json();
          errorDetails = errorData.error || JSON.stringify(errorData);
        } catch {
          errorDetails = await response.text();
        }
        logger.error(`❌ Failed to configure Apprise URLs: ${response.status} - ${errorDetails}`);
        return {
          success: false,
          message: `Configuration failed: ${errorDetails}`
        };
      }

      const responseData = await response.json();
      logger.info(`✅ Configured ${urls.length} Apprise notification URLs`);
      return {
        success: true,
        message: `Configured ${responseData.count || urls.length} notification URLs`
      };
    } catch (error: any) {
      logger.error('❌ Failed to configure Apprise URLs:', error);
      return {
        success: false,
        message: `Configuration error: ${error.message}`
      };
    }
  }

  /**
   * Send a notification via Apprise
   */
  public async sendNotification(payload: AppriseNotificationPayload): Promise<boolean> {
    if (!this.isAvailable()) {
      logger.debug('⚠️  Apprise not available, skipping notification');
      return false;
    }

    try {
      const response = await fetch(`${this.config!.url}/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          type: payload.type || 'info'
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        let errorDetails = '';
        try {
          const errorData = await response.json();
          errorDetails = errorData.error || JSON.stringify(errorData);
        } catch {
          errorDetails = await response.text();
        }
        logger.error(`❌ Apprise notification failed: ${response.status} - ${errorDetails}`);
        return false;
      }

      const data = await response.json();
      logger.debug(`✅ Sent Apprise notification: ${payload.title} (to ${data.sent_to || 0} services)`);
      return true;
    } catch (error: any) {
      logger.error('❌ Failed to send Apprise notification:', error);
      return false;
    }
  }

  /**
   * Broadcast notification with per-user filtering
   * Note: Uses shared filtering logic from pushNotificationService
   */
  public async broadcastWithFiltering(
    payload: AppriseNotificationPayload,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    if (!this.isAvailable()) {
      logger.debug('⚠️  Apprise not available, skipping broadcast');
      return { sent: 0, failed: 0, filtered: 0 };
    }

    // Get users who have Apprise enabled
    const users = this.getUsersWithAppriseEnabled();

    let sent = 0;
    let failed = 0;
    let filtered = 0;

    // If no users have Apprise enabled, don't send anything
    // (Users must explicitly enable Apprise in their preferences)
    if (users.length === 0) {
      logger.debug('No users have Apprise enabled, skipping notification');
      return { sent: 0, failed: 0, filtered: 0 };
    }

    // Per-user filtering
    for (const userId of users) {
      // Import and use shared filter logic
      const shouldFilter = this.shouldFilterNotification(userId, filterContext);
      if (shouldFilter) {
        logger.debug(`🔇 Filtered Apprise notification for user ${userId}`);
        filtered++;
        continue;
      }

      const success = await this.sendNotification(payload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    logger.info(`📢 Apprise broadcast: ${sent} sent, ${failed} failed, ${filtered} filtered`);
    return { sent, failed, filtered };
  }

  /**
   * Get users who have Apprise notifications enabled
   */
  private getUsersWithAppriseEnabled(): number[] {
    try {
      const stmt = databaseService.db.prepare(`
        SELECT user_id
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `);
      const rows = stmt.all() as any[];
      return rows.map(row => row.user_id);
    } catch (error) {
      logger.debug('No user_notification_preferences table yet (or query error), returning empty array');
      return [];
    }
  }

  /**
   * Check if notification should be filtered
   * Reuses the same filtering logic as push notifications
   */
  private shouldFilterNotification(
    userId: number,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
    }
  ): boolean {
    // Check if user has Apprise enabled
    const prefs = getUserNotificationPreferences(userId);
    if (prefs && !prefs.enableApprise) {
      logger.debug(`🔇 Apprise disabled for user ${userId}`);
      return true; // Filter - user has disabled Apprise
    }

    // Use shared filtering utility
    return shouldFilterNotificationUtil(userId, filterContext);
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Used for special notifications like new nodes and traceroutes
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute',
    payload: AppriseNotificationPayload
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    // Get all users with Apprise enabled and this preference enabled
    const users = getUsersWithServiceEnabled('apprise');
    logger.info(`📢 Broadcasting ${preferenceKey} notification to ${users.length} Apprise users`);

    for (const userId of users) {
      // Check if user has this preference enabled
      const prefs = getUserNotificationPreferences(userId);
      if (!prefs || !prefs.enableApprise || !prefs[preferenceKey]) {
        filtered++;
        continue;
      }

      const success = await this.sendNotification(payload);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    logger.info(`📢 ${preferenceKey} Apprise broadcast complete: ${sent} sent, ${failed} failed, ${filtered} filtered`);
    return { sent, failed, filtered };
  }
}

export const appriseNotificationService = new AppriseNotificationService();
