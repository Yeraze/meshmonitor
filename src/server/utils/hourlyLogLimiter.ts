import { logger } from '../../utils/logger.js';

/**
 * Rate-limits a family of diagnostic log lines to at most once per key per
 * hour, so a repeating check-cycle (e.g. the low-battery / inactive-node
 * notification services, which run every 60 minutes by default but can be
 * restarted or reconfigured to run more often) doesn't spam the log while
 * still surfacing the diagnostic at least once an hour for as long as the
 * underlying condition persists.
 *
 * Supersedes the once-per-process `Set<string>` gate previously used for the
 * MeshCore low-battery diagnostic (#3884) — a gate that fires exactly once
 * ever is nearly as unhelpful as no log at all when debugging a
 * long-running deployment (#4020).
 */
export class HourlyLogLimiter {
  private readonly lastLoggedAt = new Map<string, number>();
  private readonly intervalMs: number;

  constructor(intervalMs: number = 60 * 60 * 1000) {
    this.intervalMs = intervalMs;
  }

  /**
   * Log `message` at `level` for `key`, but only if this key hasn't been
   * logged within the configured interval (default: 1 hour).
   */
  log(key: string, level: 'info' | 'warn', message: string): void {
    const now = Date.now();
    const last = this.lastLoggedAt.get(key);
    if (last !== undefined && now - last < this.intervalMs) {
      return;
    }
    this.lastLoggedAt.set(key, now);
    if (level === 'warn') {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  }

  /**
   * Drop entries older than `maxAgeMs` (default: 7 days) to keep the map
   * from growing unbounded across long-running processes. Intended to be
   * called alongside a service's existing periodic cleanup (e.g. the
   * lastNotifiedNodes 7-day prune already run by the notification services).
   */
  prune(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, timestamp] of this.lastLoggedAt.entries()) {
      if (timestamp < cutoff) {
        this.lastLoggedAt.delete(key);
      }
    }
  }

  /** Test/debug helper — clears all rate-limit state. */
  reset(): void {
    this.lastLoggedAt.clear();
  }
}
