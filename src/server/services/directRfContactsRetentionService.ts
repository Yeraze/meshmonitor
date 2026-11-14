import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { clampDirectRfRetentionDays, DIRECT_RF_RETENTION_SETTING } from '../../utils/directRfContacts.js';
import { directRfDayBucket, DIRECT_RF_DAY_MS } from '../../db/repositories/directRfContacts.js';
import { skipStartupPurgeAfterRestore } from './restoreBootState.js';

/**
 * Retention sweep for `direct_rf_contacts` (#6210), modelled on
 * `coverageRetentionService`: explicit `start()`/`stop()` (importing the
 * module never starts a timer), first sweep 30 s after start, then hourly.
 *
 * Cutoff-based and idempotent: it computes the cutoff fresh on every run and
 * keeps no last-fire state, so a restart or a settings save cannot cause a
 * burst. It only deletes rows; it sends nothing on the mesh.
 *
 * The setting is global (`direct_rf_contacts_retention_days`, default 30).
 * Whole UTC days are kept: a row goes once its day started before
 * `floor(now - retentionDays)`.
 */
class DirectRfContactsRetentionService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialSweepTimer: NodeJS.Timeout | null = null;
  private readonly SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  private readonly INITIAL_DELAY_MS = 30 * 1000;

  start(): void {
    if (this.intervalId || this.initialSweepTimer) {
      logger.warn('Direct RF Contacts retention sweep already running');
      return;
    }
    logger.debug('Starting Direct RF Contacts retention sweep (runs hourly)');
    this.initialSweepTimer = setTimeout(() => {
      this.initialSweepTimer = null;
      void this.runStartupCleanup();
    }, this.INITIAL_DELAY_MS);
    this.intervalId = setInterval(() => {
      void this.runCleanup();
    }, this.SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialSweepTimer) {
      clearTimeout(this.initialSweepTimer);
      this.initialSweepTimer = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** The first UTC day kept for `retentionDays` at `nowMs`. */
  cutoffDayBucket(retentionDays: number, nowMs: number): number {
    return directRfDayBucket(nowMs - retentionDays * DIRECT_RF_DAY_MS);
  }

  /** Delete day rows older than the window. Never throws. */
  async runCleanup(nowMs: number = Date.now()): Promise<number> {
    try {
      const days = await this.getRetentionDays();
      const removed = await databaseService.directRfContacts.purgeOlderThan(this.cutoffDayBucket(days, nowMs));
      if (removed > 0) {
        logger.debug(`Direct RF Contacts retention sweep: removed ${removed} day row(s)`);
      }
      return removed;
    } catch (error) {
      logger.error('Failed to run Direct RF Contacts retention sweep:', error);
      return 0;
    }
  }

  /** First sweep after boot; skipped on a boot that restored a backup (#6354). */
  async runStartupCleanup(): Promise<void> {
    try {
      const days = await this.getRetentionDays();
      if (await skipStartupPurgeAfterRestore('Direct RF Contacts', `${days} days`, 'in about 1 hour')) {
        return;
      }
    } catch (error) {
      logger.error('Direct RF Contacts retention startup check failed:', error);
      return;
    }
    await this.runCleanup();
  }

  async getRetentionDays(): Promise<number> {
    return clampDirectRfRetentionDays(await databaseService.getSettingAsync(DIRECT_RF_RETENTION_SETTING));
  }
}

export const directRfContactsRetentionService = new DirectRfContactsRetentionService();
