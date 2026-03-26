/**
 * Cron scheduling utilities using croner.
 *
 * Replaces node-cron with croner for better missed-execution recovery.
 * croner's `catch: true` option automatically runs jobs that were missed
 * due to event loop blocking, solving the issue reported in #2409.
 *
 * API mapping from node-cron:
 *   cron.validate(expr)              → validateCron(expr)
 *   cron.schedule(expr, fn)          → scheduleCron(expr, fn)
 *   cron.schedule(expr, fn, { tz })  → scheduleCron(expr, fn, { timezone: tz })
 *   job.stop()                       → job.stop()
 */
import { Cron } from 'croner';

export type CronJob = Cron;

/**
 * Validate a cron expression without scheduling it.
 */
export function validateCron(expression: string): boolean {
  try {
    // Croner validates in the constructor; create a pattern check without scheduling
    const job = new Cron(expression, { paused: true }, () => {});
    job.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Schedule a cron job with automatic missed-execution recovery.
 */
export function scheduleCron(
  expression: string,
  callback: () => void | Promise<void>,
  options?: { timezone?: string }
): CronJob {
  return new Cron(expression, {
    catch: true, // Recover missed executions (#2409)
    timezone: options?.timezone,
  }, callback);
}
