import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { getUserNotificationPreferencesAsync, getUsersWithServiceEnabledAsync, shouldFilterNotificationAsync, applyNodeNamePrefixAsync } from '../utils/notificationFiltering.js';
import meshtasticManager from '../meshtasticManager.js';

export interface AppriseNotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name used to prefix title/body. */
  sourceName: string;
}

interface AppriseConfig {
  url: string;
  enabled: boolean;
}

class AppriseNotificationService {
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Start async initialization - it will wait for the database to be ready
    this.initPromise = this.initializeAsync();
  }

  /**
   * Async initialization that waits for the database to be ready.
   * Phase B: per-source settings are resolved at dispatch time, not cached here.
   */
  private async initializeAsync(): Promise<void> {
    try {
      await databaseService.waitForReady();
      this.initialized = true;
      logger.info('✅ Apprise notification service initialized (per-source config resolved at dispatch time)');
    } catch (error) {
      logger.debug('⚠️ Could not initialize Apprise notification service:', error);
      this.initialized = false;
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
   * Check if Apprise service is initialized. Per-source enabled/URL is checked at dispatch.
   */
  public isAvailable(): boolean {
    return this.initialized;
  }

  /**
   * Resolve Apprise URL for a given source.
   *
   * Precedence (highest → lowest):
   *   1. Per-source `apprise_url` setting (DB)
   *   2. Global `appriseApiServerUrl` setting (DB) — set via Global Settings UI;
   *      added in #3012 so desktop builds can target an externally-hosted
   *      Apprise API server without env vars.
   *   3. `APPRISE_URL` environment variable
   *   4. `http://localhost:8000` (bundled in the Docker image via supervisord)
   */
  private async resolveAppriseConfig(sourceId: string): Promise<AppriseConfig | null> {
    try {
      const perSourceUrl = await databaseService.settings.getSettingForSource(sourceId, 'apprise_url');
      const enabledSetting = await databaseService.settings.getSettingForSource(sourceId, 'apprise_enabled');
      const globalUrl = await databaseService.settings.getSetting('appriseApiServerUrl');
      const url =
        perSourceUrl ||
        globalUrl ||
        process.env.APPRISE_URL ||
        'http://localhost:8000';
      if (!url) {
        logger.debug(`ℹ️ No apprise_url configured for source ${sourceId} (and no APPRISE_URL env)`);
        return null;
      }
      // Default to enabled unless explicitly 'false'
      const enabled = enabledSetting !== 'false';
      return { url, enabled };
    } catch (error) {
      logger.error(`Failed to resolve Apprise config for source ${sourceId}:`, error);
      return null;
    }
  }

  /**
   * Test connection to Apprise API
   */
  public async testConnection(sourceId?: string): Promise<{ success: boolean; message: string; details?: any }> {
    // TODO Phase D: sourceId should be required from routes
    const effectiveSourceId = sourceId ?? 'default';
    const config = await this.resolveAppriseConfig(effectiveSourceId);
    if (!config) {
      return { success: false, message: `Apprise not configured for source ${effectiveSourceId}` };
    }

    try {
      const response = await fetch(`${config.url}/health`, {
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
  public async configureUrls(urls: string[], sourceId?: string): Promise<{ success: boolean; message: string }> {
    // TODO Phase D: sourceId should be required from routes
    const effectiveSourceId = sourceId ?? 'default';
    const config = await this.resolveAppriseConfig(effectiveSourceId);
    if (!config) {
      return { success: false, message: `Apprise not configured for source ${effectiveSourceId}` };
    }

    try {
      const response = await fetch(`${config.url}/config`, {
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

    // Resolve per-source apprise API endpoint
    const config = await this.resolveAppriseConfig(payload.sourceId);
    if (!config || !config.enabled) {
      logger.debug(`ℹ️ Apprise disabled or not configured for source ${payload.sourceId}`);
      return false;
    }

    try {
      // Apprise API supports sending to specific URLs via the 'urls' parameter
      const response = await fetch(`${config.url}/notify`, {
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
      sourceId: string;
      sourceName: string;
    }
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    if (!this.isAvailable()) {
      logger.debug('⚠️  Apprise not available, skipping broadcast');
      return { sent: 0, failed: 0, filtered: 0 };
    }

    // Resolve per-source apprise config — no global fallback
    const config = await this.resolveAppriseConfig(filterContext.sourceId);
    if (!config || !config.enabled) {
      logger.debug(`ℹ️ Apprise not enabled for source ${filterContext.sourceId}, skipping`);
      return { sent: 0, failed: 0, filtered: 0 };
    }

    // Prefix title with source name (body kept clean — title already disambiguates source)
    const prefixedPayload: AppriseNotificationPayload = {
      ...payload,
      title: `[${filterContext.sourceName}] ${payload.title}`,
    };

    // Get users who have Apprise enabled
    const users = await this.getUsersWithAppriseEnabledAsync();

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
      const shouldFilter = await this.shouldFilterNotificationAsync(userId, filterContext);
      if (shouldFilter) {
        logger.debug(`🔇 Filtered Apprise notification for user ${userId}`);
        filtered++;
        continue;
      }

      // Get user's preferences to get their Apprise URLs (per-source — must
      // match the sourceId used by the filter check above so we don't pull URLs
      // from a different source's prefs row).
      const prefs = await getUserNotificationPreferencesAsync(userId, filterContext.sourceId);
      if (!prefs || !prefs.appriseUrls || prefs.appriseUrls.length === 0) {
        logger.debug(`⚠️  No Apprise URLs configured for user ${userId}, skipping`);
        filtered++;
        continue;
      }

      // Apply node name prefix if user has it enabled (per-source prefs)
      const prefixedBody = await applyNodeNamePrefixAsync(userId, prefixedPayload.body, localNodeName, filterContext.sourceId);
      const notificationPayload = prefixedBody !== prefixedPayload.body
        ? { ...prefixedPayload, body: prefixedBody }
        : prefixedPayload;

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
   * Get users who have Apprise notifications enabled (async)
   */
  private async getUsersWithAppriseEnabledAsync(): Promise<number[]> {
    try {
      if (!databaseService.notificationsRepo) {
        logger.debug('Notifications repository not initialized');
        return [];
      }

      return databaseService.notificationsRepo.getUsersWithAppriseEnabled();
    } catch (error) {
      logger.debug('No user_notification_preferences table yet (or query error), returning empty array');
      return [];
    }
  }

  /**
   * Check if notification should be filtered (async)
   * Reuses the same filtering logic as push notifications
   */
  private async shouldFilterNotificationAsync(
    userId: number,
    filterContext: {
      messageText: string;
      channelId: number;
      isDirectMessage: boolean;
      viaMqtt?: boolean;
      sourceId: string;
      sourceName: string;
    }
  ): Promise<boolean> {
    // Phase B: permission check
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

    // Check if user has Apprise enabled (per-source)
    const prefs = await getUserNotificationPreferencesAsync(userId, filterContext.sourceId);
    if (prefs && !prefs.enableApprise) {
      logger.debug(`🔇 Apprise disabled for user ${userId} on source ${filterContext.sourceId}`);
      return true; // Filter - user has disabled Apprise
    }

    // Use shared filtering utility
    return shouldFilterNotificationAsync(userId, filterContext);
  }

  /**
   * Broadcast to users who have a specific preference enabled
   * Used for special notifications like new nodes, traceroutes, and inactive nodes
   */
  public async broadcastToPreferenceUsers(
    preferenceKey: 'notifyOnNewNode' | 'notifyOnTraceroute' | 'notifyOnInactiveNode' | 'notifyOnServerEvents',
    payload: AppriseNotificationPayload,
    targetUserId?: number,
    sourceId?: string
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    let sent = 0;
    let failed = 0;
    let filtered = 0;

    // Phase C: scope preference broadcasts by sourceId
    const effectiveSourceId = sourceId ?? payload.sourceId;
    // Get all users with Apprise enabled and this preference enabled
    const users = await getUsersWithServiceEnabledAsync('apprise');
    logger.info(`📢 Broadcasting ${preferenceKey} notification to ${users.length} Apprise users${targetUserId ? ` (target user: ${targetUserId})` : ''}`);

    // Get local node name for prefix
    // First try the live connection, then fall back to database (for startup before connection)
    let localNodeName: string | null = null;
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    if (localNodeInfo?.longName) {
      localNodeName = localNodeInfo.longName;
    } else {
      // Fall back to database - get localNodeNum from settings and look up the node
      const localNodeNumStr = await databaseService.settings.getSetting('localNodeNum');
      if (localNodeNumStr) {
        const localNodeNum = parseInt(localNodeNumStr, 10);
        const localNode = await databaseService.nodesRepo?.getNode(localNodeNum);
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

      // Check if user has this preference enabled (per-source) and has URLs configured
      const prefs = await getUserNotificationPreferencesAsync(userId, effectiveSourceId);
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
      const prefixedBody = await applyNodeNamePrefixAsync(userId, payload.body, localNodeName);
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
