/**
 * Position Estimation Scheduler (global singleton)
 *
 * Runs the global, batch position estimator (positionEstimationService) on a
 * simple fixed interval — "every N hours" — rather than in realtime. See the
 * plan for issue #3271. Modeled on databaseMaintenanceService: a once-a-minute
 * tick checks whether a run is due based on the configured frequency.
 *
 * Settings (see src/server/constants/settings.ts):
 *   - position_estimation_enabled         (default true)
 *   - position_estimation_frequency_hours (default 6)
 *   - position_estimation_lookback_hours  (default 168 = 7 days)
 *
 * On first boot after migration 082 (no prior run recorded) it runs once
 * immediately to backfill estimates from stored history.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { positionEstimationService, type RecomputeResult } from './positionEstimationService.js';

const LAST_RUN_KEY = 'position_estimation_last_run';

export const DEFAULT_FREQUENCY_HOURS = 6;
export const DEFAULT_LOOKBACK_HOURS = 168; // 7 days
const MIN_FREQUENCY_HOURS = 0.5;
const MIN_LOOKBACK_HOURS = 1;
const CHECK_INTERVAL_MS = 60_000;

/**
 * Pure due-check: a run is due if it has never run, or if at least
 * frequencyHours have elapsed since the last run.
 */
export function isRunDue(lastRunMs: number | null, frequencyHours: number, nowMs: number): boolean {
  if (lastRunMs === null) return true;
  return nowMs - lastRunMs >= frequencyHours * 60 * 60 * 1000;
}

export interface EstimationStatus {
  running: boolean;
  inProgress: boolean;
  enabled: boolean;
  frequencyHours: number;
  lookbackHours: number;
  lastRunTime: number | null;
  lastRunResult: RecomputeResult | null;
}

class PositionEstimationScheduler {
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private inProgress = false;
  private runLock: Promise<RecomputeResult> | null = null;
  private lastRunTime: number | null = null;
  private lastRunResult: RecomputeResult | null = null;

  initialize(): void {
    this.start();
    logger.info('✅ Position estimation scheduler initialized');
  }

  start(): void {
    if (this.isRunning) {
      logger.warn('⚠️ Position estimation scheduler is already running');
      return;
    }
    this.isRunning = true;
    this.schedulerInterval = setInterval(() => {
      this.checkAndRun().catch((error) => {
        logger.error('❌ Error in position estimation scheduler check:', error);
      });
    }, CHECK_INTERVAL_MS);
    logger.info('▶️ Position estimation scheduler started (checks every minute)');
  }

  stop(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.isRunning = false;
    logger.info('⏹️ Position estimation scheduler stopped');
  }

  private async getEnabled(): Promise<boolean> {
    // Default ON: only disabled when explicitly set to 'false'.
    const value = await databaseService.settings.getSetting('position_estimation_enabled');
    return value !== 'false';
  }

  private async getFrequencyHours(): Promise<number> {
    const raw = parseFloat(
      (await databaseService.settings.getSetting('position_estimation_frequency_hours')) || String(DEFAULT_FREQUENCY_HOURS)
    );
    if (!Number.isFinite(raw) || raw < MIN_FREQUENCY_HOURS) return DEFAULT_FREQUENCY_HOURS;
    return raw;
  }

  private async getLookbackHours(): Promise<number> {
    const raw = parseFloat(
      (await databaseService.settings.getSetting('position_estimation_lookback_hours')) || String(DEFAULT_LOOKBACK_HOURS)
    );
    if (!Number.isFinite(raw) || raw < MIN_LOOKBACK_HOURS) return DEFAULT_LOOKBACK_HOURS;
    return raw;
  }

  private async getLastRun(): Promise<number | null> {
    if (this.lastRunTime !== null) return this.lastRunTime;
    const stored = await databaseService.settings.getSetting(LAST_RUN_KEY);
    if (!stored) return null;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Tick handler: run estimation if enabled and due. */
  private async checkAndRun(): Promise<void> {
    if (!(await this.getEnabled())) return;
    if (this.inProgress) return;

    const frequencyHours = await this.getFrequencyHours();
    const lastRun = await this.getLastRun();
    if (!isRunDue(lastRun, frequencyHours, Date.now())) return;

    await this.runNow();
  }

  /**
   * Run estimation now (manual trigger or scheduler). Uses a promise lock to
   * prevent overlapping runs. Records the run time on success or failure to
   * avoid retry storms.
   */
  async runNow(): Promise<RecomputeResult> {
    if (this.runLock) {
      throw new Error('Position estimation already in progress');
    }
    this.runLock = this.execute();
    try {
      return await this.runLock;
    } finally {
      this.runLock = null;
    }
  }

  private async execute(): Promise<RecomputeResult> {
    this.inProgress = true;
    try {
      const lookbackHours = await this.getLookbackHours();
      const result = await positionEstimationService.recomputeAll({
        lookbackMs: lookbackHours * 60 * 60 * 1000,
      });
      this.lastRunResult = result;
      return result;
    } finally {
      this.inProgress = false;
      this.lastRunTime = Date.now();
      try {
        await databaseService.settings.setSetting(LAST_RUN_KEY, String(this.lastRunTime));
      } catch (error) {
        logger.error('❌ Failed to record position_estimation_last_run:', error);
      }
    }
  }

  async getStatus(): Promise<EstimationStatus> {
    const [enabled, frequencyHours, lookbackHours, lastRun] = await Promise.all([
      this.getEnabled(),
      this.getFrequencyHours(),
      this.getLookbackHours(),
      this.getLastRun(),
    ]);
    return {
      running: this.isRunning,
      inProgress: this.inProgress,
      enabled,
      frequencyHours,
      lookbackHours,
      lastRunTime: lastRun,
      lastRunResult: this.lastRunResult,
    };
  }
}

export const positionEstimationScheduler = new PositionEstimationScheduler();
