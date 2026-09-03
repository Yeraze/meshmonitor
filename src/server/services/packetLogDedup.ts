/**
 * Recently-seen guard for the Packet Monitor (issues #4811, #5034).
 *
 * The packet_log table has no de-duplication, so a packet the firmware delivers
 * twice (a 2.8-nightly symptom) or that a reconnect/replay re-inserts produces
 * genuinely-identical duplicate rows — pure clutter.
 *
 * The key deliberately includes `relayNode` and `transportMechanism` so that
 * legitimately-distinct receptions of the same packet id — a rebroadcast heard
 * via a different relay, or the same packet arriving over both LoRa and MQTT —
 * keep their own key and are NOT collapsed. Those carry different SNR / hop /
 * transport data and are exactly what a packet monitor is for. Only an exact
 * (sender, id, relay, transport, rx_time) repeat within the TTL window is
 * dropped.
 *
 * ## Why `rxTime` is in the key, and why RF gets a long TTL (#5034)
 *
 * Firmware 2.8's `PhoneAPI` periodically replays each NodeDB entry's cached
 * position/telemetry to the connected client, synthesizing POSITION_APP /
 * TELEMETRY_APP packets from stored data instead of reporting real receptions
 * (firmware PR #10413; see also issue #4192). Firmware PR #11014 *stabilized*
 * the packet id, `rx_snr` and hop fields across those replays, and
 * `transport_mechanism` is deliberately forced to `TRANSPORT_LORA` for iOS
 * client compatibility — so a replay is indistinguishable from a fresh LoRa
 * reception on every field except one: `rx_time` keeps the original
 * first-heard timestamp.
 *
 * These replays arrive roughly hourly, so the 30s window from #4811 could never
 * span them and the Packet Monitor accumulated one duplicate row per hour per
 * node (#5034).
 *
 * Two changes make the guard catch them without collapsing real traffic:
 *
 * 1. **`rxTime` joins the key.** A genuine new reception of the same packet id
 *    carries a new `rx_time`, so it gets its own key and its own row no matter
 *    how long the window is. A replay repeats the cached `rx_time` and collapses.
 *    This also self-heals: when the node is genuinely heard again, `rx_time`
 *    advances, one new row appears, and later replays dedup against that.
 * 2. **RF transports get {@link PACKET_LOG_DEDUP_RF_TTL_MS} instead of 30s.**
 *    The TTL only has to exceed the gap between consecutive replays (~1h), not
 *    how stale they are. On RF an exact (sender, id, relay, rx_time) repeat
 *    arriving hours later cannot be a real second reception: firmware's own
 *    `wasSeenRecently` dedup stops a relay re-flooding an id it already
 *    forwarded, so the only sources of such a repeat are replays and
 *    double-deliveries.
 *
 * **MQTT and multicast UDP keep the short window.** There the same packet id
 * legitimately arrives many times — once per gateway/broker that saw it — and
 * those per-gateway receptions are the point of the MQTT monitor, so a long TTL
 * would destroy real data. Only the RF transports, where the replay lives, get
 * the long window.
 *
 * In-memory and TTL-bounded; the store lives per-source on the manager, so no
 * schema change and no cross-source leakage.
 */

import { TransportMechanism } from '../constants/meshtastic.js';

/**
 * How long a non-RF (MQTT / multicast UDP / API) tuple suppresses a repeat.
 * Deliberately short: per-gateway receptions of one packet id are real data.
 */
export const PACKET_LOG_DEDUP_TTL_MS = 30_000;

/**
 * How long an RF (LoRa) tuple suppresses a repeat. Must exceed the interval
 * between consecutive PhoneAPI replays (observed ~1h in #5034), not their
 * staleness — each replay refreshes the entry, so suppression persists as long
 * as they keep arriving. Six hours leaves generous headroom for a slower replay
 * cadence on other firmware builds.
 */
export const PACKET_LOG_DEDUP_RF_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cap on retained entries, so a busy mesh can't grow the map without bound over
 * the 6h RF window. Well above a realistic 6h distinct-packet count; eviction is
 * oldest-inserted-first, which at worst lets one duplicate row through.
 */
