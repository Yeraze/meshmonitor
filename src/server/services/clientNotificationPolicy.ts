/**
 * Client Notification Policy
 *
 * Pure, testable helpers for handling `FromRadio.ClientNotification` (mesh.proto
 * field 16) messages emitted by the connected Meshtastic node about its OWN
 * operation. MeshMonitor historically decoded and dropped these; we now surface
 * them as toasts.
 *
 * `ClientNotification` is NOT new in firmware 2.8 — 2.7.x already emits several,
 * some of them recurring in normal operation (e.g. duty-cycle limit, power-save
 * "sleeping for Ns interval"). The proto carries no subsystem identifier, only a
 * `level` + free-text `message`, and `PhoneAPI::sendNotification` hardcodes
 * `level = WARNING`, so the suppression policy must key on message text — not on
 * level alone. These helpers keep the noisy ones from spamming the UI while still
 * surfacing the valuable one-shot warnings (duplicate-key, config errors, etc.).
 *
 * Firmware 2.8 additionally emits a protected-node-cap refusal when a favorite /
 * ignore would exceed `MAX_NUM_NODES - 2`; `parseProtectedCapRefusal` extracts
 * the verb + node so the caller can revert MeshMonitor's optimistic local flag.
 */

/** LogRecord.Level numeric values (mesh.proto). */
export const NOTIFICATION_LEVEL = {
  UNSET: 0,
  TRACE: 5,
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;

export interface ParsedClientNotification {
  level: number;
  message: string;
  replyId?: number;
  time?: number;
  /**
   * True when the notification carries a key-verification `payload_variant`
   * (inform / request / final). These are part of an interactive handshake
   * MeshMonitor does not implement, so they are never toasted.
   */
  isKeyVerification?: boolean;
}

/**
 * Messages that fire on a timer / every broadcast cycle in normal operation and
 * would spam the UI. Matched as substrings (case-insensitive).
 *
 * - "Sending position/telemetry and sleeping for Ns interval in a moment" —
 *   emitted every cycle on power-saving TRACKER/SENSOR roles (twice on the
 *   AirQuality path in 2.7.x).
 */
const SUPPRESS_PATTERNS: RegExp[] = [
  /sleeping for .* interval in a moment/i,
];

/**
 * Whether a notification should be dropped entirely (never toasted), independent
 * of throttling. Recurring/structured noise; everything else is allowed through.
 */
export function shouldSuppressToast(n: ParsedClientNotification): boolean {
  if (n.isKeyVerification) return true;
  const msg = (n.message ?? '').trim();
  if (msg.length === 0) return true;
  return SUPPRESS_PATTERNS.some((re) => re.test(msg));
}

/** Maps a notification level to a toast severity. */
export function toastTypeForLevel(level: number): 'error' | 'warning' | 'info' {
  if (level >= NOTIFICATION_LEVEL.ERROR) return 'error';
  if (level >= NOTIFICATION_LEVEL.WARNING) return 'warning';
  return 'info';
}

export interface ProtectedCapRefusal {
  verb: 'favorite' | 'ignore';
  nodeNum: number;
}

/**
 * Firmware 2.8 protected-node-cap refusal:
 *   "Can't <favorite|ignore|verify> 0x%08x: protected-node limit (%d) reached"
 * Only favorite/ignore are MeshMonitor-actionable. Returns null on no match.
 */
const PROTECTED_CAP_RE = /can't (favorite|ignore) 0x([0-9a-f]{8}): protected-node limit/i;

export function parseProtectedCapRefusal(message: string): ProtectedCapRefusal | null {
  const m = PROTECTED_CAP_RE.exec(message ?? '');
  if (!m) return null;
  return {
    verb: m[1].toLowerCase() as 'favorite' | 'ignore',
    nodeNum: parseInt(m[2], 16),
  };
}

/**
 * Per-key dedupe/throttle. Collapses identical messages within a time window so
 * recurring warnings (e.g. per-packet duty-cycle) toast at most once per window.
 * `nowMs` is injected so callers/tests control time deterministically.
 */
export class ToastThrottle {
  private last = new Map<string, number>();

  constructor(private readonly windowMs: number = 60_000) {}

  shouldEmit(key: string, nowMs: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < this.windowMs) {
      return false;
    }
    this.last.set(key, nowMs);
    // Opportunistic cleanup so the map can't grow unbounded over a long uptime.
    if (this.last.size > 200) {
      for (const [k, t] of this.last) {
        if (nowMs - t >= this.windowMs) this.last.delete(k);
      }
    }
    return true;
  }
}
