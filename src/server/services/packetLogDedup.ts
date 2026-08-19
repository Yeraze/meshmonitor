/**
 * Recently-seen guard for the Packet Monitor (issue #4811).
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
 * (sender, id, relay, transport) repeat within the TTL window is dropped.
 *
 * In-memory and TTL-bounded; the store lives per-source on the manager, so no
 * schema change and no cross-source leakage.
 */

/** How long a (from,id,relay,transport) tuple suppresses a repeat. */
export const PACKET_LOG_DEDUP_TTL_MS = 30_000;

/**
 * Build the dedup key. `relayNode`/`transportMechanism` are folded in so distinct
 * relay/transport copies of one packet id survive; absent values collapse to a
 * stable empty token.
 */
export function packetLogDedupKey(
  fromNum: number,
  packetId: number,
  relayNode: number | null | undefined,
  transportMechanism: number | null | undefined
): string {
  return `${fromNum}:${packetId}:${relayNode ?? ''}:${transportMechanism ?? ''}`;
}

/**
 * Prune expired entries, then test-and-record `key`. Returns true when `key` was
 * already present (unexpired) — i.e. this is a duplicate that should NOT be
 * logged again. Mutates `seen` in place.
 */
export function isDuplicatePacketLog(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number = PACKET_LOG_DEDUP_TTL_MS
): boolean {
  // Prune expired entries. The map is bounded by traffic within the TTL window,
  // so this stays cheap.
  for (const [k, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(k);
  }
  if (seen.has(key)) return true;
  seen.set(key, now + ttlMs);
  return false;
}