export const PACKET_LOG_DEDUP_MAX_ENTRIES = 20_000;

/**
 * True when `transportMechanism` denotes arrival over a LoRa radio — the
 * transports where a same-(id, relay, rx_time) repeat cannot be a real second
 * reception. `undefined`/`null` counts as RF: pre-2.8 firmware omits the field
 * and the insert path already defaults it to LORA.
 *
 * Everything else gets the short window, deliberately:
 * - `MQTT` / `MULTICAST_UDP` — repeats are real per-gateway/per-peer receptions.
 * - `API` — a client-injected packet, not an RF replay.
 * - `INTERNAL` (0) — locally generated. These never reach the dedup call today:
 *   `isPhantomInternalPacket` and `shouldExcludeFromPacketLog` drop them from the
 *   packet log first. Left on the short window rather than special-cased, since
 *   treating a local packet as RF would be the wrong default if that filter order
 *   ever changes.
 */
export function isRfTransport(transportMechanism: number | null | undefined): boolean {
  if (transportMechanism == null) return true;
  return (
    transportMechanism === TransportMechanism.LORA ||
    transportMechanism === TransportMechanism.LORA_ALT1 ||
    transportMechanism === TransportMechanism.LORA_ALT2 ||
    transportMechanism === TransportMechanism.LORA_ALT3
  );
}

/**
 * Pick the suppression window for a packet's transport: the long RF window where
 * a repeat must be a replay, the short one where repeats are real per-gateway
 * receptions.
 */
export function dedupTtlForTransport(transportMechanism: number | null | undefined): number {
  return isRfTransport(transportMechanism) ? PACKET_LOG_DEDUP_RF_TTL_MS : PACKET_LOG_DEDUP_TTL_MS;
}

/**
 * Build the dedup key. `relayNode`/`transportMechanism` are folded in so distinct
 * relay/transport copies of one packet id survive; `rxTime` is folded in so a
 * genuine re-reception (new device receive time) survives the long RF window
 * while a firmware replay (cached receive time) collapses. Absent values collapse
 * to a stable empty token.
 */
export function packetLogDedupKey(
  fromNum: number,
  packetId: number,
  relayNode: number | null | undefined,
  transportMechanism: number | null | undefined,
  rxTime?: number | null
): string {
  return `${fromNum}:${packetId}:${relayNode ?? ''}:${transportMechanism ?? ''}:${rxTime ?? ''}`;
}

/**
 * Prune expired entries, then test-and-record `key`. Returns true when `key` was
 * already present (unexpired) — i.e. this is a duplicate that should NOT be
 * logged again. Mutates `seen` in place.
 *
 * Pass the per-transport TTL from {@link dedupTtlForTransport}; the default keeps
 * the short window for callers that don't care.
 */
export function isDuplicatePacketLog(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number = PACKET_LOG_DEDUP_TTL_MS,
  maxEntries: number = PACKET_LOG_DEDUP_MAX_ENTRIES
): boolean {
  // Prune expired entries first, so the size cap below only ever evicts live
  // ones. O(size) per packet, and size is bounded by `maxEntries` — a ~20k-entry
  // Map sweep is well under a millisecond, so this stays cheap even with the 6h
  // RF window holding far more keys than the old 30s one did.
  for (const [k, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(k);
  }

  // A hit REFRESHES the expiry rather than just reporting the duplicate. Without
  // this, a replay stream slower than the TTL is only suppressed until the
  // original entry ages out — with a 6h window and an hourly replay that leaks
  // one duplicate row every 6 hours, forever. Refreshing makes suppression
  // persist for as long as the repeats keep arriving, which is the invariant the
  // RF window is sized around.
  if (seen.has(key)) {
    seen.set(key, now + ttlMs);
    return true;
  }

  // Bound memory over the 6h RF window. Map iteration is insertion-ordered, so
  // this drops the longest-standing entries — the ones least likely to still be
  // replaying. At worst an evicted key lets one duplicate row through.
  while (seen.size >= maxEntries) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }

  seen.set(key, now + ttlMs);
  return false;
}
