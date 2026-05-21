/**
 * Tests for the classifyNodeTransport + nodePassesTransportFilter helpers.
 *
 * These power the map's Show RF / UDP / MQTT visibility toggles (#3112).
 * The classifier reads the `transportMechanism` column written by
 * migration 066, with a `viaMqtt` fallback for stub rows.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyNodeTransport,
  nodePassesTransportFilter,
  TX_INTERNAL, TX_LORA, TX_LORA_ALT1, TX_LORA_ALT2, TX_LORA_ALT3,
  TX_MQTT, TX_MULTICAST_UDP, TX_API,
} from './nodeTransport';

describe('classifyNodeTransport', () => {
  it('classifies MQTT(5) → mqtt', () => {
    expect(classifyNodeTransport({ transportMechanism: TX_MQTT })).toBe('mqtt');
  });

  it('classifies MULTICAST_UDP(6) → udp', () => {
    expect(classifyNodeTransport({ transportMechanism: TX_MULTICAST_UDP })).toBe('udp');
  });

  it('classifies LORA(1) and LORA_ALT*(2-4) → rf', () => {
    for (const tx of [TX_LORA, TX_LORA_ALT1, TX_LORA_ALT2, TX_LORA_ALT3]) {
      expect(classifyNodeTransport({ transportMechanism: tx })).toBe('rf');
    }
  });

  it('classifies INTERNAL(0) and API(7) → rf (default class)', () => {
    expect(classifyNodeTransport({ transportMechanism: TX_INTERNAL })).toBe('rf');
    expect(classifyNodeTransport({ transportMechanism: TX_API })).toBe('rf');
  });

  it('falls back to viaMqtt when transportMechanism is null', () => {
    expect(classifyNodeTransport({ transportMechanism: null, viaMqtt: true })).toBe('mqtt');
    expect(classifyNodeTransport({ transportMechanism: null, viaMqtt: false })).toBe('rf');
  });

  it('falls back to viaMqtt when transportMechanism is undefined', () => {
    expect(classifyNodeTransport({ viaMqtt: true })).toBe('mqtt');
    expect(classifyNodeTransport({ viaMqtt: false })).toBe('rf');
  });

  it('defaults to rf when both fields are absent', () => {
    expect(classifyNodeTransport({})).toBe('rf');
  });
});

describe('nodePassesTransportFilter', () => {
  // Default user setup: RF on, UDP off, MQTT off.
  const defaults = { showRfNodes: true, showUdpNodes: false, showMqttNodes: false };

  it('shows RF-class nodes when showRfNodes=true', () => {
    expect(
      nodePassesTransportFilter({ transportMechanism: TX_LORA }, defaults),
    ).toBe(true);
  });

  it('hides MQTT-class nodes under default flags', () => {
    expect(
      nodePassesTransportFilter({ transportMechanism: TX_MQTT }, defaults),
    ).toBe(false);
  });

  it('hides UDP-class nodes under default flags', () => {
    expect(
      nodePassesTransportFilter({ transportMechanism: TX_MULTICAST_UDP }, defaults),
    ).toBe(false);
  });

  it('shows MQTT-class nodes when showMqttNodes=true', () => {
    expect(
      nodePassesTransportFilter(
        { transportMechanism: TX_MQTT },
        { ...defaults, showMqttNodes: true },
      ),
    ).toBe(true);
  });

  it('shows UDP-class nodes when showUdpNodes=true', () => {
    expect(
      nodePassesTransportFilter(
        { transportMechanism: TX_MULTICAST_UDP },
        { ...defaults, showUdpNodes: true },
      ),
    ).toBe(true);
  });

  it('hides RF-class nodes when showRfNodes=false', () => {
    expect(
      nodePassesTransportFilter(
        { transportMechanism: TX_LORA },
        { ...defaults, showRfNodes: false },
      ),
    ).toBe(false);
  });

  it('honors viaMqtt fallback when transportMechanism is missing', () => {
    // A node row predating migration 066 with viaMqtt=true should still
    // gate on showMqttNodes, not show under RF by accident.
    expect(
      nodePassesTransportFilter({ viaMqtt: true }, defaults),
    ).toBe(false);
    expect(
      nodePassesTransportFilter({ viaMqtt: true }, { ...defaults, showMqttNodes: true }),
    ).toBe(true);
  });

  it('all three flags off → nothing visible', () => {
    const allOff = { showRfNodes: false, showUdpNodes: false, showMqttNodes: false };
    for (const tx of [TX_LORA, TX_MQTT, TX_MULTICAST_UDP, TX_INTERNAL, TX_API]) {
      expect(nodePassesTransportFilter({ transportMechanism: tx }, allOff)).toBe(false);
    }
  });
});
