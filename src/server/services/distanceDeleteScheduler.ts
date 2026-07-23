import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { autoDeleteByDistanceService } from './autoDeleteByDistanceService.js';

/**
 * Per-source auto-delete-by-distance scheduler (issue #3901).
 *
 * Each source manager (MQTT broker, MQTT bridge, MeshCore) owns one of these,
 * mirroring the inline scheduler MeshtasticManager already runs. It reads the
 * source's own `autoDeleteByDistanceEnabled` / `autoDeleteByDistanceIntervalHours`
 * via `getSettingForSource(sourceId, …)` and drives the shared
 * `autoDeleteByDistanceService.runDeleteCycle(sourceId)` — which is source-scoped,
 * so a source only ever prunes its own nodes with its own home coordinate /
 * threshold. There is no global all-sources scheduler anymore.
 */
export class DistanceDeleteScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sourceId: string) {}

  /**
   * Start (or restart) the scheduler from this source's persisted settings.
   * A no-op (after clearing any existing timers) when the source has
   * auto-delete-by-distance disabled.
   */
  async start(): Promise<void> {
    this.stop();

    // Settings just changed (this is called on save) — drop the inline check's
    // cached config for this source so per-packet decisions pick up the new
    // home/threshold/action immediately rather than after the TTL (#3900).
    autoDeleteByDistanceService.clearInlineConfigCache(this.sourceId);

    const enabled = await databaseService.settings.getSettingForSource(
      this.sourceId,
      'autoDeleteByDistanceEnabled',
    );
    if (enabled !== 'true') {
      logger.debug(`🗑️ Auto-delete-by-distance disabled for source ${this.sourceId}`);
      return;
    }

    const intervalHoursStr = await databaseService.settings.getSettingForSource(
      this.sourceId,
      'autoDeleteByDistanceIntervalHours',
    );
    const intervalHours = parseInt(intervalHoursStr || '24', 10);
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

    logger.info(
      `🗑️ Starting auto-delete-by-distance scheduler for source ${this.sourceId} (interval: ${intervalHours}h)`,
    );

    // Initial run after 2 minutes (matches the prior singleton behavior).
    this.initialTimeout = setTimeout(() => {
      autoDeleteByDistanceService.runDeleteCycle(this.sourceId).catch((err) =>
        logger.error(`❌ Auto-delete-by-distance initial run failed for source ${this.sourceId}:`, err));
    }, 120_000);

    this.interval = setInterval(() => {
      autoDeleteByDistanceService.runDeleteCycle(this.sourceId).catch((err) =>
        logger.error(`❌ Auto-delete-by-distance run failed for source ${this.sourceId}:`, err));
    }, intervalMs);
  }

  /** Stop the scheduler (does not abort an in-progress delete cycle). */
  stop(): void {
    // Drop the inline check's cached config too (#3900). start() clears it, and
    // a settings save always goes through start(), but stop() can be called on
    // its own (e.g. source shutdown, or disabling the feature). Without this the
    // 60s-TTL cache could keep dropping out-of-range POSITIONs as "enabled" for
    // up to a minute after the feature was turned off.
    autoDeleteByDistanceService.clearInlineConfigCache(this.sourceId);

    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.debug(`⏹️ Auto-delete-by-distance scheduler stopped for source ${this.sourceId}`);
    }
  }

  /** True while a periodic timer is armed for this source. */
  get running(): boolean {
    return this.interval !== null;
  }
}
