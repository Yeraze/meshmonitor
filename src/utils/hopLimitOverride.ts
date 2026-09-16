/**
 * Hop-limit override for MeshMonitor-originated automated sends (#5121).
 *
 * Automations, auto-announce and Auto-Acknowledge can pin their outbound text to
 * a hop count, most often 0 so a status message stays in the local RF
 * neighbourhood. Shared by the server send path, the automation schema
 * validator, and the settings UI, so it lives outside `src/server`.
 *
 * Two firmware facts shape it:
 *
 * - **Lower only.** The firmware does not cap a client-supplied `hop_limit` at
 *   the node's own `lora.hop_limit`, so an override above it would spend more
 *   airtime on every automated send. {@link clampHopLimitOverride} caps it at
 *   the device's configured value — an override can shorten reach, never extend
 *   it.
 * - **Zero needs `want_ack` off.** `Router.cpp` replaces `hop_limit == 0` with
 *   the node's default when a packet from the phone API has `want_ack` set
 *   ("the client app has no preference"). A zero-hop send must therefore go out
 *   without an ACK request, so it is sent exactly once with no delivery
 *   confirmation and no queue retry.
 */

/** Protocol max for `hop_limit` (3-bit field). Mirrors MAX_HOP_LIMIT. */
export const HOP_LIMIT_OVERRIDE_MAX = 7;

/**
 * Coerce a stored override to an integer in [0, 7], or `undefined` for
 * "inherit the device's hop limit". Absent, empty, `'inherit'`, and anything
 * out of range or non-integer all mean inherit — a malformed value must never
 * turn into a real override.
 */
export function parseHopLimitOverride(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '' || raw === 'inherit') return undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > HOP_LIMIT_OVERRIDE_MAX) return undefined;
  return n;
}

/**
 * Normalize a stored override setting into the settings UI's string form:
 * `''` for inherit, otherwise `'0'`–`'7'`. Anything unparseable collapses to
 * inherit, the same way {@link parseHopLimitOverride} treats it on the server.
 */
export function hopLimitSettingValue(raw: unknown): string {
  const n = parseHopLimitOverride(raw);
  return n === undefined ? '' : String(n);
}

/**
 * The hop limit to put on the wire for an override, or `undefined` to leave
 * the packet's `hop_limit` unset so the firmware applies the node's own value.
 *
 * @param override - a value from {@link parseHopLimitOverride}
 * @param deviceHopLimit - the node's resolved `lora.hop_limit`
 */
export function clampHopLimitOverride(
  override: number | undefined,
  deviceHopLimit: number,
): number | undefined {
  if (override === undefined) return undefined;
  return Math.max(0, Math.min(override, deviceHopLimit, HOP_LIMIT_OVERRIDE_MAX));
}
