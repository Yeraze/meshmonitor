import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import type { DbMeshCorePacket, MeshCorePacketQuery } from '../../db/repositories/meshcore.js';

/**
 * Service for the MeshCore Packet Monitor — the OTA-packet analogue of
 * `packetLogService` for Meshtastic. Wraps the MeshCore repository's
 * packet-log methods, exposes the opt-in enable/retention settings, and
 * runs a periodic retention sweep (age + per-source count cap).
 */
class MeshCorePacketLogService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
  private readonly DEFAULT_MAX_COUNT = 1000;
  private readonly DEFAULT_MAX_AGE_HOURS = 24;

  constructor() {
    this.startCleanupScheduler();
  }

  private startCleanupScheduler(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.debug('🧹 Starting MeshCore packet log cleanup scheduler (runs every 15 minutes)');
    this.cleanupInterval = setInterval(() => {
      void this.runCleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Remove rows older than the configured max age, then trim each source's
   * log down to the configured max count.
   */
  async runCleanup(): Promise<void> {
    try {
      const maxAgeHours = await this.getMaxAgeHours();
      const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
      let removed = await databaseService.meshcore.deletePacketsOlderThan(cutoff);

      const maxCount = await this.getMaxCount();
      const sourceIds = await databaseService.meshcore.getPacketLogSourceIds();
      for (const sourceId of sourceIds) {
        removed += await databaseService.meshcore.trimPacketsToCount(sourceId, maxCount);
      }

      if (removed > 0) {
        logger.debug(`🧹 MeshCore packet log cleanup: removed ${removed} old packets`);
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup MeshCore packet logs:', error);
    }
  }

  /**
   * Persist one OTA packet. Best-effort: a failure must not break the
   * MeshCore message stream.
   */
  async logPacket(packet: DbMeshCorePacket): Promise<void> {
    try {
      await databaseService.meshcore.insertPacket(packet);
    } catch (error) {
      logger.error('❌ Failed to log MeshCore packet:', error);
    }
  }

  async getPackets(query: MeshCorePacketQuery): Promise<DbMeshCorePacket[]> {
    return databaseService.meshcore.getPackets(query);
  }

  async getPacketCount(query: MeshCorePacketQuery): Promise<number> {
    return databaseService.meshcore.getPacketCount(query);
  }

  async clearPackets(sourceId?: string): Promise<number> {
    return databaseService.meshcore.deleteAllPackets(sourceId);
  }

  /** MeshCore OTA-packet capture is opt-in and off by default. */
  async isEnabled(): Promise<boolean> {
    const enabled = await databaseService.getSettingAsync('meshcore_packet_log_enabled');
    return enabled === '1';
  }

  async getMaxCount(): Promise<number> {
    const raw = await databaseService.getSettingAsync('meshcore_packet_log_max_count');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_MAX_COUNT;
  }

  async getMaxAgeHours(): Promise<number> {
    const raw = await databaseService.getSettingAsync('meshcore_packet_log_max_age_hours');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_MAX_AGE_HOURS;
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('🛑 Stopped MeshCore packet log cleanup scheduler');
    }
  }
}

export default new MeshCorePacketLogService();
