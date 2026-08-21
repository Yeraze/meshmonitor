/**
 * Hop-count helpers for received Meshtastic packets (#4849).
 *
 * A packet's `rx_rssi` / `rx_snr` describe the RF link of the LAST transmitter
 * we heard — the originating node for a direct reception, but the nearest
 * repeater for a relayed one. Attributing a relayed packet's signal to the
 * source node makes its telemetry chart swing wildly (a distant node briefly
 * shows its neighbour's strong signal). These helpers let callers detect a
 * relayed reception so they can skip recording the misleading value.
 */

/**
 * Hops a received packet travelled, or `null` when it can't be determined.
 *
 * `hop_start` is a proto3 `uint32` scalar (an unset field decodes as `0`), so a
 * `0`/absent `hop_start` is "unknown", NOT "0 hops" — some firmware, MQTT-bridged
 * paths, and transports that strip the LoRa header bits never populate it. We
 * only trust a count when `hop_start > 0` and `hop_start >= hop_limit`, mirroring
 * the existing message-hops guard in the RX path.
 */
export function meshtasticPacketHopsAway(
  hopStart: number | null | undefined,
  hopLimit: number | null | undefined,
): number | null {
  if (hopStart == null || hopLimit == null) return null;
  if (hopStart <= 0) return null;
  if (hopStart < hopLimit) return null; // impossible over the air → treat as unknown
  return hopStart - hopLimit;
}

/**
 * True only when a packet is KNOWN to have been relayed (hops > 0). Used to skip
 * attributing a relayed packet's RSSI/SNR to the source node (#4849). An
 * undetermined hop count returns `false` — we don't over-drop legitimate direct
 * receptions just because a transport didn't populate `hop_start`.
 */
export function isRelayedReception(
  hopStart: number | null | undefined,
  hopLimit: number | null | undefined,
): boolean {
  const hops = meshtasticPacketHopsAway(hopStart, hopLimit);
  return hops != null && hops > 0;
}
