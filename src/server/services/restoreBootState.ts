/**
 * "Was a backup restored on this boot?" (#6354)
 *
 * A system backup older than a retention window is wiped by the first purge
 * that runs after the restore: the telemetry purge 5s after boot once deleted
 * 540k rows from a 13-day-old backup as "older than 168h". On the boot that
 * performs a restore, the STARTUP run of each data-retention purge is skipped
 * with a warning, which gives the admin until the next scheduled purge to
 * export the data or raise the retention window. Scheduled runs are untouched.
 *
 * The state is in-process only: it concerns this boot and nothing else, so it
 * is never persisted. The module has no imports beyond the logger so a
 * retention service can use it without pulling in the restore machinery.
 *
 * Lifecycle (driven by `systemRestoreService`):
 *  - `markRestoreCheckStarted()` — server.ts calls this synchronously at boot,
 *    before any purge timer can fire. Startup purges wait for the check.
 *  - `markRestoredThisBoot()` — a restore succeeded.
 *  - `markRestoreCheckFinished()` — always called, restore or not.
 */
import { logger } from '../../utils/logger.js';

let restoredThisBoot = false;
let checkSettled: Promise<void> = Promise.resolve();
let settleCheck: (() => void) | null = null;

export function markRestoreCheckStarted(): void {
  if (settleCheck) return;
  checkSettled = new Promise<void>((resolve) => {
    settleCheck = resolve;
  });
}

export function markRestoredThisBoot(): void {
  restoredThisBoot = true;
}

export function markRestoreCheckFinished(): void {
  const settle = settleCheck;
  settleCheck = null;
  settle?.();
}

export function wasRestoredThisBoot(): boolean {
  return restoredThisBoot;
}

/**
 * Call at the top of a purge's STARTUP run (never the scheduled one). Waits
 * for the boot restore check, so a purge cannot race a restore still writing
 * rows. Returns true, after logging a warning, when the run must be skipped.
 *
 * @param job       what the purge removes, e.g. "telemetry"
 * @param retention the retention window, e.g. "168h" or "7 days"
 * @param nextRun   when the next scheduled purge runs, e.g. "in about 1 hour"
 */
export async function skipStartupPurgeAfterRestore(
  job: string,
  retention: string,
  nextRun: string,
): Promise<boolean> {
  await checkSettled;
  if (!restoredThisBoot) return false;
  logger.warn(
    `⚠️ A backup was restored on this boot, so the startup ${job} purge was skipped. ` +
      `The retention window is ${retention}: the next scheduled purge (${nextRun}) will remove older rows. ` +
      'Export the data or raise the retention window before then to keep it.',
  );
  return true;
}

/** Test-only: return to the "no restore this boot" state. */
export function resetRestoreBootStateForTests(): void {
  restoredThisBoot = false;
  markRestoreCheckFinished();
  checkSettled = Promise.resolve();
}
