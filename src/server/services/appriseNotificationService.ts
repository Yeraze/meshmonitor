import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { getUserNotificationPreferences, getUsersWithServiceEnabled, shouldFilterNotification as shouldFilterNotificationUtil, applyNodeNamePrefix } from '../utils/notificationFiltering.js';
import meshtasticManager from '../meshtasticManager.js';

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
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Start async initialization - it will wait for the database to be ready
    this.initPromise = this.initializeAsync();
  }

  /**
   * Async initialization that waits for the database to be ready
   */
  private async initializeAsync(): Promise<void> {
    try {
      // Wait for the database to be ready before accessing settings
      await databaseService.waitForReady();

      // Default to internal Apprise API (bundled in container)
      const appriseUrl = await databaseService.getSettingAsync('apprise_url') || 'http://localhost:8000';
      const enabledSetting = await databaseService.getSettingAsync('apprise_enabled');

      // Default to enabled if not explicitly set (backward compatibility)
      const enabled = enabledSetting !== 'false';

      // If not set, initialize it to 'true'
      if (enabledSetting === null || enabledSetting === undefined) {
        await databaseService.setSettingAsync('apprise_enabled', 'true');
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
    } catch (error) {
      // Database not ready or settings table doesn't exist (e.g., during tests)
      logger.debug('⚠️ Could not initialize Apprise notification service:', error);
      // Default to disabled state
      this.config = {
        url: 'http://localhost:8000',
        enabled: false
      };
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
   * Send a notification via Apprise to all globally configured URLs
   * @deprecated Use sendNotificationToUrls for per-user notifications
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
   * Send a notification to specific Apprise URLs (per-user)
   * Uses the Apprise API with inline URLs instead of the global config
   */
  public async sendNotificationToUrls(
    payload: AppriseNotificationPayload,
    urls: string[]
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      logger.debug('⚠️  Apprise not available, skipping notification');
      return false;
    }

    if (!urls || urls.length === 0) {
      logger.debug('⚠️  No Apprise URLs provided, skipping notification');
      return false;
    }

    try {
      // Apprise API supports sending to specific URLs via the 'urls' parameter
      const response = await fetch(`${this.config!.url}/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          urls: urls,
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
      logger.debug(`✅ Sent Apprise notification: ${payload.title} (to ${data.sent_to || urls.length} services)`);
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
      viaMqtt?: boolean;
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

    // Get local node name for prefix
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    // Per-user filtering and sending to user-specific URLs
    for (const userId of users) {
      // Import and use shared filter logic
      const shouldFilter = this.shouldFilterNotification(userId, filterContext);
      if (shouldFilter) {
        logger.debug(`🔇 Filtered Apprise notification for user ${userId}`);
        filtered++;
        continue;
      }

      // Get user's preferences to get their Apprise URLs
      const prefs = getUserNotificationPreferences(userId);
      if (!prefs || !prefs.appriseUrls || prefs.appriseUrls.length === 0) {
        logger.debug(`⚠️  No Apprise URLs configured for user ${userId}, skipping`);
        filtered++;
        continue;
      }

      // Apply node name prefix if user has it enabled
      const prefixedBody = applyNodeNamePrefix(userId, payload.body, localNodeName);
      const notificationPayload = prefixedBody !== payload.body
        ? { ...payload, body: prefixedBody }
        : payload;

      // Send to user's specific URLs
      const success = await this.sendNotificationToUrls(notificationPayload, prefs.appriseUrls);
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
      viaMqtt?: boolean;
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
   * Used for special notifications like new nodes, traceroutes, and inactive nodes
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnServerEvents',
    payload: AppriseNotificationPayload,
    targetUserId?: number
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    // Get all users with Apprise enabled and this preference enabled
    const users = getUsersWithServiceEnabled('apprise');
    logger.info(`📢 Broadcasting ${preferenceKey} notification to ${users.length} Apprise users${targetUserId ? ` (target user: ${targetUserId})` : ''}`);

    // Get local node name for prefix
    // First try the live connection, then fall back to database (for startup before connection)
    let localNodeName: string | null = null;
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    if (localNodeInfo?.longName) {
      localNodeName = localNodeInfo.longName;
    } else {
      // Fall back to database - get localNodeNum from settings and look up the node
      const localNodeNumStr = databaseService.getSetting('localNodeNum');
      if (localNodeNumStr) {
        const localNodeNum = parseInt(localNodeNumStr, 10);
        const localNode = databaseService.getNode(localNodeNum);
        if (localNode?.longName) {
          localNodeName = localNode.longName;
          logger.debug(`📢 Using node name from database for Apprise prefix: ${localNodeName}`);
        }
      }
    }

    for (const userId of users) {
      // If targetUserId is specified, only send to that user
      if (targetUserId !== undefined && userId !== targetUserId) {
        filtered++;
        continue;
      }

      // Check if user has this preference enabled and has URLs configured
      const prefs = getUserNotificationPreferences(userId);
      if (!prefs || !prefs.enableApprise || !prefs[preferenceKey]) {
        filtered++;
        continue;
      }

      // Check if user has Apprise URLs configured
      if (!prefs.appriseUrls || prefs.appriseUrls.length === 0) {
        logger.debug(`⚠️  No Apprise URLs configured for user ${userId}, skipping`);
        filtered++;
        continue;
      }

      // Apply node name prefix if user has it enabled
      const prefixedBody = applyNodeNamePrefix(userId, payload.body, localNodeName);
      const notificationPayload = prefixedBody !== payload.body
        ? { ...payload, body: prefixedBody }
        : payload;

      // Send to user's specific URLs
      const success = await this.sendNotificationToUrls(notificationPayload, prefs.appriseUrls);
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
