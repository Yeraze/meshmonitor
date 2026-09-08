/**
 * Tests for traceroute hop transport classification (#5097).
 *
 * The rules under test are the ones that decide whether a route segment
 * disappears when a user turns off Show MQTT or Show UDP. Two of them are
 * counter-intuitive enough to be worth pinning:
 *
 *   1. Within a hop, the per-hop MQTT sentinel BEATS the record's transport.
 *      Additive here would keep exactly the segments the toggle exists to
 *      remove.
 *   2. Across records, the union IS additive. A link one traceroute saw over
 *      RF is an RF link, whatever a second traceroute travelled over.
 *
 * They look contradictory and are not — see the module doc.
 */
import { describe, it, expect } from 'vitest';
import {
  hopTransportClass,
  segmentPassesTransportFilter,
  tracerouteTransportClass,
  transportFilterIsInert,
  type NodeTransportClass,
} from './tracerouteTransport';
import { TX_LORA, TX_LORA_ALT2, TX_MQTT, TX_MULTICAST_UDP, TX_API, TX_INTERNAL } from './nodeTransport';

const ALL_ON = { showRfNodes: true, showUdpNodes: true, showMqttNodes: true };
const RF_ONLY = { showRfNodes: true, showUdpNodes: false, showMqttNodes: false };
const NONE = { showRfNodes: false, showUdpNodes: false, showMqttNodes: false };

describe('tracerouteTransportClass', () => {
  it('maps the mechanism enum onto the three filter classes', () => {
    expect(tracerouteTransportClass({ transportMechanism: TX_LORA })).toBe('rf');
    expect(tracerouteTransportClass({ transportMechanism: TX_LORA_ALT2 })).toBe('rf');
    expect(tracerouteTransportClass({ transportMechanism: TX_MQTT })).toBe('mqtt');
    expect(tracerouteTransportClass({ transportMechanism: TX_MULTICAST_UDP })).toBe('udp');
  });

  it('treats a pre-migration row as RF, not as hidden', () => {
    // The load-bearing case on upgrade: migration 160 backfills NULL because
    // the transport was never recorded and cannot be recovered. If NULL meant
    // "no class", every historical traceroute would vanish from the map the
    // moment the user upgraded — a far worse outcome than showing them.
    expect(tracerouteTransportClass({ transportMechanism: null })).toBe('rf');
    expect(tracerouteTransportClass({})).toBe('rf');
    expect(tracerouteTransportClass(null)).toBe('rf');
    expect(tracerouteTransportClass(undefined)).toBe('rf');
  });

  it('honours the legacy viaMqtt flag when the enum is absent or ambiguous', () => {
    // INTERNAL (0) and an unset scalar are indistinguishable on the wire, so
    // the boolean is the only signal left for a bridge row written before the
    // mechanism existed.
    expect(tracerouteTransportClass({ viaMqtt: true })).toBe('mqtt');
    expect(tracerouteTransportClass({ transportMechanism: TX_INTERNAL, viaMqtt: true })).toBe('mqtt');
    expect(tracerouteTransportClass({ transportMechanism: TX_API, viaMqtt: true })).toBe('mqtt');
    // An explicit mechanism still wins over a stale boolean.
    expect(tracerouteTransportClass({ transportMechanism: TX_LORA, viaMqtt: true })).toBe('rf');
  });
});

describe('hopTransportClass', () => {
  it('lets the per-hop MQTT sentinel override the record transport', () => {
    // NullVoid's ask in one assertion: a hop that relied on MQTT is an MQTT
    // hop, even though the traceroute reporting it arrived over RF.
    expect(hopTransportClass('rf', true)).toBe('mqtt');
    expect(hopTransportClass('udp', true)).toBe('mqtt');
  });

  it('inherits the record transport when the sentinel did not fire', () => {
    expect(hopTransportClass('rf', false)).toBe('rf');
    expect(hopTransportClass('udp', false)).toBe('udp');
    expect(hopTransportClass('mqtt', false)).toBe('mqtt');
  });
});

describe('segmentPassesTransportFilter', () => {
  it('shows a segment when any observed transport is enabled', () => {
    expect(segmentPassesTransportFilter(['rf'], RF_ONLY)).toBe(true);
    expect(segmentPassesTransportFilter(['mqtt'], RF_ONLY)).toBe(false);
    expect(segmentPassesTransportFilter(['udp'], RF_ONLY)).toBe(false);
  });

  it('keeps a link that any one traceroute observed over an enabled transport', () => {
    // The additive-across-records half. Turning MQTT off must not erase a link
    // an RF traceroute independently confirmed.
    expect(segmentPassesTransportFilter(['rf', 'mqtt'], RF_ONLY)).toBe(true);
    expect(segmentPassesTransportFilter(['udp', 'mqtt'], RF_ONLY)).toBe(false);
  });

  it('hides everything when every toggle is off', () => {
    for (const c of ['rf', 'udp', 'mqtt'] as NodeTransportClass[]) {
      expect(segmentPassesTransportFilter([c], NONE)).toBe(false);
    }
  });

  it('shows a segment with no transport evidence at all', () => {
    // Not the same as "hide": a segment we know nothing about is not one the
    // user asked to hide, and returning false would make it unreachable under
    // every combination of toggles.
    expect(segmentPassesTransportFilter([], NONE)).toBe(true);
    expect(segmentPassesTransportFilter([], RF_ONLY)).toBe(true);
  });

  it('accepts a Set, which is how the aggregated layer accumulates classes', () => {
    expect(segmentPassesTransportFilter(new Set<NodeTransportClass>(['mqtt']), RF_ONLY)).toBe(false);
    expect(segmentPassesTransportFilter(new Set<NodeTransportClass>(['mqtt', 'rf']), RF_ONLY)).toBe(true);
  });
});

describe('transportFilterIsInert', () => {
  it('is inert only when all three toggles are on', () => {
    // Callers use this to skip per-segment bookkeeping on maps with hundreds of
    // segments, so a false negative here is a real render cost.
    expect(transportFilterIsInert(ALL_ON)).toBe(true);
    expect(transportFilterIsInert(RF_ONLY)).toBe(false);
    expect(transportFilterIsInert({ ...ALL_ON, showMqttNodes: false })).toBe(false);
    expect(transportFilterIsInert({ ...ALL_ON, showUdpNodes: false })).toBe(false);
    expect(transportFilterIsInert({ ...ALL_ON, showRfNodes: false })).toBe(false);
  });
});
