/**
 * Live packet traffic (#4835): edge resolution and the per-viewer rate limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildFlightNodeIndex,
  resolveFlightEdge,
  createFlightRateLimiter,
  flightDurationMs,
  flightKindColor,
  type FlightNodeEntry,
} from './packetFlightEdges';
import type { PacketFlight } from '../types/packetFlight';

const LOCAL = 0x11223344;
const SENDER = 0x0a0b0c0d;
const RELAY = 0x55667742; // low byte 0x42
const OTHER_42 = 0x99999942; // also low byte 0x42
const GATEWAY_1 = 0x00000001;
const GATEWAY_2 = 0x00000002;

const P = {
  local: { lat: 30, lng: -90 },
  sender: { lat: 31, lng: -91 },
  relay: { lat: 30.5, lng: -90.5 },
  other: { lat: 29, lng: -89 },
  gw1: { lat: 32, lng: -92 },
  gw2: { lat: 33, lng: -93 },
};

const mt = (overrides: Partial<PacketFlight> = {}): PacketFlight => ({
  sourceId: 's',
  protocol: 'meshtastic',
  receivedAt: 0,
  from: SENDER,
  to: LOCAL,
  relay: null,
  hopsUsed: 0,
  kind: 'TEXT_MESSAGE_APP',
  ...overrides,
});

const nodes: FlightNodeEntry[] = [
  { nodeNum: LOCAL, ...P.local },
  { nodeNum: SENDER, ...P.sender },
  { nodeNum: RELAY, ...P.relay },
  { nodeNum: GATEWAY_1, ...P.gw1 },
  { nodeNum: GATEWAY_2, ...P.gw2 },
];

describe('resolveFlightEdge: Meshtastic', () => {
  const index = buildFlightNodeIndex(nodes);

  it('zero hops: sender to local node, solid', () => {
    expect(resolveFlightEdge(mt(), index)).toEqual({ from: P.sender, to: P.local, viaMesh: false });
  });

  it('a relay byte that matches one drawn node: relay to local, solid', () => {
    expect(resolveFlightEdge(mt({ hopsUsed: 2, relay: 0x42 }), index)).toEqual({ from: P.relay, to: P.local, viaMesh: false });
  });

  it('an ambiguous relay byte: sender to local, dashed', () => {
    const ambiguous = buildFlightNodeIndex([...nodes, { nodeNum: OTHER_42, ...P.other }]);
    expect(resolveFlightEdge(mt({ hopsUsed: 2, relay: 0x42 }), ambiguous)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
  });

  it('a relay byte that matches nothing drawn, or no relay: sender to local, dashed', () => {
    expect(resolveFlightEdge(mt({ hopsUsed: 1, relay: 0x77 }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
    expect(resolveFlightEdge(mt({ hopsUsed: 1, relay: null }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
    expect(resolveFlightEdge(mt({ hopsUsed: null, relay: null }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
  });

  it('the receiver never counts as its own relay', () => {
    const local42 = 0x77777742;
    const idx = buildFlightNodeIndex([{ nodeNum: local42, ...P.local }, { nodeNum: SENDER, ...P.sender }, { nodeNum: RELAY, ...P.relay }]);
    expect(resolveFlightEdge(mt({ to: local42, hopsUsed: 1, relay: 0x42 }), idx)).toEqual({ from: P.relay, to: P.local, viaMesh: false });
  });

  it('over the node\'s MQTT uplink: always dashed', () => {
    expect(resolveFlightEdge(mt({ viaMqtt: true }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
  });

  it('skips a flight when either end has no position on this map', () => {
    expect(resolveFlightEdge(mt({ from: 0xdead }), index)).toBeNull();
    expect(resolveFlightEdge(mt({ to: 0xbeef }), index)).toBeNull();
    // Unknown sender, but a unique relay: still drawn relay -> local.
    expect(resolveFlightEdge(mt({ from: 0xdead, hopsUsed: 1, relay: 0x42 }), index)).toEqual({ from: P.relay, to: P.local, viaMesh: false });
  });
});

describe('resolveFlightEdge: MQTT', () => {
  const index = buildFlightNodeIndex(nodes);
  const mq = (overrides: Partial<PacketFlight>): PacketFlight => mt({ protocol: 'mqtt', ...overrides });

  it('fans out: one line per gateway reception', () => {
    const edges = [mq({ to: GATEWAY_1 }), mq({ to: GATEWAY_2 })].map((f) => resolveFlightEdge(f, index));
    expect(edges).toEqual([
      { from: P.sender, to: P.gw1, viaMesh: false },
      { from: P.sender, to: P.gw2, viaMesh: false },
    ]);
  });

  it('with hops and no relay: sender to gateway, dashed', () => {
    expect(resolveFlightEdge(mq({ to: GATEWAY_1, hopsUsed: 2 }), index)).toEqual({ from: P.sender, to: P.gw1, viaMesh: true });
  });

  it('with hops and a unique relay: relay to gateway, solid', () => {
    expect(resolveFlightEdge(mq({ to: GATEWAY_1, hopsUsed: 2, relay: 0x42 }), index)).toEqual({ from: P.relay, to: P.gw1, viaMesh: false });
  });
});

describe('resolveFlightEdge: MeshCore', () => {
  const LOCAL_KEY = '01'.repeat(32);
  const SENDER_KEY = 'ef' + '22'.repeat(31);
  const HOP_KEY = 'a3' + '33'.repeat(31);
  const HOP_KEY_2 = 'a3' + '44'.repeat(31);
  const mcNodes: FlightNodeEntry[] = [
    { publicKey: LOCAL_KEY, ...P.local },
    { publicKey: SENDER_KEY.toUpperCase(), ...P.sender },
    { publicKey: HOP_KEY, ...P.relay },
  ];
  const index = buildFlightNodeIndex(mcNodes);
  const mc = (overrides: Partial<PacketFlight>): PacketFlight => ({
    sourceId: 'c', protocol: 'meshcore', receivedAt: 0, from: null, to: LOCAL_KEY, relay: null, hopsUsed: null, kind: 'TXT_MSG', ...overrides,
  });

  it('a flood whose last hash is unique: last hop to local, solid', () => {
    expect(resolveFlightEdge(mc({ hopsUsed: 2, relay: 'a3', from: 'ef' }), index)).toEqual({ from: P.relay, to: P.local, viaMesh: false });
  });

  it('an ambiguous last hash: sender to local, dashed; with no sender, skipped', () => {
    const ambiguous = buildFlightNodeIndex([...mcNodes, { publicKey: HOP_KEY_2, ...P.other }]);
    expect(resolveFlightEdge(mc({ hopsUsed: 2, relay: 'a3', from: 'ef' }), ambiguous)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
    expect(resolveFlightEdge(mc({ hopsUsed: 2, relay: 'a3', from: null }), ambiguous)).toBeNull();
  });

  it('zero hops with a known sender (full key or prefix): sender to local, solid', () => {
    expect(resolveFlightEdge(mc({ hopsUsed: 0, from: SENDER_KEY }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: false });
    expect(resolveFlightEdge(mc({ hopsUsed: 0, from: 'ef' }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: false });
  });

  it('a direct packet in transit (hops unknown): sender to local, dashed', () => {
    expect(resolveFlightEdge(mc({ hopsUsed: null, from: 'ef' }), index)).toEqual({ from: P.sender, to: P.local, viaMesh: true });
  });

  it('skips an end with no position on this map', () => {
    expect(resolveFlightEdge(mc({ hopsUsed: 0, from: 'ff' }), index)).toBeNull();
    expect(resolveFlightEdge(mc({ to: '99'.repeat(32), hopsUsed: 0, from: 'ef' }), index)).toBeNull();
  });
});

describe('createFlightRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('0 means all: never drops', () => {
    const limiter = createFlightRateLimiter(0);
    for (let i = 0; i < 1000; i++) expect(limiter.allow()).toBe(true);
    expect(limiter.dropped()).toBe(0);
  });

  it('allows the rate per second, drops and counts the rest, then refills', () => {
    const limiter = createFlightRateLimiter(5);
    const first = Array.from({ length: 8 }, () => limiter.allow());
    expect(first.filter(Boolean)).toHaveLength(5);
    expect(limiter.dropped()).toBe(3);

    vi.advanceTimersByTime(200); // one token back at 5/s
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(Array.from({ length: 6 }, () => limiter.allow()).filter(Boolean)).toHaveLength(5);
    expect(limiter.dropped()).toBe(5);
  });

  it('a new rate applies at once and the count can be cleared', () => {
    const limiter = createFlightRateLimiter(1);
    limiter.allow();
    limiter.allow();
    expect(limiter.dropped()).toBe(1);
    limiter.setRate(0);
    expect(limiter.allow()).toBe(true);
    limiter.resetDropped();
    expect(limiter.dropped()).toBe(0);
  });
});

describe('look', () => {
  it('a typical hop takes about 1.5 s, a long one at most 2.5 s', () => {
    expect(flightDurationMs({ lat: 0, lng: 0 }, { lat: 0.3, lng: 0.4 })).toBe(1500);
    expect(flightDurationMs({ lat: 0, lng: 0 }, { lat: 10, lng: 10 })).toBe(2500);
  });

  it('colours by kind with role tokens only', () => {
    for (const kind of ['TEXT_MESSAGE_APP', 'ADVERT', 'TELEMETRY_APP', 'NODEINFO_APP', 'ACK', null]) {
      expect(flightKindColor(kind)).toMatch(/^var\(--color-[a-z-]+\)$/);
    }
  });
});
