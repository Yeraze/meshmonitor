/**
 * Last-hop (relay node) name resolution for automation templates.
 *
 * Meshtastic stores only the *low byte* of the relaying node's number on each
 * received packet (`MeshPacket.relay_node`). The `{LAST_HOP}` template variable
 * resolves that byte to a human-friendly name, mirroring the Packet Monitor's
 * display behaviour:
 *   - short name when a matching node is known,
 *   - the hex byte (e.g. `0x4F`) when the relay byte is set but no named node
 *     in the mesh matches,
 *   - `unknown` when there is no relay information at all.
 *
 * The Packet Monitor additionally disambiguates byte collisions client-side via
 * RSSI proximity to direct-neighbour stats; that data isn't available server
 * side, so we instead prefer plausible (≤1 hop) and most-recently-heard
 * candidates.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3318
 */

/** A node considered as a possible relay. */
export interface LastHopCandidate {
  nodeNum: number;
  shortName?: string | null;
  role?: number | null;
  hopsAway?: number | null;
  lastHeard?: number | null;
}

/** Meshtastic Config.DeviceConfig.Role.CLIENT_MUTE — never relays. */
const CLIENT_MUTE_ROLE = 4;

function hexByte(byte: number): string {
  return `0x${(byte & 0xff).toString(16).padStart(2, '0').toUpperCase()}`;
}

/**
 * Resolve a relay-node value to its display name.
 *
 * @param relayNode the stored relay value (low byte 0-255, or a full nodeNum
 *   defensively); 0/null/undefined means "no relay info"
 * @param candidates nodes to match against (typically recently-active nodes)
 */
export function resolveLastHopName(
  relayNode: number | null | undefined,
  candidates: LastHopCandidate[]
): string {
  if (relayNode == null || relayNode === 0) return 'unknown';

  const byte = relayNode & 0xff;
  const relayCapable = candidates.filter((n) => n.role !== CLIENT_MUTE_ROLE);

  // Match an exact full nodeNum (defensive) or the stored low byte.
  const matches = relayCapable.filter(
    (n) => n.nodeNum === relayNode || (n.nodeNum & 0xff) === byte
  );

  // Prefer named candidates; among them favour plausible (≤1 hop) relays and the
  // most recently heard, which is the best server-side guess at the real relay.
  const named = matches
    .filter((n) => typeof n.shortName === 'string' && n.shortName.trim().length > 0)
    .sort((a, b) => {
      const aPlausible = a.hopsAway == null || a.hopsAway <= 1 ? 0 : 1;
      const bPlausible = b.hopsAway == null || b.hopsAway <= 1 ? 0 : 1;
      if (aPlausible !== bPlausible) return aPlausible - bPlausible;
      return (b.lastHeard ?? 0) - (a.lastHeard ?? 0);
    });

  if (named.length > 0) return named[0].shortName!.trim();

  // Relay byte is known but no named node matches → hex byte fallback.
  return hexByte(byte);
}
