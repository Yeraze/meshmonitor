/**
 * #4240 — per-transport last-seen timestamps: OR across transports, with decay
 * against the user's active window.
 *
 * The original model stamped a single last-wins `transportMechanism`. That
 * cannot express "reachable over RF *and* MQTT", which is the normal case: a
 * local node with an MQTT uplink receives echoes of its own RF traffic flagged
 * `viaMqtt`, so the column thrashes and MQTT wins whenever an echo lands last.
 * The node then disappears, because "Show MQTT" defaults to off.
 *
 * Sticky booleans would fix the OR but never decay — a node heard over RF once
 * would count as RF forever. Timestamps give both properties.
 */
import { describe, it, expect } from 'vitest';
import {
  TRANSPORT_LAST_COLUMN,
  transportColumnForPacket,
  transportCutoffSec,
  getNodeTransportClasses,
  nodePassesTransportFilter,
  TX_INTERNAL, TX_LORA, TX_MQTT, TX_MULTICAST_UDP, TX_API,
} from './nodeTransport';

const NOW = 1_800_000_000;      // arbitrary fixed "now", unix seconds
const HOUR = 3600;
const CUTOFF = NOW - 24 * HOUR; // 24h active window

const FRESH = NOW - HOUR;       // inside the window
const STALE = NOW - 72 * HOUR;  // well outside it

const RF_ONLY = { showRfNodes: true, showUdpNodes: false, showMqttNodes: false };
const MQTT_ONLY = { showRfNodes: false, showUdpNodes: false, showMqttNodes: true };
const NONE = { showRfNodes: false, showUdpNodes: false, showMqttNodes: false };

describe('transportCutoffSec (#4240)', () => {
  it('converts an active window in hours to a unix-seconds cutoff', () => {
    expect(transportCutoffSec(24, NOW * 1000)).toBe(NOW - 24 * HOUR);
    expect(transportCutoffSec(1, NOW * 1000)).toBe(NOW - HOUR);
  });
});

describe('transportColumnForPacket (#4240)', () => {
  it('routes each mechanism to its own column', () => {
    expect(transportColumnForPacket(TX_LORA)).toBe(TRANSPORT_LAST_COLUMN.rf);
    expect(transportColumnForPacket(TX_MQTT)).toBe(TRANSPORT_LAST_COLUMN.mqtt);
    expect(transportColumnForPacket(TX_MULTICAST_UDP)).toBe(TRANSPORT_LAST_COLUMN.udp);
  });

  it('honors legacy viaMqtt only for uninformative mechanisms', () => {
    expect(transportColumnForPacket(TX_INTERNAL, true)).toBe(TRANSPORT_LAST_COLUMN.mqtt);
    expect(transportColumnForPacket(TX_API, true)).toBe(TRANSPORT_LAST_COLUMN.mqtt);
    expect(transportColumnForPacket(null, false)).toBe(TRANSPORT_LAST_COLUMN.rf);
    // An explicit LoRa mechanism outranks the boolean.
    expect(transportColumnForPacket(TX_LORA, true)).toBe(TRANSPORT_LAST_COLUMN.rf);
  });
});

