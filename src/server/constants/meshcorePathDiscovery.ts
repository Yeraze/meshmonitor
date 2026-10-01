/**
 * MeshCore "Discover Path" wait budget (#5508).
 *
 * The companion's Sent ack for CMD_SEND_PATH_DISCOVERY_REQ (52) carries the
 * firmware's `suggested_timeout_ms` (bytes 6-9 of RESP_CODE_SENT, parsed by
 * meshcore.js as `estTimeout`). The UI counts down this budget while it waits
 * for the target's PATH_DISCOVERY_RESPONSE. Same formula as MeshCore One:
 *
 *   suggested <= 0  → 30 s (flood default)
 *   otherwise       → clamp(suggested × 1.2 + 8 s, 5 s, 60 s)
 *   final           → max(20 s, that)            ⇒ 20–60 s in practice
 *
 * Mesh impact: none. The countdown is UI-only; it never resends the request
 * (MeshCore One's retransmit is deliberately left out — it would add airtime).
 */

export const MESHCORE_PATH_DISCOVERY_FLOOD_DEFAULT_MS = 30_000;
export const MESHCORE_PATH_DISCOVERY_MULTIPLIER = 1.2;
export const MESHCORE_PATH_DISCOVERY_GRACE_MS = 8_000;
export const MESHCORE_PATH_DISCOVERY_MIN_MS = 5_000;
export const MESHCORE_PATH_DISCOVERY_MAX_MS = 60_000;
export const MESHCORE_PATH_DISCOVERY_FLOOR_MS = 20_000;

/** UI wait budget (ms) for a firmware `suggested_timeout_ms`. */
export function meshcorePathDiscoveryTimeoutMs(suggestedMs: unknown): number {
  const suggested = typeof suggestedMs === 'number' && Number.isFinite(suggestedMs) ? suggestedMs : 0;
  let candidate: number;
  if (suggested <= 0) {
    candidate = MESHCORE_PATH_DISCOVERY_FLOOD_DEFAULT_MS;
  } else {
    candidate = suggested * MESHCORE_PATH_DISCOVERY_MULTIPLIER + MESHCORE_PATH_DISCOVERY_GRACE_MS;
    candidate = Math.min(MESHCORE_PATH_DISCOVERY_MAX_MS, Math.max(MESHCORE_PATH_DISCOVERY_MIN_MS, candidate));
  }
  return Math.round(Math.max(MESHCORE_PATH_DISCOVERY_FLOOR_MS, candidate));
}
