import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { notificationService } from './notificationService.js';

interface InactiveNodeCheck {
  nodeId: string;
  nodeNum: number;
  longName: string;
  shortName: string;
  lastHeard: number;
  inactiveHours: number;
}

class InactiveNodeNotificationService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private lastNotifiedNodes: Map<string, number> = new Map(); // "userId:nodeId" -> last notification timestamp
  private currentThresholdHours: number = 24;
  private currentCooldownHours: number = 24;
  private readonly DEFAULT_CHECK_INTERVAL_MINUTES = 60; // Check every hour
  private readonly DEFAULT_INACTIVE_THRESHOLD_HOURS = 24; // 24 hours of inactivity
  private readonly DEFAULT_NOTIFICATION_COOLDOWN_HOURS = 24; // Don't notify about same node more than once per 24 hours

  /**
   * Start the inactive node monitoring service
   */
  public start(
    inactiveThresholdHours: number = this.DEFAULT_INACTIVE_THRESHOLD_HOURS,
    checkIntervalMinutes: number = this.DEFAULT_CHECK_INTERVAL_MINUTES,
    cooldownHours: number = this.DEFAULT_NOTIFICATION_COOLDOWN_HOURS
  ): void {
    if (this.checkInterval) {
      logger.warn('⚠️  Inactive node notification service is already running');
      return;
    }

    this.currentThresholdHours = inactiveThresholdHours;
    this.currentCooldownHours = cooldownHours;

    logger.info(
      `🔔 Starting inactive node notification service (checking every ${checkIntervalMinutes} minutes, threshold: ${inactiveThresholdHours} hours, cooldown: ${cooldownHours} hours)`
    );

    // Run initial check after a short delay
    // Capture parameters in closure to ensure correct values are used even if service is restarted
    this.initialCheckTimeout = setTimeout(() => {
      this.checkInactiveNodes();
      this.initialCheckTimeout = null; // Clear reference after execution
    }, 60000); // Wait 1 minute before first check

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkInactiveNodes();
    }, checkIntervalMinutes * 60 * 1000);
  }

  /**
   * Stop the inactive node monitoring service
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Clear the initial check timeout if it hasn't fired yet
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }

    if (this.checkInterval === null && this.initialCheckTimeout === null) {
      logger.info('⏹️  Inactive node notification service stopped');
    }
  }

  /**
   * Check for inactive nodes and send notifications
   * Only checks nodes that are in each user's monitored list
   * Captures current parameter values at the start to ensure consistency throughout the check,
   * even if the service is restarted with new parameters while this check is running.
   */
  private async checkInactiveNodes(): Promise<void> {
    try {
      // For PostgreSQL/MySQL, inactive node notifications not yet implemented
      if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
        return;
      }

      // Capture current parameter values at the start of the check to ensure consistency
      // throughout the entire check cycle, even if the service is restarted mid-check
      const thresholdHours = this.currentThresholdHours;
      const cooldownHours = this.currentCooldownHours;

      const now = Date.now();
      const cutoffSeconds = Math.floor(now / 1000) - thresholdHours * 60 * 60;

      // Get all users who have inactive node notifications enabled
      const usersStmt = databaseService.db.prepare(`
        SELECT user_id, monitored_nodes
        FROM user_notification_preferences
        WHERE notify_on_inactive_node = 1
          AND (enable_web_push = 1 OR enable_apprise = 1)
      `);

      const users = usersStmt.all() as Array<{
        user_id: number;
        monitored_nodes: string | null;
      }>;

      if (users.length === 0) {
        logger.debug('✅ No users have inactive node notifications enabled');
        return;
      }

      logger.debug(`🔍 Checking inactive nodes for ${users.length} user(s)`);

      // Process each user's monitored nodes
      for (const user of users) {
        let monitoredNodeIds: string[] = [];

        // Parse monitored nodes list
        if (user.monitored_nodes) {
          try {
            monitoredNodeIds = JSON.parse(user.monitored_nodes);
          } catch (error) {
            logger.warn(`Failed to parse monitored_nodes for user ${user.user_id}:`, error);
            continue;
          }
        }

        // If user has no monitored nodes, skip (they need to select nodes first)
        if (monitoredNodeIds.length === 0) {
          logger.debug(`⏭️  User ${user.user_id} has no monitored nodes, skipping`);
          continue;
        }

        // Get inactive nodes that are in this user's monitored list
        const placeholders = monitoredNodeIds.map(() => '?').join(',');
        const stmt = databaseService.db.prepare(`
          SELECT nodeNum, nodeId, longName, shortName, lastHeard
          FROM nodes
          WHERE nodeId IN (${placeholders})
            AND lastHeard IS NOT NULL 
            AND lastHeard < ?
          ORDER BY lastHeard ASC
        `);

        const inactiveNodes = stmt.all(...monitoredNodeIds, cutoffSeconds) as Array<{
          nodeNum: number;
          nodeId: string;
          longName: string;
          shortName: string;
          lastHeard: number;
        }>;

        if (inactiveNodes.length === 0) {
          continue; // No inactive nodes for this user
        }

        logger.debug(`🔍 Found ${inactiveNodes.length} inactive monitored node(s) for user ${user.user_id}`);

        // Check each inactive node and send notification if needed
        for (const node of inactiveNodes) {
          const lastHeardMs = node.lastHeard * 1000;
          const inactiveHours = Math.floor((now - lastHeardMs) / (60 * 60 * 1000));

          // Check if we've already notified this user about this node recently
          const notificationKey = `${user.user_id}:${node.nodeId}`;
          const lastNotification = this.lastNotifiedNodes.get(notificationKey);
          const cooldownMs = cooldownHours * 60 * 60 * 1000;

          if (lastNotification && now - lastNotification < cooldownMs) {
            logger.debug(
              `⏭️  Skipping notification for user ${user.user_id}, node ${node.nodeId} (already notified recently)`
            );
            continue;
          }

          // Send notification to this specific user
          await this.sendInactiveNodeNotification(user.user_id, {
            nodeId: node.nodeId,
            nodeNum: node.nodeNum,
            longName: node.longName || node.shortName || `Node ${node.nodeNum}`,
            shortName: node.shortName || '????',
            lastHeard: node.lastHeard,
            inactiveHours,
          });

          // Record that we've notified this user about this node
          this.lastNotifiedNodes.set(notificationKey, now);
        }
      }

      // Clean up old entries from lastNotifiedNodes map (keep only last 7 days)
      const cleanupCutoff = now - 7 * 24 * 60 * 60 * 1000;
      for (const [key, timestamp] of this.lastNotifiedNodes.entries()) {
        if (timestamp < cleanupCutoff) {
          this.lastNotifiedNodes.delete(key);
        }
      }
    } catch (error) {
      logger.error('❌ Error checking inactive nodes:', error);
    }
  }

  /**
   * Send notification for an inactive node to a specific user
   */
  private async sendInactiveNodeNotification(userId: number, node: InactiveNodeCheck): Promise<void> {
    try {
      const hoursText = node.inactiveHours === 1 ? 'hour' : 'hours';
      const payload = {
        title: `⚠️ Node Inactive: ${node.longName}`,
        body: `${node.shortName} (${node.nodeId}) has been inactive for ${node.inactiveHours} ${hoursText}`,
        type: 'warning' as const,
      };

      // Send to this specific user (they have the preference enabled and node is in their list)
      await notificationService.broadcastToPreferenceUsers('notifyOnInactiveNode', payload, userId);

      logger.info(
        `📤 Sent inactive node notification to user ${userId} for ${node.nodeId} (${node.inactiveHours} hours inactive)`
      );
    } catch (error) {
      logger.error(`❌ Error sending inactive node notification to user ${userId} for ${node.nodeId}:`, error);
    }
  }

  /**
   * Get service status
   */
  public getStatus(): { running: boolean; lastCheck?: number } {
    return {
      running: this.checkInterval !== null,
    };
  }
}

export const inactiveNodeNotificationService = new InactiveNodeNotificationService();
