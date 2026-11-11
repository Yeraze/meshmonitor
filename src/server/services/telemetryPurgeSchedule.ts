/**
 * Telemetry retention purge: one run 5s after boot, then hourly.
 *
 * Moved out of server.ts so the startup/scheduled split is testable (#6354):
 * the STARTUP run is skipped on a boot that restored a backup, so restored
 * telemetry older than the window survives until the first hourly run. The
 * hourly run never consults the restore state.
 */
import { logger } from '../../utils/logger.js';
import { FAVORITE_STORAGE_DAYS_DEFAULT } from '../../utils/telemetryRetention.js';
import { TELEMETRY_RETENTION_HOURS } from '../../utils/telemetryRangePresets.js';
import { skipStartupPurgeAfterRestore } from './restoreBootState.js';

/** Keep telemetry for 7 days (168 hours). */
export { TELEMETRY_RETENTION_HOURS };
/**
 * Fallback retention for FAVORITED telemetry when no namespace configures one.
 * The real window comes from each source's `favoriteTelemetryStorageDays`,
 * resolved inside purgeOldTelemetryAsync (#5080).
 */
export const FAVORITE_TELEMETRY_DEFAULT_DAYS = FAVORITE_STORAGE_DAYS_DEFAULT;
export const TELEMETRY_PURGE_INTERVAL_MS = 60 * 60 * 1000;
export const TELEMETRY_STARTUP_PURGE_DELAY_MS = 5000;

export interface TelemetryPurgeDb {
  waitForReady(): Promise<void>;
  purgeOldTelemetryAsync(hoursToKeep: number, favoriteDaysToKeep?: number): Promise<number>;
}

/** The hourly run. Never throws. */
export async function runScheduledTelemetryPurge(db: TelemetryPurgeDb): Promise<number> {
  try {
    // Long migrations (e.g. on big MySQL telemetry tables) can keep the DB
    // unready well past the first tick — wait before touching repos.
    await db.waitForReady();
    const purgedCount = await db.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, FAVORITE_TELEMETRY_DEFAULT_DAYS);
    if (purgedCount > 0) {
      logger.debug(`⏰ Hourly telemetry purge completed: removed ${purgedCount} records`);
    }
    return purgedCount;
  } catch (error) {
    logger.error('Error during telemetry purge:', error);
    return 0;
  }
}

/** The run shortly after boot; skipped after a restore (#6354). Never throws. */
export async function runStartupTelemetryPurge(db: TelemetryPurgeDb): Promise<number> {
  try {
    // Wait for DB ready: on a fresh upgrade, schema migrations (e.g. 032 dedupe
    // on a large MySQL telemetry table) can run longer than the startup delay,
    // and accessing databaseService.settings before init throws.
    await db.waitForReady();
    if (await skipStartupPurgeAfterRestore('telemetry', `${TELEMETRY_RETENTION_HOURS}h`, 'in about 1 hour')) {
      return 0;
    }
    return await db.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, FAVORITE_TELEMETRY_DEFAULT_DAYS);
  } catch (error) {
    logger.error('Error during initial telemetry purge:', error);
    return 0;
  }
}

/** Arm both timers. Called once from server.ts. */
export function startTelemetryPurgeSchedule(db: TelemetryPurgeDb): void {
  setInterval(() => void runScheduledTelemetryPurge(db), TELEMETRY_PURGE_INTERVAL_MS);
  setTimeout(() => void runStartupTelemetryPurge(db), TELEMETRY_STARTUP_PURGE_DELAY_MS);
}
