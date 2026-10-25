/**
 * Live packet traffic on the map (#4835): turn one `packet:flight` event into
 * the line a dot flies along, using only the nodes that map already draws.
 *
 * The index is built from the map's own drawn node list, which the server has
 * already filtered for the viewer (permissions and private positions). A node
 * the index does not hold is never an end of a line, so a flight can never
 * reveal a node, or a position, the viewer could not already see there.
 *
 * Rules (maintainer decisions on #4835):
 * - Meshtastic TCP and MQTT: zero hops is sender -> receiver, solid. With hops,
 *   a relay byte that matches exactly ONE drawn node (other than the receiver)
 *   is relay -> receiver, solid. Otherwise sender -> receiver, dashed "via mesh".
 *   A Meshtastic packet the node got over its MQTT uplink is always dashed.
 * - MeshCore: a flood with hops draws last-hop hash -> receiver, solid, when the
 *   hash matches exactly one drawn contact. Zero hops draws sender -> receiver,
 *   solid, when the sender resolves to one contact. Otherwise sender ->
 *   receiver, dashed, when the sender resolves; else nothing.
 * - Nothing is drawn when either end has no position on this map.
 */
import type { PacketFlight } from '../types/packetFlight.js';

export interface FlightLatLng {
  lat: number;
  lng: number;
}

/** One node a map draws, with the position its marker sits at. */
export interface FlightNodeEntry {
  /** Meshtastic node number. */
  nodeNum?: number | null;
  /** MeshCore public key (64 hex). */
  publicKey?: string | null;
  lat: number;
  lng: number;
}

export interface FlightNodeIndex {
  byNum: Map<number, FlightLatLng>;
  /** Node numbers by their low byte, for the relay_node match. */
  numsByLowByte: Map<number, number[]>;
  /** Lowercase public key -> position. */
  byKey: Map<string, FlightLatLng>;
  /** Lowercase public keys by their first byte (2 hex chars), for hash and prefix matches. */
  keysByFirstByte: Map<string, string[]>;
}

export interface FlightEdge {
  from: FlightLatLng;
  to: FlightLatLng;
  /** True when the line is the sender -> receiver guess, not a known last hop. */
  viaMesh: boolean;
}

const isFiniteLatLng = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);

/** Build the lookup a map's flights resolve against. */
export function buildFlightNodeIndex(entries: Iterable<FlightNodeEntry>): FlightNodeIndex {
  const index: FlightNodeIndex = {
    byNum: new Map(),
    numsByLowByte: new Map(),
    byKey: new Map(),
    keysByFirstByte: new Map(),
  };
  for (const e of entries) {
    if (!isFiniteLatLng(e.lat, e.lng)) continue;
    const pos = { lat: e.lat, lng: e.lng };
    if (typeof e.nodeNum === 'number' && Number.isFinite(e.nodeNum)) {
      const num = e.nodeNum >>> 0;
      if (!index.byNum.has(num)) {
        index.byNum.set(num, pos);
        const low = num & 0xff;
        const list = index.numsByLowByte.get(low);
        if (list) list.push(num);
        else index.numsByLowByte.set(low, [num]);
      }
    }
    if (typeof e.publicKey === 'string' && /^[0-9a-fA-F]{2,}$/.test(e.publicKey)) {
      const key = e.publicKey.toLowerCase();
      if (!index.byKey.has(key)) {
        index.byKey.set(key, pos);
        const first = key.slice(0, 2);
        const list = index.keysByFirstByte.get(first);
        if (list) list.push(key);
        else index.keysByFirstByte.set(first, [key]);
      }
    }
  }
  return index;
}

/** The one drawn Meshtastic node whose low byte is `relay`, other than `exclude`; null when none or several. */
export function uniqueRelayNode(index: FlightNodeIndex, relay: number, exclude: number | null): number | null {
  const list = (index.numsByLowByte.get(relay & 0xff) ?? []).filter((n) => n !== exclude);
  return list.length === 1 ? list[0] : null;
}

/** The one drawn MeshCore key that starts with `prefix`, other than `exclude`; null when none or several. */
export function uniqueKeyForPrefix(index: FlightNodeIndex, prefix: string, exclude: string | null): string | null {
  const p = prefix.toLowerCase();
  if (!/^[0-9a-f]{2,}$/.test(p)) return null;
  if (p.length >= 64) return index.byKey.has(p) && p !== exclude ? p : null;
  const list = (index.keysByFirstByte.get(p.slice(0, 2)) ?? []).filter((k) => k !== exclude && k.startsWith(p));
  return list.length === 1 ? list[0] : null;
}

