/**
 * Draft text for the Security tab's "Send notification" button (#6281 S7).
 *
 * One builder for both protocols. The user reads the draft and presses Send;
 * nothing sends it for them. The text goes over the air, so it stays English
 * (like the Meshtastic text always did).
 *
 * The two Meshtastic key texts are unchanged. The new texts are at most
 * {@link NOTIFICATION_MAX_BYTES} UTF-8 bytes, which keeps a MeshCore DM at about
 * 1.4 s (US) / 3.7 s (EU) of airtime at 3 hops instead of 2.2 s / 5.8 s. A test
 * enforces the cap.
 */
import { formatCompactSpan, isClockNotSet } from './securityClock.js';

export const NOTIFICATION_MAX_BYTES = 75;

export type SecurityNotificationKind = 'lowEntropy' | 'duplicateKey' | 'excessivePackets' | 'timeOffset';

export interface SecurityNotificationParams {
  /** duplicateKey: how many other nodes share the key. */
  duplicateCount?: number;
  /** excessivePackets: packets seen in the last hour. */
  packetsPerHour?: number | null;
  /** timeOffset: receipt minus node time, seconds (positive = node behind). */
  offsetSeconds?: number | null;
}

export function securityNotificationText(
  kind: SecurityNotificationKind,
  params: SecurityNotificationParams = {},
): string {
  switch (kind) {
    case 'lowEntropy':
      return 'MeshMonitor Security Notification: Your node has a low entropy key. Read more: https://bit.ly/4oL5m0P';
    case 'duplicateKey':
      return `MeshMonitor Security Notification: Your node has a key shared with ${params.duplicateCount ?? 0} other nearby nodes. Read more: https://bit.ly/4okVACV`;
    case 'excessivePackets': {
      const n = params.packetsPerHour;
      return typeof n === 'number' && n > 0
        ? `MeshMonitor: your node sends ${n} packets/hr. Please check it.`
        : 'MeshMonitor: your node sends too many packets. Please check it.';
    }
    case 'timeOffset': {
      const s = params.offsetSeconds;
      if (typeof s !== 'number' || isClockNotSet(s)) {
        return 'MeshMonitor: your node\'s clock is not set. Please set its time.';
      }
      return `MeshMonitor: your node's clock is ${formatCompactSpan(s)} ${s >= 0 ? 'behind' : 'ahead'}. Please set its time.`;
    }
  }
}
