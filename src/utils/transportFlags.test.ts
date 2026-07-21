/**
 * #4240 — transport flags accumulate; map visibility ORs them.
 *
 * The original model stamped a single last-wins `transportMechanism`. That
 * cannot express "reachable over RF *and* MQTT", which is the normal case: a
 * local node with an MQTT uplink receives echoes of the same RF traffic
 * flagged `viaMqtt`, so the column thrashes and MQTT wins whenever an echo
 * lands last. The node then disappears, because "Show MQTT" defaults to off.
 */
import { describe, it, expect } from 'vitest';
import {
  TF_RF, TF_MQTT, TF_UDP,
  transportBitFor,
  transportClassesFromFlags,
  getNodeTransportClasses,
  nodePassesTransportFilter,
  TX_INTERNAL, TX_LORA, TX_LORA_ALT2, TX_MQTT, TX_MULTICAST_UDP, TX_API,
} from './nodeTransport';

const RF_ONLY = { showRfNodes: true, showUdpNodes: false, showMqttNodes: false };
const MQTT_ONLY = { showRfNodes: false, showUdpNodes: false, showMqttNodes: true };
const NONE = { showRfNodes: false, showUdpNodes: false, showMqttNodes: false };

describe('transportBitFor (#4240)', () => {
  it('maps each mechanism onto its bit', () => {
    expect(transportBitFor(TX_MQTT)).toBe(TF_MQTT);
    expect(transportBitFor(TX_MULTICAST_UDP)).toBe(TF_UDP);
    expect(transportBitFor(TX_LORA)).toBe(TF_RF);
    expect(transportBitFor(TX_LORA_ALT2)).toBe(TF_RF);
  });

  it('honors legacy viaMqtt only when the mechanism is uninformative', () => {
    expect(transportBitFor(TX_INTERNAL, true)).toBe(TF_MQTT);
    expect(transportBitFor(TX_API, true)).toBe(TF_MQTT);
    expect(transportBitFor(null, true)).toBe(TF_MQTT);
    expect(transportBitFor(undefined, false)).toBe(TF_RF);
    // An explicit LoRa mechanism outranks the boolean.
    expect(transportBitFor(TX_LORA, true)).toBe(TF_RF);
  });
});

describe('transportClassesFromFlags (#4240)', () => {
  it('expands a combined mask into every class', () => {
    expect(transportClassesFromFlags(TF_RF | TF_MQTT).sort()).toEqual(['mqtt', 'rf']);
    expect(transportClassesFromFlags(TF_RF | TF_MQTT | TF_UDP).sort())
      .toEqual(['mqtt', 'rf', 'udp']);
  });

  it('returns an empty list for an empty mask', () => {
    expect(transportClassesFromFlags(0)).toEqual([]);
  });
});

describe('getNodeTransportClasses precedence (#4240)', () => {
  it('prefers persisted flags over the last-wins mechanism', () => {
    // THE REGRESSION: mechanism says MQTT (an echo landed last), but the node
    // has been heard over RF. It must still count as RF.
    const node = { transportMechanism: TX_MQTT, transportFlags: TF_RF | TF_MQTT };
    expect(getNodeTransportClasses(node).sort()).toEqual(['mqtt', 'rf']);
  });

  it('falls back to single classification for pre-migration rows', () => {
    expect(getNodeTransportClasses({ transportMechanism: TX_MQTT })).toEqual(['mqtt']);
    expect(getNodeTransportClasses({ transportMechanism: TX_LORA })).toEqual(['rf']);
  });

  it('treats a zero/absent mask as not-yet-written and falls back', () => {
    expect(getNodeTransportClasses({ transportMechanism: TX_LORA, transportFlags: 0 }))
      .toEqual(['rf']);
    expect(getNodeTransportClasses({ transportMechanism: TX_LORA, transportFlags: null }))
      .toEqual(['rf']);
  });

  it('still lets the cross-source union win when present', () => {
    const node = {
      transportMechanism: TX_MQTT,
      transportFlags: TF_MQTT,
      transportClasses: ['rf' as const, 'mqtt' as const],
    };
    expect(getNodeTransportClasses(node).sort()).toEqual(['mqtt', 'rf']);
  });
});

describe('nodePassesTransportFilter with accumulated flags (#4240)', () => {
  it('keeps an RF+MQTT node visible with only Show RF on', () => {
    // This is the exact reported symptom: node vanished from the map because
    // an MQTT echo overwrote its RF classification.
    const node = { transportMechanism: TX_MQTT, transportFlags: TF_RF | TF_MQTT };
    expect(nodePassesTransportFilter(node, RF_ONLY)).toBe(true);
  });

  it('keeps that same node visible with only Show MQTT on', () => {
    const node = { transportMechanism: TX_MQTT, transportFlags: TF_RF | TF_MQTT };
    expect(nodePassesTransportFilter(node, MQTT_ONLY)).toBe(true);
  });

  it('still hides an MQTT-ONLY node when Show MQTT is off (#3112 intact)', () => {
    // The guardrail: accumulating flags must not make MQTT-only nodes appear.
    const node = { transportMechanism: TX_MQTT, transportFlags: TF_MQTT };
    expect(nodePassesTransportFilter(node, RF_ONLY)).toBe(false);
    expect(nodePassesTransportFilter(node, MQTT_ONLY)).toBe(true);
  });

  it('hides everything when every toggle is off', () => {
    const node = { transportFlags: TF_RF | TF_MQTT | TF_UDP };
    expect(nodePassesTransportFilter(node, NONE)).toBe(false);
  });

  it('does not let a UDP bit leak a node into an RF-only view', () => {
    const node = { transportFlags: TF_UDP };
    expect(nodePassesTransportFilter(node, RF_ONLY)).toBe(false);
  });
});

describe('accumulation semantics (#4240)', () => {
  it('ORing successive observations never loses an earlier transport', () => {
    // Mirrors upsertNode: stored = existing | incoming.
    let stored = 0;
    stored |= transportBitFor(TX_LORA);          // heard over RF
    expect(transportClassesFromFlags(stored)).toEqual(['rf']);

    stored |= transportBitFor(TX_MQTT);          // MQTT echo of the same traffic
    expect(transportClassesFromFlags(stored).sort()).toEqual(['mqtt', 'rf']);

    // ...and a hundred more echoes change nothing.
    for (let i = 0; i < 100; i++) stored |= transportBitFor(TX_MQTT);
    expect(transportClassesFromFlags(stored).sort()).toEqual(['mqtt', 'rf']);
    expect(nodePassesTransportFilter({ transportFlags: stored }, RF_ONLY)).toBe(true);
  });

  it('is order-independent', () => {
    const rfFirst = transportBitFor(TX_LORA) | transportBitFor(TX_MQTT);
    const mqttFirst = transportBitFor(TX_MQTT) | transportBitFor(TX_LORA);
    expect(rfFirst).toBe(mqttFirst);
  });
});
