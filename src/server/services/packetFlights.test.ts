/**
 * The `packet:flight` builders and the emit guard (#4835).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildMeshtasticFlight,
  buildMqttFlight,
  buildMeshCoreFlight,
  meshcoreSenderOf,
  meshtasticHopsUsed,
  meshtasticRelayByte,
  emitPacketFlight,
} from './packetFlights.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import {
  watchPacketFlights,
  unwatchPacketFlights,
  hasPacketFlightWatchers,
  isWatchingPacketFlights,
  packetFlightWatcherCount,
  resetPacketFlightWatchers,
} from './packetFlightWatchers.js';

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const LOCAL = 'cc'.repeat(32);
// FLOOD | ADVERT, no path; pubkey, timestamp, signature, flags (companion).
const ADVERT_HEX = '11' + '00' + KEY_A + '00000000' + '00'.repeat(64) + '01';
// FLOOD | ANON_REQ, no path; dest hash, sender key, then ciphertext.
const ANON_REQ_HEX = '1d' + '00' + 'cd' + KEY_B + 'deadbeef';
// FLOOD | TXT_MSG, 1 hop (a3); dest cd, src ef.
const TXT_HEX = '0901a3cdefdeadbeef';
// FLOOD | GRP_TXT, 1 hop; channel hash + MAC + ciphertext.
const GRP_HEX = '1501a3' + '11' + '2222' + 'deadbeef';

describe('Meshtastic helpers', () => {
  it('derives hops used from hop_start / hop_limit', () => {
    expect(meshtasticHopsUsed(3, 3)).toBe(0);
    expect(meshtasticHopsUsed(3, 1)).toBe(2);
    expect(meshtasticHopsUsed(0, 0)).toBeNull(); // old firmware: unknown
    expect(meshtasticHopsUsed(undefined, 2)).toBeNull();
    expect(meshtasticHopsUsed(2, 5)).toBeNull();
  });

  it('keeps the relay low byte and treats 0 as unknown', () => {
    expect(meshtasticRelayByte(0x1234)).toBe(0x34);
    expect(meshtasticRelayByte(0)).toBeNull();
    expect(meshtasticRelayByte(undefined)).toBeNull();
  });

  it('builds a TCP flight to the local node, and none for our own node', () => {
    const f = buildMeshtasticFlight({ sourceId: 's', fromNum: 7, localNodeNum: 9, relayNode: 0x41, hopStart: 3, hopLimit: 2, kind: 'TEXT_MESSAGE_APP', snr: 1, rssi: -90, nowMs: 5 });
    expect(f).toEqual({ sourceId: 's', protocol: 'meshtastic', receivedAt: 5, from: 7, to: 9, relay: 0x41, hopsUsed: 1, kind: 'TEXT_MESSAGE_APP', snr: 1, rssi: -90 });
    expect(buildMeshtasticFlight({ sourceId: 's', fromNum: 9, localNodeNum: 9, kind: null })).toBeNull();
    expect(buildMeshtasticFlight({ sourceId: 's', fromNum: 7, localNodeNum: null, kind: null })).toBeNull();
  });

  it('builds an MQTT flight to the gateway, and none without one', () => {
    const f = buildMqttFlight({ sourceId: 'm', fromNum: 7, gatewayNodeNum: 3, hopStart: 2, hopLimit: 2, kind: 'POSITION_APP', nowMs: 1 });
    expect(f).toMatchObject({ protocol: 'mqtt', from: 7, to: 3, hopsUsed: 0, relay: null });
    expect(buildMqttFlight({ sourceId: 'm', fromNum: 7, gatewayNodeNum: null, kind: null })).toBeNull();
    expect(buildMqttFlight({ sourceId: 'm', fromNum: 3, gatewayNodeNum: 3, kind: null })).toBeNull();
  });
});

describe('MeshCore sender and flights', () => {
  it('reads the sender from adverts, ANON_REQ and src-hash messages only', () => {
    expect(meshcoreSenderOf(ADVERT_HEX)).toBe(KEY_A);
    expect(meshcoreSenderOf(ANON_REQ_HEX)).toBe(KEY_B);
    expect(meshcoreSenderOf(TXT_HEX)).toBe('ef');
    expect(meshcoreSenderOf(GRP_HEX)).toBeNull();
    expect(meshcoreSenderOf(null)).toBeNull();
  });

  it('a flood names its last hop; a direct path does not', () => {
    const flood = buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 1, hop_count: 1, path_hops: ['A3'], raw_hex: TXT_HEX, payload_type: 2 } });
    expect(flood).toMatchObject({ protocol: 'meshcore', from: 'ef', to: LOCAL, relay: 'a3', hopsUsed: 1, kind: 'TXT_MSG' });
    const direct = buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 2, hop_count: 2, path_hops: ['11', '22'], raw_hex: TXT_HEX } });
    expect(direct).toMatchObject({ relay: null, hopsUsed: null, from: 'ef' });
  });

  it('a channel message with hops keeps the last hop; with none it is skipped', () => {
    expect(buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 1, hop_count: 1, path_hops: ['a3'], raw_hex: GRP_HEX } }))
      .toMatchObject({ from: null, relay: 'a3' });
    expect(buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 1, hop_count: 0, path_hops: [], raw_hex: '1500112222deadbeef' } }))
      .toBeNull();
  });

  it('drops a sender that matches the receiver (our own packet heard back), keeping the last hop', () => {
    const ownHex = '0901a3cd' + LOCAL.slice(0, 2) + 'deadbeef';
    expect(buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 1, hop_count: 1, path_hops: ['a3'], raw_hex: ownHex } }))
      .toMatchObject({ from: null, relay: 'a3' });
    expect(buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 1, hop_count: 0, path_hops: [], raw_hex: '0900cd' + LOCAL.slice(0, 2) + 'beef' } }))
      .toBeNull();
  });

    it('needs a receiver', () => {
    expect(buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: null, event: { raw_hex: ADVERT_HEX } })).toBeNull();
  });

  it('carries no frame bytes or text', () => {
    const f = buildMeshCoreFlight({ sourceId: 'c', receiverPubKey: LOCAL, event: { route_type: 1, hop_count: 1, path_hops: ['a3'], raw_hex: TXT_HEX } });
    expect(Object.keys(f!).sort()).toEqual(['from', 'hopsUsed', 'kind', 'protocol', 'receivedAt', 'relay', 'rssi', 'snr', 'sourceId', 'to']);
    expect(JSON.stringify(f)).not.toContain('deadbeef');
  });
});

describe('watchers and the emit guard', () => {
  let events: DataEvent[];
  const listener = (e: DataEvent) => events.push(e);
  beforeEach(() => {
    events = [];
    resetPacketFlightWatchers();
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => {
    dataEventEmitter.off('data', listener);
    resetPacketFlightWatchers();
  });

  it('counts watchers per source and forgets a socket everywhere', () => {
    watchPacketFlights('s1', 'A');
    watchPacketFlights('s2', 'A');
    watchPacketFlights('s1', 'B');
    expect(packetFlightWatcherCount('A')).toBe(2);
    expect(isWatchingPacketFlights('s1', 'B')).toBe(true);
    unwatchPacketFlights('s1', ['A']);
    expect(packetFlightWatcherCount('A')).toBe(1);
    unwatchPacketFlights('s1');
    expect(hasPacketFlightWatchers('B')).toBe(false);
    unwatchPacketFlights('s2');
    expect(hasPacketFlightWatchers('A')).toBe(false);
  });

  it('does not even build a flight while nobody watches', () => {
    let built = 0;
    emitPacketFlight('A', () => {
      built++;
      return null;
    });
    expect(built).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('emits a source-scoped event while watched, and never throws into ingest', () => {
    watchPacketFlights('s1', 'A');
    emitPacketFlight('A', () => buildMqttFlight({ sourceId: 'A', fromNum: 1, gatewayNodeNum: 2, kind: null }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'packet:flight', sourceId: 'A' });
    expect(() => emitPacketFlight('A', () => {
      throw new Error('boom');
    })).not.toThrow();
  });
});
