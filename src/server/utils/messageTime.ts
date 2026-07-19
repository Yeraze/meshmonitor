/**
 * Floor below which a device-reported `rxTime` cannot be a real wall-clock
 * receive time (2020-01-01T00:00:00Z, in ms). A node with an unsynced RTC
 * reports seconds-since-boot instead of epoch seconds — a small nonzero value
 * (e.g. 114571) that multiplies out to a date in early January 1970. That
 * passes a plain `rxTime > 0` check, so the floor catches it the same way the
 * exact-zero guard catches an unset gateway time (#4206, building on #3263).
 */
const MIN_PLAUSIBLE_RXTIME_MS = 1_577_836_800_000; // 2020-01-01T00:00:00Z

/**
 * A message's `rxTime` if it is plausible (above the floor), else `null`.
 * Used where the raw device receive time is surfaced per-reception (e.g. the
 * unified view) rather than resolved against `timestamp`.
 */
export function plausibleRxTime(rxTime: number | null | undefined): number | null {
  return typeof rxTime === 'number' && rxTime > MIN_PLAUSIBLE_RXTIME_MS ? rxTime : null;
}

/**
 * Canonical display time for a message row.
 *
 * Prefers the device receive time (`rxTime`) and falls back to the server
 * `timestamp`. The guard against an implausible `rxTime` is load-bearing:
 * MQTT gateway packets and unsynced-RTC nodes frequently report a receive
 * time that is `0` or a small boot-uptime value, and a plain
 * `rxTime ?? timestamp` would pick that value (nullish coalescing only falls
 * through on null/undefined) and render a date in early 1970. Treating
 * anything below the floor as missing makes such rows fall back to the
 * server time.
 *
 * Mirrors the same guard applied at the unified-view canonical computation in
 * `routes/unifiedRoutes.ts` and at MQTT ingestion in `mqttIngestion.ts`.
 */
export function canonicalMessageTime(msg: {
  rxTime?: number | null;
  timestamp: number;
}): number {
  return plausibleRxTime(msg.rxTime) ?? msg.timestamp;
}

/**
 * Server-side ingest time used by clients for sort order (issue #3187), with
 * the same implausible-rxTime guard so a bogus receive time can never leak
 * through the `createdAt ?? rxTime ?? timestamp` fallback chain as an early
 * 1970 date.
 */
export function messageReceivedAt(msg: {
  createdAt?: number | null;
  rxTime?: number | null;
  timestamp: number;
}): number {
  if (typeof msg.createdAt === 'number' && msg.createdAt > 0) return msg.createdAt;
  return canonicalMessageTime(msg);
}
