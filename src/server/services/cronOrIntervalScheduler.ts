import { logger } from '../../utils/logger.js';
import { validateCron, scheduleCron, type CronJob } from '../utils/cronScheduler.js';

/**
 * Discriminated union describing which scheduling mechanism to use and its
 * associated configuration.  The caller computes this before constructing the
 * scheduler so all protocol-specific logic (settings reads, clamping, defaults)
 * stays in the manager.
 */
export type ScheduleMode =
  | { kind: 'cron'; expression: string }
  | { kind: 'interval'; intervalMs: number };

/**
 * Protocol-agnostic options for a {@link CronOrIntervalScheduler} instance.
 *
 * The scheduler owns only the *mechanism*: arming either a CronJob or a
 * setInterval handle, firing `onTick` each trigger, and idempotent
 * start/stop.  All protocol knowledge (connected-gate, enabled-gate,
 * on-start semantics, templating, send paths, follow-up bursts) stays in
 * the caller's `onTick` and the caller's arming decision.
 */
export interface CronOrIntervalSchedulerOptions {
  /** Identifier used in log lines, e.g. `MeshCore:${sourceId}` / `Meshtastic:${sourceId}`. */
  label: string;
  /** Whether to use cron or interval scheduling, and the associated value.
   *  Caller is responsible for reading settings, applying defaults, and
   *  clamping interval values before building this object. */
  mode: ScheduleMode;
  /**
   * Fired each schedule hit.  Caller owns all gates (connected, enabled,
   * airtime) and the actual send.  May be async; any rejection is caught and
   * logged as a warning so it never escapes into an unhandled-rejection.
   */
  onTick: () => void | Promise<void>;
}

/**
 * Protocol-agnostic cron-or-interval scheduler.
 *
 * One instance per connection/source; created lazily by the owning manager's
 * arming method (`startAnnounceScheduler` / `startAutoAnnounce`) and replaced
 * on every settings change.
 *
 * ### start() semantics
 * Always **stop-then-rearm** — if called while already running it stops the
 * existing handle first, matching the "always restart on settings change"
 * semantics of both the Meshtastic and MeshCore announce schedulers.
 *
 * ### Cron validation
 * An invalid cron expression causes `start()` to return `false` with a
 * warning logged; no arm is installed and the caller must not fall back to
 * interval mode (matching both current behaviors).
 *
 * ### Future adopters
 * The same arming skeleton is copy-pasted in the timer-trigger schedulers
 * (both protocols) and the distance-delete scheduler.  Those are candidates
 * for adopting this primitive in a follow-up task (epic #3962 Phase 2).
 */
export class CronOrIntervalScheduler {
  private cronJob: CronJob | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CronOrIntervalSchedulerOptions) {}

  /**
   * Arm the scheduler.
   *
   * Stops any currently running handle first (stop+rearm), then arms the
   * appropriate mechanism for the configured {@link ScheduleMode}.
   *
   * @returns `true` if armed successfully; `false` if the cron expression
   *   failed `validateCron` (warning logged, nothing armed).
   */
  start(): boolean {
    // Stop+rearm — faithful to both managers' "always restart" semantics.
    this.stop();

    if (this.opts.mode.kind === 'cron') {
      const { expression } = this.opts.mode;
      if (!validateCron(expression)) {
        logger.warn(
          `[${this.opts.label}] CronOrIntervalScheduler: invalid cron expression "${expression}", not scheduling`,
        );
        return false;
      }
      this.cronJob = scheduleCron(expression, () => {
        void new Promise<void>((resolve) => { resolve(this.opts.onTick()); }).catch((err: unknown) => {
          logger.warn(
            `[${this.opts.label}] CronOrIntervalScheduler: onTick threw: ${(err as Error).message}`,
          );
        });
      });
      logger.debug(`[${this.opts.label}] CronOrIntervalScheduler: cron armed (${expression})`);
    } else {
      const { intervalMs } = this.opts.mode;
      this.intervalHandle = setInterval(() => {
        void new Promise<void>((resolve) => { resolve(this.opts.onTick()); }).catch((err: unknown) => {
          logger.warn(
            `[${this.opts.label}] CronOrIntervalScheduler: onTick threw: ${(err as Error).message}`,
          );
        });
      }, intervalMs);
      logger.debug(
        `[${this.opts.label}] CronOrIntervalScheduler: interval armed (${intervalMs}ms)`,
      );
    }
    return true;
  }

  /** Clear the active cron job or interval handle.  Idempotent. */
  stop(): void {
    if (this.cronJob) {
      try {
        this.cronJob.stop();
      } catch {
        /* ignore stale-job errors */
      }
      this.cronJob = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** `true` while a cron job or interval timer is armed. */
  get running(): boolean {
    return this.cronJob !== null || this.intervalHandle !== null;
  }
}
