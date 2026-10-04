/**
 * MeshCore reply-wait policy from the firmware's `suggested_timeout_ms` (#5588).
 *
 * The companion acks an RF command with RESP_CODE_SENT:
 *   [code][is_flood u8][tag u32 LE][suggested_timeout_ms u32 LE]
 * meshcore.js parses bytes 2-5 as `expectedAckCrc` and bytes 6-9 as
 * `estTimeout` (milliseconds). For CMD_SEND_TRACE_PATH the firmware sets it to
 *   500 + (airtime × 6 + 250) × (hops + 1)
 * over every hop in the path we sent (companion_radio/MyMesh.cpp,
 * `calcDirectTimeoutMillisFor`). With an auto-return path the hop list already
 * holds both legs, so the estimate covers the whole trip.
 *
 * Policy, copied from MeshCore One's `flood` profile
 * (MC1/Utilities/FirmwareSuggestedTimeout.swift):
 *
 *   hint <= 0 or absent → 30 s
 *   otherwise           → clamp(hint × 1.2 + 8 s, 5 s, 60 s)
 *
 * With 8 s of grace no positive hint can land under 8 s, so the 5 s minimum
 * never binds today. It stays so the band is right if the grace ever shrinks.
 *
 * Mesh impact: none. These numbers only set how long we listen for a reply.
 * No caller resends when the wait runs out.
 */

export const MESHCORE_FLOOD_WAIT_MULTIPLIER = 1.2;
export const MESHCORE_FLOOD_WAIT_GRACE_MS = 8_000;
export const MESHCORE_FLOOD_WAIT_MIN_MS = 5_000;
export const MESHCORE_FLOOD_WAIT_MAX_MS = 60_000;
export const MESHCORE_FLOOD_WAIT_DEFAULT_MS = 30_000;

/** A usable firmware hint in ms, or 0 when it is missing or garbage. */
export function meshcoreSuggestedTimeoutMs(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Reply wait (ms) for a firmware `suggested_timeout_ms`. */
export function meshcoreFloodWaitMs(suggestedMs: unknown): number {
  const suggested = meshcoreSuggestedTimeoutMs(suggestedMs);
  if (suggested <= 0) return MESHCORE_FLOOD_WAIT_DEFAULT_MS;
  const candidate = suggested * MESHCORE_FLOOD_WAIT_MULTIPLIER + MESHCORE_FLOOD_WAIT_GRACE_MS;
  return Math.round(
    Math.min(MESHCORE_FLOOD_WAIT_MAX_MS, Math.max(MESHCORE_FLOOD_WAIT_MIN_MS, candidate)),
  );
}

/**
 * Reply wait for one trace. A caller's explicit `timeout_ms` wins; otherwise
 * the firmware hint decides.
 */
export function meshcoreTraceWaitMs(suggestedMs: unknown, explicitMs?: unknown): number {
  const explicit = Number(explicitMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return meshcoreFloodWaitMs(suggestedMs);
}

/**
 * Backstop for the radio-op chain. Above the longest policy wait, so a trace's
 * own timer always fires first and removes its listeners.
 */
export const MESHCORE_RADIO_OP_BACKSTOP_MS = MESHCORE_FLOOD_WAIT_MAX_MS + 5_000;

/** Outer timeout for one `trace_path` bridge command. Above the backstop. */
export const MESHCORE_TRACE_BRIDGE_TIMEOUT_MS = MESHCORE_FLOOD_WAIT_MAX_MS + 10_000;

/**
 * HTTP socket timeout for routes that wait on a trace. Above the bridge
 * timeout, so the handler always answers before the socket would close
 * (a closed socket makes the browser resend the POST, see #5494).
 */
export const MESHCORE_TRACE_SOCKET_TIMEOUT_MS = MESHCORE_TRACE_BRIDGE_TIMEOUT_MS + 5_000;

/** Marks a trace that got no reply inside its wait. */
export class MeshCoreTraceTimeoutError extends Error {
  constructor(
    /** How long we waited, in ms. */
    readonly waitMs: number,
    /** Firmware hint from the Sent ack (0 = none seen). */
    readonly suggestedTimeoutMs: number,
  ) {
    super('trace_path timed out');
    this.name = 'MeshCoreTraceTimeoutError';
  }
}
