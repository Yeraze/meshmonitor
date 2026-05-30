/**
 * Canonical display time for a message row.
 *
 * Prefers the device receive time (`rxTime`) and falls back to the server
 * `timestamp`. The guard against `rxTime <= 0` is load-bearing: MQTT gateway
 * packets frequently arrive with an unset receive time of `0`, and a plain
 * `rxTime ?? timestamp` would pick that `0` (nullish coalescing only falls
 * through on null/undefined) and render the Unix epoch — "December 31, 1969".
 * Treating `<= 0` as missing makes such rows fall back to the server time.
 *
 * Mirrors the same guard applied at the unified-view canonical computation in
 * `routes/unifiedRoutes.ts` and at MQTT ingestion in `mqttIngestion.ts`.
 */
export function canonicalMessageTime(msg: {
  rxTime?: number | null;
  timestamp: number;
}): number {
  return typeof msg.rxTime === 'number' && msg.rxTime > 0 ? msg.rxTime : msg.timestamp;
}

/**
 * Server-side ingest time used by clients for sort order (issue #3187), with
 * the same `rxTime <= 0` guard so a zero receive time can never leak through
 * the `createdAt ?? rxTime ?? timestamp` fallback chain as a 1969 epoch.
 */
export function messageReceivedAt(msg: {
  createdAt?: number | null;
  rxTime?: number | null;
  timestamp: number;
}): number {
  if (typeof msg.createdAt === 'number' && msg.createdAt > 0) return msg.createdAt;
  return canonicalMessageTime(msg);
}
