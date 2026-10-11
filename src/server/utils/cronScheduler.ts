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

/**
 * Shortest gap between consecutive fires of a cron, in ms, or null when the
 * expression is invalid or fires fewer than twice. Sampled over the next
 * `sample` fires from `from`: a cron repeats its pattern daily or hourly, so
 * a short gap shows up well inside that.
 */
export function cronMinGapMs(expression: string, options?: { timezone?: string; from?: Date; sample?: number }): number | null {
  let job: Cron;
  try {
    job = new Cron(expression, { paused: true, timezone: options?.timezone }, () => {});
  } catch {
    return null;
  }
  try {
    const runs = job.nextRuns(options?.sample ?? 300, options?.from ?? new Date());
    let min: number | null = null;
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i].getTime() - runs[i - 1].getTime();
      if (min === null || gap < min) min = gap;
    }
    return min;
  } finally {
    job.stop();
  }
}