function resolveMeshtastic(flight: PacketFlight, index: FlightNodeIndex): FlightEdge | null {
  if (typeof flight.to !== 'number') return null;
  const toNum = flight.to >>> 0;
  const to = index.byNum.get(toNum);
  if (!to) return null;
  const fromNum = typeof flight.from === 'number' ? flight.from >>> 0 : null;
  const from = fromNum !== null ? index.byNum.get(fromNum) ?? null : null;
  if (flight.viaMqtt) return from ? { from, to, viaMesh: true } : null;
  if (flight.hopsUsed === 0) return from ? { from, to, viaMesh: false } : null;
  if (typeof flight.relay === 'number') {
    const relayNum = uniqueRelayNode(index, flight.relay, toNum);
    const relayPos = relayNum !== null ? index.byNum.get(relayNum) : undefined;
    if (relayPos) return { from: relayPos, to, viaMesh: false };
  }
  return from ? { from, to, viaMesh: true } : null;
}

function resolveMeshCore(flight: PacketFlight, index: FlightNodeIndex): FlightEdge | null {
  if (typeof flight.to !== 'string') return null;
  const toKey = flight.to.toLowerCase();
  const to = index.byKey.get(toKey);
  if (!to) return null;
  if (flight.hopsUsed !== null && flight.hopsUsed > 0 && typeof flight.relay === 'string') {
    const relayKey = uniqueKeyForPrefix(index, flight.relay, toKey);
    const relayPos = relayKey ? index.byKey.get(relayKey) : undefined;
    if (relayPos) return { from: relayPos, to, viaMesh: false };
  }
  const senderKey = typeof flight.from === 'string' ? uniqueKeyForPrefix(index, flight.from, toKey) : null;
  const from = senderKey ? index.byKey.get(senderKey) : undefined;
  if (!from) return null;
  return { from, to, viaMesh: flight.hopsUsed !== 0 };
}

/** The line one flight draws on this map, or null to skip it. */
export function resolveFlightEdge(flight: PacketFlight, index: FlightNodeIndex): FlightEdge | null {
  const edge = flight.protocol === 'meshcore' ? resolveMeshCore(flight, index) : resolveMeshtastic(flight, index);
  if (!edge) return null;
  // A line of zero length has nowhere to fly.
  if (edge.from.lat === edge.to.lat && edge.from.lng === edge.to.lng) return null;
  return edge;
}

/** Colour role for a flight's kind, used when the map has no per-source colour. */
export function flightKindColor(kind: string | null | undefined): string {
  switch (kind) {
    case 'TEXT_MESSAGE_APP':
    case 'TXT_MSG':
    case 'GRP_TXT':
      return 'var(--color-accent)';
    case 'POSITION_APP':
    case 'ADVERT':
      return 'var(--color-success)';
    case 'TELEMETRY_APP':
      return 'var(--color-info)';
    case 'NODEINFO_APP':
      return 'var(--color-accent-alt)';
    case 'ROUTING_APP':
    case 'TRACEROUTE_APP':
    case 'NEIGHBORINFO_APP':
    case 'ACK':
    case 'PATH':
    case 'TRACE':
      return 'var(--color-caution)';
    default:
      return 'var(--color-text-muted)';
  }
}

/** Rate steps for the layer's slider; 0 = all. */
export const PACKET_FLIGHT_RATE_STEPS = [1, 2, 5, 10, 25, 50, 0] as const;

/** Most dots animating at once, whatever the rate setting; the oldest finishes first. */
export const MAX_CONCURRENT_FLIGHTS = 200;

/** How long one dot takes to cross its line, ms. Scales gently with distance. */
export function flightDurationMs(from: FlightLatLng, to: FlightLatLng): number {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const deg = Math.sqrt(dLat * dLat + dLng * dLng);
  // ~1.5 s for a typical hop; at most 2.5 s for a very long line.
  return Math.round(Math.min(2500, 1200 + deg * 600));
}

export interface FlightRateLimiter {
  /** True when this flight may be drawn; false (and counted) when the rate is spent. */
  allow(): boolean;
  /** Flights dropped since the limiter was made or last reset. */
  dropped(): number;
  /** Change the rate (0 = all) without losing the dropped count. */
  setRate(maxPerSecond: number): void;
  resetDropped(): void;
}

/**
 * A token bucket: up to `maxPerSecond` flights in any one second, refilled
 * smoothly. 0 = no limit. Reads `Date.now()`, so fake timers drive it.
 */
export function createFlightRateLimiter(maxPerSecond: number): FlightRateLimiter {
  let rate = maxPerSecond > 0 ? maxPerSecond : 0;
  let tokens = rate;
  let last = Date.now();
  let droppedCount = 0;
  return {
    allow() {
      if (rate === 0) return true;
      const now = Date.now();
      tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      droppedCount += 1;
      return false;
    },
    dropped: () => droppedCount,
    setRate(next: number) {
      rate = next > 0 ? next : 0;
      tokens = rate;
      last = Date.now();
    },
    resetDropped() {
      droppedCount = 0;
    },
  };
}
