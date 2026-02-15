import databaseService, { DbPacketLog, DbPacketCountByNode, DbPacketCountByPortnum } from '../../services/database.js';
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
  runCleanup(): void {
    try {
      const deletedCount = databaseService.cleanupOldPacketLogs();
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
  logPacket(packet: Omit<DbPacketLog, 'id' | 'created_at'>): number {
    try {
      return databaseService.insertPacketLog(packet);
    } catch (error) {
      logger.error('❌ Failed to log packet:', error);
      return 0;
    }
  }

  /**
   * Get packet logs with optional filters
   */
  getPackets(options: {
    offset?: number;
    limit?: number;
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
  }): DbPacketLog[] {
    return databaseService.getPacketLogs(options);
  }

  /**
   * Get packet logs with optional filters - async version for PostgreSQL/MySQL
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
  }): Promise<DbPacketLog[]> {
    return databaseService.getPacketLogsAsync(options);
  }

  /**
   * Get single packet by ID
   */
  getPacketById(id: number): DbPacketLog | null {
    return databaseService.getPacketLogById(id);
  }

  /**
   * Get total packet count with optional filters
   */
  getPacketCount(options?: {
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
  }): number {
    return databaseService.getPacketLogCount(options || {});
  }

  /**
   * Get total packet count with optional filters - async version for PostgreSQL/MySQL
   */
  async getPacketCountAsync(options?: {
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
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
   * Clear all packet logs - async version for PostgreSQL/MySQL
   */
  async clearPacketsAsync(): Promise<number> {
    return databaseService.clearPacketLogsAsync();
  }

  /**
   * Check if packet logging is enabled
   */
  isEnabled(): boolean {
    const enabled = databaseService.getSetting('packet_log_enabled');
    return enabled === '1';
  }

  /**
   * Get max packet count setting
   */
  getMaxCount(): number {
    const maxCountStr = databaseService.getSetting('packet_log_max_count');
    return maxCountStr ? parseInt(maxCountStr, 10) : 1000;
  }

  /**
   * Get max age in hours setting
   */
  getMaxAgeHours(): number {
    const maxAgeStr = databaseService.getSetting('packet_log_max_age_hours');
    return maxAgeStr ? parseInt(maxAgeStr, 10) : 24;
  }

  /**
   * Get packet counts grouped by node (for distribution charts)
   */
  async getPacketCountsByNodeAsync(options?: { since?: number; limit?: number; portnum?: number }): Promise<DbPacketCountByNode[]> {
    return databaseService.getPacketCountsByNodeAsync(options);
  }

  /**
   * Get packet counts grouped by portnum (for distribution charts)
   */
  async getPacketCountsByPortnumAsync(options?: { since?: number; from_node?: number }): Promise<DbPacketCountByPortnum[]> {
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
