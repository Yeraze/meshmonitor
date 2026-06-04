import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { notificationService } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

interface LowBatteryNodeCheck {
  nodeId: string;
  nodeNum: number;
  longName: string;
  shortName: string;
  batteryLevel: number;
  threshold: number;
  sourceId: string;
  sourceName: string;
}

/**
 * Polls monitored Meshtastic nodes and notifies users when a node's battery
 * drops below their per-user threshold. The monitored-node list is shared with
 * the inactive-node feature (user_notification_preferences.monitored_nodes);
 * the threshold is per-user (lowBatteryThreshold). Check interval and cooldown
 * are global admin settings, mirroring the inactive-node service.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3305
 */
class LowBatteryNotificationService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private lastNotifiedNodes: Map<string, number> = new Map(); // "userId:sourceId:nodeId" -> last notification timestamp
  private currentCooldownHours: number = 24;
  private readonly DEFAULT_CHECK_INTERVAL_MINUTES = 60; // Check every hour
  private readonly DEFAULT_THRESHOLD_PERCENT = 20; // Used when a user has no explicit threshold
  private readonly DEFAULT_NOTIFICATION_COOLDOWN_HOURS = 24; // Don't notify about same node more than once per 24 hours

  /**
   * Start the low-battery monitoring service
   */
  public start(
    checkIntervalMinutes: number = this.DEFAULT_CHECK_INTERVAL_MINUTES,
    cooldownHours: number = this.DEFAULT_NOTIFICATION_COOLDOWN_HOURS
  ): void {
    if (this.checkInterval) {
      logger.warn('⚠️  Low battery notification service is already running');
      return;
    }

    this.currentCooldownHours = cooldownHours;

    logger.info(
      `🔔 Starting low battery notification service (checking every ${checkIntervalMinutes} minutes, cooldown: ${cooldownHours} hours)`
    );

    // Run initial check after a short delay
    this.initialCheckTimeout = setTimeout(() => {
      this.checkLowBatteryNodes();
      this.initialCheckTimeout = null;
    }, 60000); // Wait 1 minute before first check

    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkLowBatteryNodes();
    }, checkIntervalMinutes * 60 * 1000);
  }

  /**
   * Stop the low-battery monitoring service
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }

    if (this.checkInterval === null && this.initialCheckTimeout === null) {
      logger.info('⏹️  Low battery notification service stopped');
    }
  }

  /**
   * Check monitored nodes for low battery and send notifications.
   * Captures the cooldown value at the start so a mid-check restart can't skew it.
   */
  private async checkLowBatteryNodes(): Promise<void> {
    try {
      const cooldownHours = this.currentCooldownHours;
      const now = Date.now();

      // Get all users who have low battery notifications enabled
      const users = await databaseService.notifications.getUsersWithLowBatteryNotifications();

      if (users.length === 0) {
        logger.debug('✅ No users have low battery notifications enabled');
        return;
      }

      logger.debug(`🔍 Checking low battery for ${users.length} user(s)`);

      const managers = sourceManagerRegistry.getAllManagers();
      if (managers.length === 0) {
        logger.debug('No source managers registered — skipping low battery check');
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

          const threshold =
            user.lowBatteryThreshold != null && user.lowBatteryThreshold >= 0 && user.lowBatteryThreshold <= 100
              ? user.lowBatteryThreshold
              : this.DEFAULT_THRESHOLD_PERCENT;

          // Permission check — skip user if they lack nodes:read on this source
          try {
            const allowed = await databaseService.checkPermissionAsync(user.userId, 'nodes', 'read', sourceId);
            if (!allowed) continue;
          } catch (err) {
            logger.error(`Permission check failed for user ${user.userId} on source ${sourceId}:`, err);
            continue;
          }

          const lowBatteryNodes = await databaseService.nodes.getLowBatteryMonitoredNodes(
            monitoredNodeIds,
            threshold,
            sourceId
          );

          if (lowBatteryNodes.length === 0) continue;

          logger.debug(`🔍 Found ${lowBatteryNodes.length} low-battery monitored node(s) for user ${user.userId} on source ${sourceId}`);

          for (const node of lowBatteryNodes) {
            if (node.batteryLevel == null) continue;

            // Source-scoped cooldown key prevents collisions across sources
            const notificationKey = `${user.userId}:${sourceId}:${node.nodeId}`;
            const lastNotification = this.lastNotifiedNodes.get(notificationKey);
            const cooldownMs = cooldownHours * 60 * 60 * 1000;

            if (lastNotification && now - lastNotification < cooldownMs) {
              logger.debug(
                `⏭️  Skipping low battery notification for user ${user.userId}, node ${node.nodeId} on ${sourceId} (already notified recently)`
              );
              continue;
            }

            await this.sendLowBatteryNotification(user.userId, {
              nodeId: node.nodeId,
              nodeNum: node.nodeNum,
              longName: node.longName || node.shortName || `Node ${node.nodeNum}`,
              shortName: node.shortName || '????',
              batteryLevel: node.batteryLevel,
              threshold,
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
      logger.error('❌ Error checking low battery nodes:', error);
    }
  }

  /**
   * Send a low-battery notification for a node to a specific user
   */
  private async sendLowBatteryNotification(userId: number, node: LowBatteryNodeCheck): Promise<void> {
    try {
      const payload = {
        title: `[${node.sourceName}] 🔋 Low Battery: ${node.longName}`,
        body: `[${node.sourceName}] ${node.shortName} (${node.nodeId}) battery at ${node.batteryLevel}% (threshold: ${node.threshold}%)`,
        type: 'warning' as const,
        sourceId: node.sourceId,
        sourceName: node.sourceName,
      };

      await notificationService.broadcastToPreferenceUsers('notifyOnLowBattery', payload, userId);

      logger.info(
        `📤 Sent low battery notification to user ${userId} for ${node.nodeId} (${node.batteryLevel}% battery)`
      );
    } catch (error) {
      logger.error(`❌ Error sending low battery notification to user ${userId} for ${node.nodeId}:`, error);
    }
  }

  /**
   * Get service status
   */
  public getStatus(): { running: boolean } {
    return {
      running: this.checkInterval !== null,
    };
  }
}

export const lowBatteryNotificationService = new LowBatteryNotificationService();
