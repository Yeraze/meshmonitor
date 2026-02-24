import { logger } from '../../utils/logger.js';
import { notificationService } from './notificationService.js';

interface ServerStartInfo {
  version: string;
  features: string[];
}

/**
 * Server Event Notification Service
 *
 * Sends notifications for server-level events:
 * - Server start (with version and enabled features)
 * - Node connection status changes (disconnect/reconnect)
 *
 * The initial boot connection is skipped - we only notify on:
 * - Disconnects that happen after the initial connection
 * - Reconnects after a disconnect
 */
class ServerEventNotificationService {
  private hasInitialConnection: boolean = false;
  private wasConnected: boolean = false;
  private serverStartTime: number = 0;
  private lastDisconnectTime: number = 0;

  /**
   * Call this when the server starts to send a startup notification
   */
  public async notifyServerStart(info: ServerStartInfo): Promise<void> {
    this.serverStartTime = Date.now();
    this.hasInitialConnection = false;
    this.wasConnected = false;

    try {
      const featuresText = info.features.length > 0
        ? `Features: ${info.features.join(', ')}`
        : 'No optional features enabled';

      const payload = {
        title: `MeshMonitor Started (v${info.version})`,
        body: featuresText,
        type: 'info' as const,
      };

      await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
      logger.info(`Server start notification sent for v${info.version}`);
    } catch (error) {
      logger.error('Error sending server start notification:', error);
    }
  }

  /**
   * Call this when the node connection is established
   * This is called from meshtasticManager's handleConnected
   */
  public async notifyNodeConnected(): Promise<void> {
    // Skip the initial boot connection
    if (!this.hasInitialConnection) {
      this.hasInitialConnection = true;
      this.wasConnected = true;
      logger.debug('Initial node connection established (no notification sent)');
      return;
    }

    // Only notify if we were previously disconnected
    if (!this.wasConnected) {
      this.wasConnected = true;

      try {
        const disconnectDuration = this.lastDisconnectTime > 0
          ? this.formatDuration(Date.now() - this.lastDisconnectTime)
          : 'unknown duration';

        const payload = {
          title: 'Node Reconnected',
          body: `Connection to Meshtastic node restored (was offline for ${disconnectDuration})`,
          type: 'success' as const,
        };

        await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
        logger.info('Node reconnect notification sent');
      } catch (error) {
        logger.error('Error sending node reconnect notification:', error);
      }
    }
  }

  /**
   * Call this when the node connection is lost
   * This is called from meshtasticManager's handleDisconnected
   */
  public async notifyNodeDisconnected(): Promise<void> {
    // Skip if we haven't had an initial connection yet
    if (!this.hasInitialConnection) {
      logger.debug('Node disconnect before initial connection (no notification sent)');
      return;
    }

    // Skip if we're already marked as disconnected
    if (!this.wasConnected) {
      logger.debug('Already disconnected (no duplicate notification)');
      return;
    }

    this.wasConnected = false;
    this.lastDisconnectTime = Date.now();

    try {
      const payload = {
        title: 'Node Disconnected',
        body: 'Lost connection to Meshtastic node',
        type: 'warning' as const,
      };

      await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
      logger.info('Node disconnect notification sent');
    } catch (error) {
      logger.error('Error sending node disconnect notification:', error);
    }
  }

  /**
   * Format duration in a human-readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Reset state (for testing or manual reset)
   */
  public reset(): void {
    this.hasInitialConnection = false;
    this.wasConnected = false;
    this.serverStartTime = 0;
    this.lastDisconnectTime = 0;
  }

  /**
   * Get current state (for debugging)
   */
  public getState(): {
    hasInitialConnection: boolean;
    wasConnected: boolean;
    serverStartTime: number;
    lastDisconnectTime: number;
  } {
    return {
      hasInitialConnection: this.hasInitialConnection,
      wasConnected: this.wasConnected,
      serverStartTime: this.serverStartTime,
      lastDisconnectTime: this.lastDisconnectTime,
    };
  }
}

export const serverEventNotificationService = new ServerEventNotificationService();
