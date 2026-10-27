/**
 * Spots a node that keeps closing the TCP link seconds after we connect
 * (#5974).
 *
 * Meshtastic firmware serves one TCP API client at a time: a new connection
 * makes the node force-close the old one. Two clients pointed at the same node
 * (a phone app over WiFi, Home Assistant, the Python CLI, a second MeshMonitor)
 * take turns knocking each other off, which from our side looks like a link
 * the node closes again and again within seconds of connecting.
 *
 * Pure bookkeeping, no I/O: the caller feeds it connect/close times and logs
 * the message it returns. It returns a message only once the streak reaches
 * the threshold, and then at most once per rate-limit window, so a loop that
 * cycles every few seconds does not flood the log.
 */
export interface QuickCloseDetectorOptions {
  /** A close this soon after connect counts as "quick". */
  quickCloseMs?: number;
  /** Consecutive quick closes before warning. */
  threshold?: number;
  /** Minimum gap between two warnings. */
  rateLimitMs?: number;
}

export const QUICK_CLOSE_MS = 5_000;
export const QUICK_CLOSE_THRESHOLD = 3;
export const QUICK_CLOSE_WARN_INTERVAL_MS = 15 * 60 * 1000;

export class QuickCloseDetector {
  private readonly quickCloseMs: number;
  private readonly threshold: number;
  private readonly rateLimitMs: number;
  private connectedAt: number | null = null;
  private streak = 0;
  private lastWarnAt: number | null = null;

  constructor(opts: QuickCloseDetectorOptions = {}) {
    this.quickCloseMs = opts.quickCloseMs ?? QUICK_CLOSE_MS;
    this.threshold = opts.threshold ?? QUICK_CLOSE_THRESHOLD;
    this.rateLimitMs = opts.rateLimitMs ?? QUICK_CLOSE_WARN_INTERVAL_MS;
  }

  noteConnected(now: number = Date.now()): void {
    this.connectedAt = now;
  }

  /**
   * Record a close. Returns the warning to log, or null. A close with no
   * matching connect (a failed connect attempt) is ignored.
   */
  noteClosed(now: number = Date.now()): string | null {
    if (this.connectedAt === null) return null;
    const uptime = now - this.connectedAt;
    this.connectedAt = null;

    if (uptime > this.quickCloseMs) {
      this.streak = 0;
      return null;
    }

    this.streak++;
    if (this.streak < this.threshold) return null;
    if (this.lastWarnAt !== null && now - this.lastWarnAt < this.rateLimitMs) return null;

    this.lastWarnAt = now;
    const count = this.streak;
    this.streak = 0;
    return (
      `Node closed the TCP link ${count} times within seconds of connecting; ` +
      'another TCP client (phone app over WiFi, Home Assistant, the Python CLI, another MeshMonitor) ' +
      "may be taking the node's single TCP slot."
    );
  }

  /** Forget a pending connect, e.g. on an operator disconnect. */
  reset(): void {
    this.connectedAt = null;
    this.streak = 0;
  }
}