describe('getNodeTransportClasses with decay (#4240)', () => {
  it('returns every transport still inside the window', () => {
    const node = { transportLastRf: FRESH, transportLastMqtt: FRESH };
    expect(getNodeTransportClasses(node, CUTOFF).sort()).toEqual(['mqtt', 'rf']);
  });

  it('drops a transport that has aged out while another stays fresh', () => {
    // THE DECAY CASE: node used to be on MQTT, now only heard over RF.
    const node = { transportLastRf: FRESH, transportLastMqtt: STALE };
    expect(getNodeTransportClasses(node, CUTOFF)).toEqual(['rf']);
  });

  it('unions everything when no window is supplied', () => {
    const node = { transportLastRf: STALE, transportLastMqtt: FRESH };
    expect(getNodeTransportClasses(node).sort()).toEqual(['mqtt', 'rf']);
  });

  it('keeps the boundary timestamp inside the window', () => {
    // Cutoff itself counts as fresh (>=), so a node heard exactly at the edge
    // does not flicker out.
    expect(getNodeTransportClasses({ transportLastRf: CUTOFF }, CUTOFF)).toEqual(['rf']);
  });

  it('falls back to the most recent transport when ALL have aged out', () => {
    // Critical: returning [] would make the node match NO toggle and vanish
    // entirely — including favorites, which deliberately bypass the staleness
    // gate. Decay picks which transport is current, never whether the node is.
    const node = { transportLastRf: STALE, transportLastMqtt: STALE - HOUR };
    expect(getNodeTransportClasses(node, CUTOFF)).toEqual(['rf']);
  });

  it('never returns an empty class list for a node with any stamp', () => {
    for (const node of [
      { transportLastRf: STALE },
      { transportLastMqtt: STALE },
      { transportLastUdp: STALE },
      { transportLastRf: STALE, transportLastMqtt: STALE, transportLastUdp: STALE },
    ]) {
      expect(getNodeTransportClasses(node, CUTOFF).length).toBeGreaterThan(0);
    }
  });

  it('falls back to legacy classification for pre-migration rows', () => {
    // No stamps at all — must behave exactly as before migration 126.
    expect(getNodeTransportClasses({ transportMechanism: TX_MQTT }, CUTOFF)).toEqual(['mqtt']);
    expect(getNodeTransportClasses({ transportMechanism: TX_LORA }, CUTOFF)).toEqual(['rf']);
  });

  it('prefers its own stamps over a precomputed cross-source union', () => {
    // Stamps must win, or Unified nodes would never decay.
    const node = {
      transportLastRf: FRESH,
      transportClasses: ['mqtt' as const],
      transportMechanism: TX_MQTT,
    };
    expect(getNodeTransportClasses(node, CUTOFF)).toEqual(['rf']);
  });

  it('uses the precomputed union when the record carries no stamps', () => {
    const node = { transportClasses: ['rf' as const, 'mqtt' as const], transportMechanism: TX_MQTT };
    expect(getNodeTransportClasses(node, CUTOFF).sort()).toEqual(['mqtt', 'rf']);
  });
});

describe('nodePassesTransportFilter (#4240)', () => {
  it('keeps an RF+MQTT node visible with only Show RF on', () => {
    // The reported symptom: MQTT echoes had erased the RF classification.
    const node = { transportMechanism: TX_MQTT, transportLastRf: FRESH, transportLastMqtt: FRESH };
    expect(nodePassesTransportFilter(node, RF_ONLY, CUTOFF)).toBe(true);
    expect(nodePassesTransportFilter(node, MQTT_ONLY, CUTOFF)).toBe(true);
  });

  it('still hides an MQTT-only node when Show MQTT is off (#3112 intact)', () => {
    const node = { transportLastMqtt: FRESH };
    expect(nodePassesTransportFilter(node, RF_ONLY, CUTOFF)).toBe(false);
    expect(nodePassesTransportFilter(node, MQTT_ONLY, CUTOFF)).toBe(true);
  });

  it('stops treating a node as RF once its RF stamp ages out', () => {
    // Decay in action: RF went quiet, MQTT is current -> RF-only view drops it.
    const node = { transportLastRf: STALE, transportLastMqtt: FRESH };
    expect(nodePassesTransportFilter(node, RF_ONLY, CUTOFF)).toBe(false);
    expect(nodePassesTransportFilter(node, MQTT_ONLY, CUTOFF)).toBe(true);
  });

  it('hides everything when every toggle is off', () => {
    const node = { transportLastRf: FRESH, transportLastMqtt: FRESH };
    expect(nodePassesTransportFilter(node, NONE, CUTOFF)).toBe(false);
  });

  it('does not let a UDP stamp leak a node into an RF-only view', () => {
    expect(nodePassesTransportFilter({ transportLastUdp: FRESH }, RF_ONLY, CUTOFF)).toBe(false);
  });
});

describe('stamping semantics (#4240)', () => {
  it('an MQTT echo advances only the MQTT stamp, never clearing RF', () => {
    // Mirrors upsertNode: each column carries forward independently.
    const stored: Record<string, number> = {};
    stored[transportColumnForPacket(TX_LORA)] = NOW - 2 * HOUR;
    for (let i = 0; i < 100; i++) stored[transportColumnForPacket(TX_MQTT)] = NOW;

    expect(stored.transportLastRf).toBe(NOW - 2 * HOUR);           // survived
    expect(nodePassesTransportFilter(stored, RF_ONLY, CUTOFF)).toBe(true);
  });

  it('a node heard only over MQTT for longer than the window decays off RF', () => {
    // The property sticky booleans could not provide.
    const stored = { transportLastRf: STALE, transportLastMqtt: NOW };
    expect(nodePassesTransportFilter(stored, RF_ONLY, CUTOFF)).toBe(false);
  });
});
