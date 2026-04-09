import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { notificationService } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

interface InactiveNodeCheck {
  nodeId: string;
  nodeNum: number;
  longName: string;
  shortName: string;
  lastHeard: number;
  inactiveHours: number;
  sourceId: string;
  sourceName: string;
}

class InactiveNodeNotificationService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private lastNotifiedNodes: Map<string, number> = new Map(); // "userId:sourceId:nodeId" -> last notification timestamp
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
      // Capture current parameter values at the start of the check to ensure consistency
      // throughout the entire check cycle, even if the service is restarted mid-check
      const thresholdHours = this.currentThresholdHours;
      const cooldownHours = this.currentCooldownHours;

      const now = Date.now();
      const cutoffSeconds = Math.floor(now / 1000) - thresholdHours * 60 * 60;

      // Get all users who have inactive node notifications enabled (database-agnostic via Drizzle ORM)
      const users = await databaseService.notifications.getUsersWithInactiveNodeNotifications();

      if (users.length === 0) {
        logger.debug('✅ No users have inactive node notifications enabled');
        return;
      }

      logger.debug(`🔍 Checking inactive nodes for ${users.length} user(s)`);

      // Phase C: iterate every active source and run the inactivity check per source
      const managers = sourceManagerRegistry.getAllManagers();
      if (managers.length === 0) {
        logger.debug('No source managers registered — skipping inactive node check');
        return;
      }

      for (const manager of managers) {
        const sourceId = manager.sourceId;
        // Resolve sourceName once per source per scan
        let sourceName: string = sourceId;
        try {
          const source = await databaseService.sources.getSource(sourceId);
          if (source?.name) sourceName = source.name;
        } catch (err) {
          logger.debug(`Could not resolve source name for ${sourceId}:`, err);
        }

        // Process each user's monitored nodes (scoped to this source)
        for (const user of users) {
          let monitoredNodeIds: string[] = [];

          if (user.monitoredNodes) {
            try {
              monitoredNodeIds = JSON.parse(user.monitoredNodes);
            } catch (error) {
              logger.warn(`Failed to parse monitored_nodes for user ${user.userId}:`, error);
              continue;
            }
          }

          if (monitoredNodeIds.length === 0) {
            continue;
          }

          // Phase C: permission check — skip user if they lack nodes:read on this source
          try {
            const allowed = await databaseService.checkPermissionAsync(user.userId, 'nodes', 'read', sourceId);
            if (!allowed) continue;
          } catch (err) {
            logger.error(`Permission check failed for user ${user.userId} on source ${sourceId}:`, err);
            continue;
          }

          // Get inactive nodes for this source that are in the user's monitored list
          const inactiveNodes = await databaseService.nodes.getInactiveMonitoredNodes(
            monitoredNodeIds,
            cutoffSeconds,
            sourceId
          );

          if (inactiveNodes.length === 0) continue;

          logger.debug(`🔍 Found ${inactiveNodes.length} inactive monitored node(s) for user ${user.userId} on source ${sourceId}`);

          for (const node of inactiveNodes) {
            if (node.lastHeard == null) continue;
            const lastHeardMs = node.lastHeard * 1000;
            const inactiveHours = Math.floor((now - lastHeardMs) / (60 * 60 * 1000));

            // Source-scoped cooldown key prevents collisions across sources
            const notificationKey = `${user.userId}:${sourceId}:${node.nodeId}`;
            const lastNotification = this.lastNotifiedNodes.get(notificationKey);
            const cooldownMs = cooldownHours * 60 * 60 * 1000;

            if (lastNotification && now - lastNotification < cooldownMs) {
              logger.debug(
                `⏭️  Skipping notification for user ${user.userId}, node ${node.nodeId} on ${sourceId} (already notified recently)`
              );
              continue;
            }

            await this.sendInactiveNodeNotification(user.userId, {
              nodeId: node.nodeId,
              nodeNum: node.nodeNum,
              longName: node.longName || node.shortName || `Node ${node.nodeNum}`,
              shortName: node.shortName || '????',
              lastHeard: node.lastHeard,
              inactiveHours,
              sourceId,
              sourceName,
            });

            this.lastNotifiedNodes.set(notificationKey, now);
          }
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
        title: `[${node.sourceName}] ⚠️ Node Inactive: ${node.longName}`,
        body: `[${node.sourceName}] ${node.shortName} (${node.nodeId}) has been inactive for ${node.inactiveHours} ${hoursText}`,
        type: 'warning' as const,
        sourceId: node.sourceId,
        sourceName: node.sourceName,
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
