/**
 * Cross-source link recorder (#5561): the pure evaluators. The DB write and
 * the route are covered by `crossSourceLinks.multiBackend.test.ts` and
 * `crossSourceLinkRoutes.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {}, databaseService: {} }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null), getAllManagers: vi.fn().mockReturnValue([]) },
}));

import { evaluateMeshtasticLink, evaluateMqttLink, hearingsFromTags } from './crossSourceLinkRecorder.js';
import { CrossSourceIndex } from './crossSourceCorrelation.js';

const A = 'src-a';
const B = 'src-b';
const M = 'src-mqtt';
const NUM_A = 0x11223344;
const NUM_B = 0x55667788;
const NOW = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const index = () => new CrossSourceIndex(new Map([[A, NUM_A], [B, NUM_B]]), new Map());

const basePacket = {
  from: NUM_A, id: 4242, relayNode: NUM_A & 0xff, rxSnr: 6.5, rxRssi: -88,
  hopStart: 3, hopLimit: 3, rxTime: NOW_SEC, transportMechanism: 1,
};

describe('hearingsFromTags', () => {
  const idOf = (s: string) => (s === A ? '!11223344' : null);
  it('origin needs a direct hearing', () => {
    const tags = { originSourceId: A, likelyRelaySourceId: null, likelyRelayCandidates: [], transport: 'rf' as const };
    expect(hearingsFromTags(tags, true, idOf)).toEqual([{ txSourceId: A, txNodeId: '!11223344', kind: 'origin' }]);
    expect(hearingsFromTags(tags, false, idOf)).toEqual([]);
  });
  it('broker-delivered MQTT and UDP are never edges', () => {
    for (const transport of ['mqtt', 'udp'] as const) {
      expect(hearingsFromTags({ originSourceId: A, likelyRelaySourceId: null, likelyRelayCandidates: [], transport }, true, idOf)).toEqual([]);
    }
  });
  it('every relay candidate gets an edge when our own radio heard it (rf)', () => {
    const tags = { originSourceId: null, likelyRelaySourceId: A, likelyRelayCandidates: [A], transport: 'rf' as const };
    expect(hearingsFromTags(tags, false, idOf)).toEqual([{ txSourceId: A, txNodeId: '!11223344', kind: 'relay' }]);
  });
  it('a gateway hearing never yields an inferred relay edge, but still yields a proven origin edge', () => {
    const relayOnly = { originSourceId: null, likelyRelaySourceId: A, likelyRelayCandidates: [A], transport: 'mqtt_gateway' as const };
    expect(hearingsFromTags(relayOnly, false, idOf)).toEqual([]);
    const both = { originSourceId: A, likelyRelaySourceId: A, likelyRelayCandidates: [A], transport: 'mqtt_gateway' as const };
    expect(hearingsFromTags(both, true, idOf)).toEqual([{ txSourceId: A, txNodeId: '!11223344', kind: 'origin' }]);
  });
  it('null tags yield nothing', () => {
    expect(hearingsFromTags(null, true, idOf)).toEqual([]);
  });
});

describe('evaluateMeshtasticLink', () => {
  const run = (packet: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    evaluateMeshtasticLink(index(), { sourceId: B, localNodeNum: NUM_B, packet: packet as any, nowMs: NOW, ...extra });

  it('B hears A directly over RF: one origin edge A -> B', () => {
    const r = run(basePacket);
    expect(r.skip).toBeNull();
    expect(r.packetKey).toBe('4242');
    expect(r.hearings).toEqual([{
      txSourceId: A, txNodeId: '!11223344', kind: 'origin',
      rxSourceId: B, rxNodeId: '!55667788', protocol: 'meshtastic', transportClass: 'rf',
      snr: 6.5, rssi: -88, heardAt: NOW,
    }]);
  });

  it('a multi-hop copy of A\'s packet is not an A -> B edge', () => {
    expect(run({ ...basePacket, hopLimit: 1, relayNode: 0x99 }).skip).toBe('not-direct');
  });

  it('a packet A relayed (last hop) is a relay edge', () => {
    const r = run({ ...basePacket, from: 0x0badbeef, hopLimit: 2, relayNode: NUM_A & 0xff });
    expect(r.hearings.map((h) => [h.txSourceId, h.kind])).toEqual([[A, 'relay']]);
  });

  it('MQTT and UDP copies are skipped', () => {
    expect(run({ ...basePacket, transportMechanism: 5 }).skip).toBe('not-rf');
    expect(run({ ...basePacket, viaMqtt: true }).skip).toBe('not-rf');
    expect(run({ ...basePacket, transportMechanism: 6 }).skip).toBe('not-rf');
  });

  it('skips our own packet, a missing local node, a replay, a missing id', () => {
    expect(run({ ...basePacket, from: NUM_B }).skip).toBe('own-packet');
    expect(run(basePacket, { localNodeNum: null }).skip).toBe('no-local-node');
    expect(run(basePacket, { replayed: true }).skip).toBe('replayed');
    expect(run({ ...basePacket, id: 0 }).skip).toBe('no-packet-id');
  });

  it('skips a stale rx_time and a firmware-2.8 NodeDB replay (old rx_time, no RSSI)', () => {
    expect(run({ ...basePacket, rxTime: NOW_SEC - 3600 }).skip).toBe('stale');
    expect(run({ ...basePacket, rxTime: NOW_SEC - 300, rxRssi: 0 }).skip).toBe('nodedb-replay');
  });

  it('a packet from a node that is not one of our sources yields nothing', () => {
    expect(run({ ...basePacket, from: 0x0badbeef, relayNode: 0xef }).skip).toBe('no-correlation');
  });

  it('normalises the -128 "no SNR" sentinel', () => {
    expect(run({ ...basePacket, rxSnr: -128 }).hearings[0].snr).toBeNull();
  });
});

describe('evaluateMqttLink', () => {
  const GATEWAY = 0x0000beef;
  const envelope = (packet: Record<string, unknown>, gatewayId = '!0000beef') => ({
    gatewayId,
    packet: { from: NUM_A, id: 777, rxSnr: 3, rxRssi: -101, hopStart: 3, hopLimit: 3, rxTime: NOW_SEC, decoded: { bitfield: 1 }, ...packet },
  });
  const run = (env: any, own: number[] = [NUM_A, NUM_B]) =>
    evaluateMqttLink(index(), {
      sourceId: M, envelope: env, localGatewayNodeNum: null, nowMs: NOW,
      isOwnNodeNum: (n) => own.includes(n), isIgnored: () => false,
    });

  it('a third-party gateway heard A directly: origin edge A -> gateway, mqtt_gateway', () => {
    const r = run(envelope({}));
    expect(r.skip).toBeNull();
    expect(r.hearings).toEqual([{
      txSourceId: A, txNodeId: '!11223344', kind: 'origin',
      rxSourceId: M, rxNodeId: `!${GATEWAY.toString(16).padStart(8, '0')}`,
      protocol: 'meshtastic', transportClass: 'mqtt_gateway', snr: 3, rssi: -101, heardAt: NOW,
    }]);
  });

  it('a gateway that is one of our own radios is skipped (it records first-hand)', () => {
    expect(run(envelope({}, '!55667788')).skip).toBe('own-node-gateway');
  });

  it('A publishing its own packet is not a hearing', () => {
    expect(run(envelope({}, '!11223344')).skip).toBe('own-packet');
  });

  it('honours ok_to_mqtt = no, drops via-MQTT and stale copies', () => {
    expect(run(envelope({ decoded: { bitfield: 0 } })).skip).toBe('ok-to-mqtt-no');
    expect(run(envelope({ viaMqtt: true })).skip).toBe('via-mqtt');
    expect(run(envelope({ rxTime: NOW_SEC - 3600 })).skip).toBe('stale');
  });

  it('a relayed copy heard by the gateway is not an origin edge', () => {
    expect(run(envelope({ hopLimit: 1, relayNode: 0x99 })).skip).toBe('not-direct');
  });

  it('an unrelated sender yields nothing', () => {
    expect(run(envelope({ from: 0x0badbeef })).skip).toBe('no-correlation');
  });

  it('a gateway copy whose relay byte matches one of our radios yields NO relay edge (hash collision guard)', () => {
    // A third-party packet, last relayed by "something ending in 0x44", heard by a far gateway.
    const r = run(envelope({ from: 0x0badbeef, hopLimit: 2, relayNode: NUM_A & 0xff }));
    expect(r.hearings).toEqual([]);
    expect(r.skip).toBe('no-correlation');
  });
});
