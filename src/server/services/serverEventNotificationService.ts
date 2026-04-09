import { logger } from '../../utils/logger.js';
import { notificationService } from './notificationService.js';

interface ServerStartInfo {
  version: string;
  features: string[];
}

interface SourceConnectionState {
  hasInitialConnection: boolean;
  wasConnected: boolean;
  lastDisconnectTime: number;
}

/**
 * Server Event Notification Service
 *
 * Sends notifications for server-level events:
 * - Server start (with version and enabled features)
 * - Node connection status changes (disconnect/reconnect), tracked per source
 *
 * The initial boot connection per source is skipped — we only notify on:
 * - Disconnects that happen after the initial connection for that source
 * - Reconnects after a disconnect for that source
 */
class ServerEventNotificationService {
  private serverStartTime: number = 0;
  // Per-source connection state — Phase C
  private sourceState: Map<string, SourceConnectionState> = new Map();

  private getOrInitState(sourceId: string): SourceConnectionState {
    let state = this.sourceState.get(sourceId);
    if (!state) {
      state = { hasInitialConnection: false, wasConnected: false, lastDisconnectTime: 0 };
      this.sourceState.set(sourceId, state);
    }
    return state;
  }

  /**
   * Call this when the server starts to send a startup notification.
   * Phase C: server-start is a global event but is dispatched per source so each source's
   * subscribers (with permission) hear about it.
   */
  public async notifyServerStart(info: ServerStartInfo, sourceId: string, sourceName: string): Promise<void> {
    this.serverStartTime = Date.now();
    // Reset per-source state on a fresh server start
    this.sourceState.set(sourceId, { hasInitialConnection: false, wasConnected: false, lastDisconnectTime: 0 });

    try {
      const featuresText = info.features.length > 0
        ? `Features: ${info.features.join(', ')}`
        : 'No optional features enabled';

      const payload = {
        title: `[${sourceName}] MeshMonitor Started (v${info.version})`,
        body: `[${sourceName}] ${featuresText}`,
        type: 'info' as const,
        sourceId,
        sourceName,
      };

      await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
      logger.info(`Server start notification sent for v${info.version} on source ${sourceId}`);
    } catch (error) {
      logger.error('Error sending server start notification:', error);
    }
  }

  /**
   * Call this when a source's node connection is established.
   * This is called from meshtasticManager's handleConnected.
   */
  public async notifyNodeConnected(sourceId: string, sourceName: string): Promise<void> {
    const state = this.getOrInitState(sourceId);

    // Skip the initial boot connection for this source
    if (!state.hasInitialConnection) {
      state.hasInitialConnection = true;
      state.wasConnected = true;
      logger.debug(`Initial node connection established for source ${sourceId} (no notification sent)`);
      return;
    }

    // Only notify if we were previously disconnected
    if (!state.wasConnected) {
      state.wasConnected = true;

      try {
        const disconnectDuration = state.lastDisconnectTime > 0
          ? this.formatDuration(Date.now() - state.lastDisconnectTime)
          : 'unknown duration';

        const payload = {
          title: `[${sourceName}] Node Reconnected`,
          body: `[${sourceName}] Connection to Meshtastic node restored (was offline for ${disconnectDuration})`,
          type: 'success' as const,
          sourceId,
          sourceName,
        };

        await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
        logger.info(`Node reconnect notification sent for source ${sourceId}`);
      } catch (error) {
        logger.error('Error sending node reconnect notification:', error);
      }
    }
  }

  /**
   * Call this when a source's node connection is lost.
   * This is called from meshtasticManager's handleDisconnected.
   */
  public async notifyNodeDisconnected(sourceId: string, sourceName: string): Promise<void> {
    const state = this.getOrInitState(sourceId);

    // Skip if we haven't had an initial connection yet
    if (!state.hasInitialConnection) {
      logger.debug(`Node disconnect before initial connection on source ${sourceId} (no notification sent)`);
      return;
    }

    // Skip if we're already marked as disconnected
    if (!state.wasConnected) {
      logger.debug(`Source ${sourceId} already disconnected (no duplicate notification)`);
      return;
    }

    state.wasConnected = false;
    state.lastDisconnectTime = Date.now();

    try {
      const payload = {
        title: `[${sourceName}] Node Disconnected`,
        body: `[${sourceName}] Lost connection to Meshtastic node`,
        type: 'warning' as const,
        sourceId,
        sourceName,
      };

      await notificationService.broadcastToPreferenceUsers('notifyOnServerEvents', payload);
      logger.info(`Node disconnect notification sent for source ${sourceId}`);
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
   * Reset state (for testing or manual reset).
   * If sourceId is given, only that source's state is reset; otherwise resets everything.
   */
  public reset(sourceId?: string): void {
    if (sourceId) {
      this.sourceState.delete(sourceId);
      return;
    }
    this.sourceState.clear();
    this.serverStartTime = 0;
  }

  /**
   * Get current state for a source (for debugging).
   * Returns zeroed state if source has never been seen.
   */
  public getState(sourceId: string): {
    hasInitialConnection: boolean;
    wasConnected: boolean;
    serverStartTime: number;
    lastDisconnectTime: number;
  } {
    const state = this.sourceState.get(sourceId);
    return {
      hasInitialConnection: state?.hasInitialConnection ?? false,
      wasConnected: state?.wasConnected ?? false,
      serverStartTime: this.serverStartTime,
      lastDisconnectTime: state?.lastDisconnectTime ?? 0,
    };
  }
}

export const serverEventNotificationService = new ServerEventNotificationService();
