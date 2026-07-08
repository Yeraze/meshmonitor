import { logger } from '../../utils/logger.js';

/**
 * Protocol-agnostic options for a {@link HeartbeatScheduler} instance.
 *
 * The scheduler owns only the *mechanism*: interval management, start/stop,
 * in-flight guard, and connected-gate (pre- AND post-await).  All protocol
 * knowledge (what a probe is, what a failure means, when to reconnect) stays
 * in the caller via the callbacks below.
 */
export interface HeartbeatSchedulerOptions {
  /** Identifier used in log lines, e.g. `MeshCore:${sourceId}`. */
  label: string;
  /** Probe period in milliseconds. Must be > 0; caller must not start when the
   *  corresponding feature is disabled (interval <= 0 check is the caller's
   *  responsibility — the scheduler requires a positive interval). */
  intervalMs: number;
  /** Forwarded verbatim to `probe()`. */
  timeoutMs: number;
  /**
   * The wire operation to run each tick.
   * - Resolve `true`  → link is alive → `onSuccess` is called.
   * - Resolve `false` → probe reported failure → `onFailure` is called.
   * - Reject          → probe threw → `onFailure` is called with the error.
   */
  probe: (timeoutMs: number) => Promise<boolean>;
  /**
   * Returns `true` only while the link is usable.  Called twice per tick:
   *   1. Before the probe starts (pre-gate — skip stale ticks).
   *   2. After the probe resolves/rejects (post-gate — drop late results that
   *      arrived after a teardown).
   * Must read live state (closure / instance method) — never a captured value.
   */
  isConnected: () => boolean;
  /** Called on a successful probe. Caller should reset the failure counter and
   *  emit the `heartbeat_ok` event. */
  onSuccess: (latencyMs: number) => void;
  /** Called on a failed probe (both `false` return and rejection).  Caller
   *  should increment the failure counter, emit `heartbeat_failed`, and trigger
   *  reconnect when the threshold is reached. */
  onFailure: (err: Error) => void;
}

/**
 * Protocol-agnostic heartbeat/status-probe scheduler.
 *
 * One instance per connection; created lazily by the owning manager's
 * `startHeartbeat()` and dropped in `stopHeartbeat()`.
 *
 * The scheduler is deliberately free of any knowledge of MeshCore, Meshtastic,
 * sendCommand vocabulary, reconnect state machines, or event systems.  Those
 * concerns belong to the caller.
 */
export class HeartbeatScheduler {
  private timer: NodeJS.Timeout | null = null;
  private probeInFlight: boolean = false;

  constructor(private readonly opts: HeartbeatSchedulerOptions) {}

  /** Start the probe loop.  Idempotent — no-op if already running. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.runProbe().catch((err) => {
        logger.warn(`[${this.opts.label}] heartbeat probe threw: ${(err as Error).message}`);
      });
    }, this.opts.intervalMs);
  }

  /** Clear the interval and the in-flight flag.  Safe to call repeatedly. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.probeInFlight = false;
  }

  /** `true` while the interval timer is armed. */
  get running(): boolean {
    return this.timer !== null;
  }

  private async runProbe(): Promise<void> {
    // In-flight guard — skip overlapping probe.
    if (this.probeInFlight) return;
    // Pre-probe connected gate.
    if (!this.opts.isConnected()) return;

    this.probeInFlight = true;
    const startedAt = Date.now();
    try {
      const success = await this.opts.probe(this.opts.timeoutMs);
      // Post-await connected gate: drop late result from a probe that resolved
      // after a teardown (race between the in-flight probe and disconnect).
      if (!this.opts.isConnected()) return;
      if (success) {
        this.opts.onSuccess(Date.now() - startedAt);
      } else {
        this.opts.onFailure(new Error('probe failed'));
      }
    } catch (err) {
      // Post-await connected gate: same race for the throw path.
      if (!this.opts.isConnected()) return;
      this.opts.onFailure(err as Error);
    } finally {
      this.probeInFlight = false;
    }
  }
}
