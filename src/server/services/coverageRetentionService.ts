import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { clampCoverageRetentionDays } from '../../utils/coverage.js';

/**
 * Retention sweep for `coverage_receptions` (Coverage Report epic #5277,
 * Phase 1 WP2).
 *
 * Global by design — `coverage_receptions.purgeOlderThan` is the single purge
 * seam documented in COVERAGE_P1_SPEC.md §2.3/§2.7 (the future P4 saved-survey
 * exemption is added there, and nowhere else). Retention itself is a single
 * global setting (`coverage_retention_days`), not per-source.
 *
 * Modelled on `duplicateKeySchedulerService.ts`: an explicit `start()`/`stop()`
 * pair rather than auto-starting in the constructor, so importing this module
 * (e.g. from a test) never spins up a live timer. `src/server/server.ts` calls
 * `start()` once, after `databaseService.waitForReady()`, next to the
 * telemetry purge.
 *
 * The sweep is cutoff-based and idempotent — it computes
 * `cutoff = now - retentionDays * 86_400_000` fresh on every run and keeps no
 * last-fire state, so a restart or a settings save can never cause a burst or
 * reset a cooldown (mesh-impact checklist §0.3).
 */
class CoverageRetentionService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialSweepTimer: NodeJS.Timeout | null = null;
  private readonly SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
  private readonly INITIAL_DELAY_MS = 30 * 1000; // first sweep 30s after start

  /**
   * Start the hourly sweep. Idempotent — a second call while already running
   * is a no-op (mirrors duplicateKeySchedulerService).
   */
  start(): void {
    if (this.intervalId || this.initialSweepTimer) {
      logger.warn('🧹 Coverage retention sweep already running');
      return;
    }

    logger.debug('🧹 Starting Coverage Report retention sweep (runs hourly)');

    this.initialSweepTimer = setTimeout(() => {
      this.initialSweepTimer = null;
      void this.runCleanup();
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
      logger.debug('🛑 Stopped Coverage Report retention sweep');
    }
  }

  /**
   * Remove `coverage_receptions` rows older than the configured retention
   * window. Never throws — a purge failure is logged, not propagated, so it
   * can never take down the interval timer that calls it.
   *
   * Loads the saved-survey exemption windows (#5277 Phase 4b WP1,
   * `effectiveSurveyEndAt` resolved at `Date.now()`) and passes them to the
   * single purge seam so a survey's receptions survive the sweep even when
   * they fall outside the retention cutoff.
   */
  async runCleanup(): Promise<void> {
    try {
      const retentionDays = await this.getRetentionDays();
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const exemptions = await databaseService.coverageSurveys.getExemptionWindows(Date.now());
      const removed = await databaseService.coverageReceptions.purgeOlderThan(cutoff, exemptions);
      if (removed > 0) {
        logger.debug(`🧹 Coverage Report retention sweep: removed ${removed} old reception(s)`);
      }
    } catch (error) {
      logger.error('❌ Failed to run Coverage Report retention sweep:', error);
    }
  }

  /**
   * Global retention window in days, clamped to
   * `[COVERAGE_RETENTION_MIN_DAYS, COVERAGE_RETENTION_MAX_DAYS]`. Bare-key
   * read via `getSettingAsync` — `coverage_retention_days` is
   * `GLOBAL_ONLY_SETTINGS_KEYS`, so there is no per-source variant to read.
   */
  async getRetentionDays(): Promise<number> {
    // getSettingAsync returns `null` for a missing key; clampCoverageRetentionDays
    // treats `null` (as well as `undefined`) as "missing" and returns the
    // 7-day default, so no normalisation is needed here.
    const raw = await databaseService.getSettingAsync('coverage_retention_days');
    return clampCoverageRetentionDays(raw);
  }
}

export const coverageRetentionService = new CoverageRetentionService();
