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

/**
 * How far `rx_time` may lag "now" before a packet counting toward a LIVE-
 * reception metric — currently only the #5101 P3 transport-traffic packet
 * counter (`transportTrafficService.recordRx`) — is treated as too old to be
 * a live reception, rather than a replay.
 *
 * This is deliberately a much tighter window than {@link STALE_REPLAY_THRESHOLD_SEC}
 * (6h). That threshold answers "should this refresh `lastHeard`?", where being
 * lenient is correct — worst case a node's `lastHeard` advances a bit early.
 * `isLiveReception` answers a stricter question for a COUNTER: "did we just
 * receive a NEW packet?" Firmware 2.8's PhoneAPI NodeDB replay (#5034) reuses
 * the packet's ORIGINAL `rx_time` on every replay (hourly, and on every client
 * reconnect — see `packetLogDedup.ts`), so a naive 6h gate counts every one of
 * those replays as a fresh reception, inflating `systemPacketsRx*` by dozens
 * per reconnect (observed: 67 -> 134 packets across two restarts).
 *
 * 120s comfortably covers ordinary delivery jitter (MQTT/broker latency,
 * local processing, the receiving node's own small clock skew — MeshMonitor
 * time-syncs the local node, so this is not the multi-hour drift
 * {@link STALE_REPLAY_THRESHOLD_SEC} guards against) while staying two orders
 * of magnitude below the replay's ~hourly cadence, so a genuine replay of a
 * packet heard even a few minutes ago is excluded rather than double-counted
 * (the original live reception already incremented the counter).
 */
export const LIVE_RECEPTION_WINDOW_SEC = 120;

/**
 * True when a packet's `rx_time` marks it as a genuinely live reception, for
 * counters that must exclude replayed/retained frames entirely — as opposed
 * to {@link isStaleReplayRxTime}, which decides whether to *refresh* a node's
 * `lastHeard` stamp (a different, more lenient policy; see #4192 and the file
 * header above). Do not use this to gate `lastHeard` or `transportLast*`
 * stamping — that must keep using {@link resolveLastHeardSec}.
 *
 * A packet counts as live when:
 *  - `rx_time` is absent or implausible (< {@link MIN_PLAUSIBLE_UNIX_SEC}) —
 *    the node has no working clock, so it cannot be a firmware-2.8 replay
 *    (those always carry the node's real original timestamp); treated as live
 *    so nodes with unset clocks are not silently excluded from the counter.
 *  - `rx_time` is within {@link LIVE_RECEPTION_WINDOW_SEC} seconds of now,
 *    including a small future skew (the receiving node's clock running a
 *    little ahead of the server's is normal, not a signal of a replay).
 *
 * @param rxTimeSec packet `rx_time` in unix seconds (or null/undefined if absent)
 * @param nowMs current wall-clock time in milliseconds
 */
export function isLiveReception(
  rxTimeSec: number | null | undefined,
  nowMs: number,
): boolean {
  if (typeof rxTimeSec !== 'number' || !Number.isFinite(rxTimeSec)) return true;
  if (rxTimeSec < MIN_PLAUSIBLE_UNIX_SEC) return true;
  const nowSec = nowMs / 1000;
  return nowSec - rxTimeSec <= LIVE_RECEPTION_WINDOW_SEC;
}
