/**
 * Replay / stale-packet guard for node `lastHeard`.
 *
 * Problem (observed in the field): a node that has been physically powered off
 * for weeks keeps appearing "recently heard" in MeshMonitor. The cause is a
 * replayed packet — typically a retained MQTT telemetry frame, or an MQTT→LoRa
 * bridge re-injecting an offline node's cached reading onto the mesh with a fresh
 * packet id. The payload is byte-frozen (same internal `time` / `uptimeSeconds`)
 * but each copy arrives with a new packet id, so packet-id dedup never catches it.
 *
 * Every packet attributed to a node otherwise stamps `lastHeard = now`, which
 * resurrects the dead node on each replay.
 *
 * The signal we trust here is the packet's own origin timestamp (`rx_time`, unix
 * seconds). For a replay it is frozen well in the past; for a live packet it is
 * ~now. When a packet is a stale replay we omit the `lastHeard` refresh entirely
 * (callers pass `undefined`), and both the async and the sync-SQLite `upsertNode`
 * merges preserve the node's existing `lastHeard` rather than advancing it — so a
 * replay can no longer make an offline node look alive, and it can never drag a
 * genuinely-live node's `lastHeard` backwards either.
 *
 * Deliberately conservative to avoid false positives:
 *  - `rx_time` must be a plausible absolute unix time (>= 2020). Nodes with unset
 *    or boot-relative clocks report a tiny value and fall through to normal
 *    "stamp now" behavior, so they are never frozen by mistake.
 *  - The packet must be more than {@link STALE_REPLAY_THRESHOLD_SEC} old, which
 *    absorbs ordinary clock skew and MQTT/broker delivery jitter.
 *
 * Known limitation: if the *receiving* node's own clock is wrong by more than the
 * threshold, its packets would be misread as stale. In practice the locally
 * connected node is time-synced (MeshMonitor itself pushes time to it), and the
 * 2020 floor catches the common "clock reads ~0" failure mode.
 */

/** Smallest `rx_time` we treat as a real absolute unix timestamp (~2020-09-13). */
export const MIN_PLAUSIBLE_UNIX_SEC = 1_600_000_000;

/**
 * How far in the past a packet's `rx_time` must be before we treat it as a
 * replay. Six hours comfortably catches multi-day/week replays while tolerating
 * clock skew and broker delivery delays on legitimately-recent packets.
 */
export const STALE_REPLAY_THRESHOLD_SEC = 6 * 60 * 60;

/**
 * True when a packet's origin timestamp marks it as a replayed / retained frame
 * that must NOT refresh a node's `lastHeard`.
 *
 * @param rxTimeSec packet `rx_time` in unix seconds (or null/undefined if absent)
 * @param nowSec current wall-clock time in unix seconds
 */
export function isStaleReplayRxTime(
  rxTimeSec: number | null | undefined,
  nowSec: number,
): boolean {
  if (typeof rxTimeSec !== 'number' || !Number.isFinite(rxTimeSec)) return false;
  if (rxTimeSec < MIN_PLAUSIBLE_UNIX_SEC) return false;
  return nowSec - rxTimeSec > STALE_REPLAY_THRESHOLD_SEC;
}

/**
 * Resolve the `lastHeard` value (unix seconds) to stamp on a node for a received
 * packet. Returns the current time for live packets, or `undefined` for a stale
 * replay so the `upsertNode` merge preserves the node's existing `lastHeard`.
 *
 * @param rxTimeSec packet `rx_time` in unix seconds (or null/undefined if absent)
 * @param nowMs current wall-clock time in milliseconds
 */
export function resolveLastHeardSec(
  rxTimeSec: number | null | undefined,
  nowMs: number,
): number | undefined {
  const nowSec = Math.floor(nowMs / 1000);
  return isStaleReplayRxTime(rxTimeSec, nowMs / 1000) ? undefined : nowSec;
}
