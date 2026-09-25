/**
 * Plausibility bounds for a MeshCore device-reported epoch timestamp (ms).
 *
 * Every MeshCore node carries its own real-time clock, and unlike Meshtastic
 * there is no equivalent of a mesh-wide `set_time` admin push keeping them in
 * sync — a companion or repeater that has never had its clock set (or whose
 * clock has since drifted) stamps adverts and messages with whatever bogus
 * value its RTC currently holds. Issue #5339 observed a single mesh's "last
 * heard" values spread from year 2000 to year 2087 purely from this.
 *
 * MeshMonitor already receives every one of these events in real time, so
 * its own receipt clock (`Date.now()`) is always available as a fallback.
 * This module is the single gate between "trust the device's stated time"
 * and "the device's clock cannot be trusted right now" — callers pass a raw
 * device timestamp through {@link plausibleMeshCoreTimeMs} and get back
 * either that same value (device clock looks sane) or their own supplied
 * fallback (it doesn't).
 *
 * Mirrors the precedent set for the Meshtastic ingestion paths
 * (`server/utils/messageTime.ts`'s `plausibleRxTime`, #4206), which guards
 * only a floor (unsynced nodes reporting seconds-since-boot land near Unix
 * epoch). MeshCore's drift runs in both directions, so this adds a ceiling
 * too.
 */

/** 2020-01-01T00:00:00Z, in ms — MeshCore didn't exist before this. */
const MIN_PLAUSIBLE_MESHCORE_TIME_MS = 1_577_836_800_000;

/**
 * How far ahead of MeshMonitor's own clock a device-reported time may sit
 * before it's treated as drift rather than ordinary clock skew. Generous on
 * purpose — this only needs to reject multi-year drift, not nudge out
 * legitimately-unsynced-but-close clocks.
 */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 1 day

/**
 * Whether an already-converted epoch-ms value could plausibly be a real
 * receive time, relative to `nowMs`.
 */
export function isPlausibleMeshCoreTimeMs(ms: number, nowMs: number = Date.now()): boolean {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_MESHCORE_TIME_MS && ms <= nowMs + MAX_FUTURE_SKEW_MS;
}

/**
 * Resolve a MeshCore device-reported epoch-SECONDS timestamp (e.g. the wire
 * `sender_timestamp`) to epoch ms, falling back to `nowMs` (MeshMonitor's own
 * receipt clock; injectable for tests) when the value is missing,
 * non-positive, or implausible per {@link isPlausibleMeshCoreTimeMs}. `nowMs`
 * doubles as both the fallback value and the reference point for the
 * plausibility ceiling, matching the `sender_timestamp ? ... : Date.now()`
 * shape this replaces at each call site.
 */
export function plausibleMeshCoreTimeMs(
  senderTimestampSec: number | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (typeof senderTimestampSec !== 'number' || senderTimestampSec <= 0) return nowMs;
  const ms = senderTimestampSec * 1000;
  return isPlausibleMeshCoreTimeMs(ms, nowMs) ? ms : nowMs;
}
