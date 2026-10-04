/**
 * MeshCore "Discover Path" wait budget (#5508).
 *
 * The companion's Sent ack for CMD_SEND_PATH_DISCOVERY_REQ (52) carries the
 * firmware's `suggested_timeout_ms` (bytes 6-9 of RESP_CODE_SENT, parsed by
 * meshcore.js as `estTimeout`). The UI counts down this budget while it waits
 * for the target's PATH_DISCOVERY_RESPONSE. Same formula as MeshCore One:
 *
 *   flood wait (shared policy, meshcoreFirmwareTimeout.ts):
 *     suggested <= 0  → 30 s
 *     otherwise       → clamp(suggested × 1.2 + 8 s, 5 s, 60 s)
 *   final             → max(20 s, flood wait)    ⇒ 20–60 s in practice
 *
 * Mesh impact: none. The countdown is UI-only; it never resends the request
 * (MeshCore One's retransmit is deliberately left out — it would add airtime).
 */
import {
  MESHCORE_FLOOD_WAIT_DEFAULT_MS,
  MESHCORE_FLOOD_WAIT_GRACE_MS,
  MESHCORE_FLOOD_WAIT_MAX_MS,
  MESHCORE_FLOOD_WAIT_MIN_MS,
  MESHCORE_FLOOD_WAIT_MULTIPLIER,
  meshcoreFloodWaitMs,
} from './meshcoreFirmwareTimeout.js';

export const MESHCORE_PATH_DISCOVERY_FLOOD_DEFAULT_MS = MESHCORE_FLOOD_WAIT_DEFAULT_MS;
export const MESHCORE_PATH_DISCOVERY_MULTIPLIER = MESHCORE_FLOOD_WAIT_MULTIPLIER;
export const MESHCORE_PATH_DISCOVERY_GRACE_MS = MESHCORE_FLOOD_WAIT_GRACE_MS;
export const MESHCORE_PATH_DISCOVERY_MIN_MS = MESHCORE_FLOOD_WAIT_MIN_MS;
export const MESHCORE_PATH_DISCOVERY_MAX_MS = MESHCORE_FLOOD_WAIT_MAX_MS;
export const MESHCORE_PATH_DISCOVERY_FLOOR_MS = 20_000;

/** UI wait budget (ms) for a firmware `suggested_timeout_ms`. */
export function meshcorePathDiscoveryTimeoutMs(suggestedMs: unknown): number {
  return Math.max(MESHCORE_PATH_DISCOVERY_FLOOR_MS, meshcoreFloodWaitMs(suggestedMs));
}
