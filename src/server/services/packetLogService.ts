import databaseService from '../../services/database.js';
import { DbPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../../db/types.js';
import { logger } from '../../utils/logger.js';

class PacketLogService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  constructor() {
    this.startCleanupScheduler();
  }

  /**
   * Start automatic cleanup scheduler
   */
  private startCleanupScheduler(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    logger.debug('🧹 Starting packet log cleanup scheduler (runs every 15 minutes)');
    this.cleanupInterval = setInterval(() => {
      this.runCleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Run cleanup of old packet logs
   */
  async runCleanup(): Promise<void> {
    try {
      const deletedCount = await databaseService.cleanupOldPacketLogsAsync();
      if (deletedCount > 0) {
        logger.debug(`🧹 Packet log cleanup: removed ${deletedCount} old packets`);
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup packet logs:', error);
    }
  }

  /**
   * Log a mesh packet
   */
  async logPacket(packet: Omit<DbPacketLog, 'id' | 'created_at'>): Promise<number> {
    try {
      return await databaseService.insertPacketLogAsync(packet);
    } catch (error) {
      logger.error('❌ Failed to log packet:', error);
      return 0;
    }
  }

  /**
   * Get packet logs with optional filters
   */
  async getPackets(options: {
    offset?: number;
    limit?: number;
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
    relay_node?: number | 'unknown';
    sourceId?: string;
  }): Promise<DbPacketLog[]> {
    return databaseService.getPacketLogsAsync(options);
  }

  /**
   * Get packet logs with optional filters - async version for all backends
   */
  async getPacketsAsync(options: {
    offset?: number;
    limit?: number;
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
    relay_node?: number | 'unknown';
    sourceId?: string;
  }): Promise<DbPacketLog[]> {
    return databaseService.getPacketLogsAsync(options);
  }

  /**
   * Get single packet by ID
   */
  async getPacketById(id: number): Promise<DbPacketLog | null> {
    return databaseService.getPacketLogByIdAsync(id);
  }

  async getPacketByIdAsync(id: number): Promise<DbPacketLog | null> {
    return databaseService.getPacketLogByIdAsync(id);
  }

  /**
   * Get total packet count with optional filters
   */
  async getPacketCount(options?: {
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
    relay_node?: number | 'unknown';
    sourceId?: string;
  }): Promise<number> {
    return databaseService.getPacketLogCountAsync(options || {});
  }

  /**
   * Get total packet count with optional filters - async version for all backends
   */
  async getPacketCountAsync(options?: {
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
    relay_node?: number | 'unknown';
    sourceId?: string;
  }): Promise<number> {
    return databaseService.getPacketLogCountAsync(options || {});
  }

  /**
   * Clear all packet logs
   */
  clearPackets(): number {
    return databaseService.clearPacketLogs();
  }

  /**
   * Clear all packet logs - async version for all backends
   */
  async clearPacketsAsync(): Promise<number> {
    return databaseService.clearPacketLogsAsync();
  }

  /**
   * Check if packet logging is enabled
   */
  async isEnabled(): Promise<boolean> {
    const enabled = await databaseService.getSettingAsync('packet_log_enabled');
    return enabled === '1';
  }

  /**
   * Get max packet count setting
   */
  async getMaxCount(): Promise<number> {
    const maxCountStr = await databaseService.getSettingAsync('packet_log_max_count');
    return maxCountStr ? parseInt(maxCountStr, 10) : 1000;
  }

  /**
   * Get max age in hours setting
   */
  async getMaxAgeHours(): Promise<number> {
    const maxAgeStr = await databaseService.getSettingAsync('packet_log_max_age_hours');
    return maxAgeStr ? parseInt(maxAgeStr, 10) : 24;
  }

  /**
   * Get packet counts grouped by node (for distribution charts)
   */
  async getPacketCountsByNodeAsync(options?: { since?: number; limit?: number; portnum?: number; sourceId?: string }): Promise<DbPacketCountByNode[]> {
    return databaseService.getPacketCountsByNodeAsync(options);
  }

  /**
   * Get distinct relay nodes for filter dropdowns
   */
  async getDistinctRelayNodesAsync(sourceId?: string): Promise<DbDistinctRelayNode[]> {
    return databaseService.getDistinctRelayNodesAsync(sourceId);
  }

  /**
   * Get packet counts grouped by portnum (for distribution charts)
   */
  async getPacketCountsByPortnumAsync(options?: { since?: number; from_node?: number; sourceId?: string }): Promise<DbPacketCountByPortnum[]> {
    return databaseService.getPacketCountsByPortnumAsync(options);
  }

  /**
   * Stop cleanup scheduler
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('🛑 Stopped packet log cleanup scheduler');
    }
  }
}

export default new PacketLogService();
