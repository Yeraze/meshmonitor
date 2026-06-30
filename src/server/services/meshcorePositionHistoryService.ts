import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Service for the MeshCore position-history trail (#3852).
 *
 * Position points are written transparently by `MeshCoreRepository.upsertNode`
 * whenever a node's GPS fix changes; this service owns only the *retention*
 * side — a periodic sweep that drops points older than the configured rolling
 * window (default 7 days, per the issue). The window is configurable via the
 * `meshcore_position_history_retention_days` setting, mirroring the packet-log
 * service's age-based cleanup.
 */
class MeshCorePositionHistoryService {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
  private readonly DEFAULT_RETENTION_DAYS = 7;

  constructor() {
    this.startCleanupScheduler();
  }

  private startCleanupScheduler(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    logger.debug('🧹 Starting MeshCore position-history cleanup scheduler (runs hourly)');
    // Sweep once shortly after boot, then on the interval.
    setTimeout(() => void this.runCleanup(), 30_000);
    this.cleanupInterval = setInterval(() => {
      void this.runCleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Remove position-history points older than the configured retention window.
   */
  async runCleanup(): Promise<void> {
    try {
      const retentionDays = await this.getRetentionDays();
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const removed = await databaseService.meshcore.deletePositionHistoryOlderThan(cutoff);
      if (removed > 0) {
        logger.debug(`🧹 MeshCore position-history cleanup: removed ${removed} old points`);
      }
    } catch (error) {
      logger.error('❌ Failed to cleanup MeshCore position history:', error);
    }
  }

  async getPositionHistory(sourceId: string, publicKey: string, since?: number) {
    return databaseService.meshcore.getPositionHistory(sourceId, publicKey, since);
  }

  async clearPositionHistory(sourceId?: string): Promise<number> {
    return databaseService.meshcore.deleteAllPositionHistory(sourceId);
  }

  /**
   * Rolling retention window in days. Defaults to 7 (the issue's spec); a
   * positive integer override is read from settings.
   */
  async getRetentionDays(): Promise<number> {
    const raw = await databaseService.getSettingAsync('meshcore_position_history_retention_days');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.DEFAULT_RETENTION_DAYS;
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.debug('🛑 Stopped MeshCore position-history cleanup scheduler');
    }
  }
}

export default new MeshCorePositionHistoryService();
