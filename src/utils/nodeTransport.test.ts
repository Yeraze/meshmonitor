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
  isMqttOnlySourceType,
  countNodesByTransport,
  transportCutoffSec,
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

describe('nodePassesTransportFilter — additive transportClasses (Unified)', () => {
  // A node heard via RF on one source and MQTT on another carries both classes.
  const rfAndMqtt = { transportClasses: ['rf', 'mqtt'] as const, transportMechanism: TX_MQTT };

  it('stays visible under "Show RF" even when MQTT is off (the reported bug)', () => {
    expect(
      nodePassesTransportFilter(rfAndMqtt, { showRfNodes: true, showUdpNodes: false, showMqttNodes: false }),
    ).toBe(true);
  });

  it('stays visible under "Show MQTT" even when RF is off', () => {
    expect(
      nodePassesTransportFilter(rfAndMqtt, { showRfNodes: false, showUdpNodes: false, showMqttNodes: true }),
    ).toBe(true);
  });

  it('is hidden only when ALL of its classes are toggled off', () => {
    expect(
      nodePassesTransportFilter(rfAndMqtt, { showRfNodes: false, showUdpNodes: true, showMqttNodes: false }),
    ).toBe(false);
  });

  it('ignores the collapsed transportMechanism when a transportClasses union is present', () => {
    // transportMechanism says MQTT (newest-wins from the merge), but the union
    // includes rf — RF-only filter must still show it.
    expect(
      nodePassesTransportFilter(
        { transportClasses: ['rf'], transportMechanism: TX_MQTT },
        { showRfNodes: true, showUdpNodes: false, showMqttNodes: false },
      ),
    ).toBe(true);
  });

  it('falls back to single-class classification when transportClasses is empty/absent', () => {
    expect(
      nodePassesTransportFilter(
        { transportClasses: [], transportMechanism: TX_MQTT },
        { showRfNodes: true, showUdpNodes: false, showMqttNodes: false },
      ),
    ).toBe(false);
  });
});

/**
 * #5283 maintainer review: `mqtt_bridge`/`mqtt_broker` sources have no RF
 * path — every node on them arrived over MQTT — so the RF/UDP/MQTT toggles
 * (and their saved per-user preference) have no meaning there and must be
 * skipped outright rather than relied on for a default. Consumers gate on
 * this helper instead of defaulting `showMqttNodes` on for these sources.
 */
describe('isMqttOnlySourceType', () => {
  it('is true for mqtt_bridge', () => {
    expect(isMqttOnlySourceType('mqtt_bridge')).toBe(true);
  });

  it('is true for mqtt_broker', () => {
    expect(isMqttOnlySourceType('mqtt_broker')).toBe(true);
  });

  it('is false for meshtastic_tcp, meshcore, and other RF/mixed source types', () => {
    expect(isMqttOnlySourceType('meshtastic_tcp')).toBe(false);
    expect(isMqttOnlySourceType('meshcore')).toBe(false);
    expect(isMqttOnlySourceType('meshcore_mqtt')).toBe(false);
    expect(isMqttOnlySourceType('reticulum')).toBe(false);
  });

  it('is false for null/undefined (e.g. the cross-source Dashboard/Unified view)', () => {
    expect(isMqttOnlySourceType(null)).toBe(false);
    expect(isMqttOnlySourceType(undefined)).toBe(false);
  });
});

/**
 * #5101 WP4: the Info tab's "Heard via" tally. Additive (OR) — a node with
 * evidence on more than one transport counts once per class, so the parts
 * can sum to more than `nodes.length`. That is the overlap the UI's note
 * explains, not a bug here.
 */
describe('countNodesByTransport', () => {
  it('counts an overlap node in both of its classes, so the sum exceeds nodes.length', () => {
    const nodes = [
      { transportClasses: ['rf', 'mqtt'] as const },
      { transportClasses: ['rf'] as const },
    ];
    const tally = countNodesByTransport(nodes);
    expect(tally).toEqual({ rf: 2, udp: 0, mqtt: 1 });
    expect(tally.rf + tally.udp + tally.mqtt).toBeGreaterThan(nodes.length);
  });

  it('drops a stale class under a cutoff, keeping only the fresh one', () => {
    const cutoff = transportCutoffSec(1, 2_000_000 * 1000); // 1h window, now = 2,000,000s
    const node = {
      transportLastRf: 2_000_000 - 10, // fresh
      transportLastMqtt: 2_000_000 - 10_000, // stale (> 1h old)
    };
    const tally = countNodesByTransport([node], cutoff);
    expect(tally).toEqual({ rf: 1, udp: 0, mqtt: 0 });
  });

  it('falls back to the newest class (never zero) when every transport has aged out', () => {
    const cutoff = transportCutoffSec(1, 2_000_000 * 1000);
    const node = {
      transportLastRf: 2_000_000 - 100_000,
      transportLastMqtt: 2_000_000 - 50_000, // newest of the two, still stale
    };
    const tally = countNodesByTransport([node], cutoff);
    expect(tally).toEqual({ rf: 0, udp: 0, mqtt: 1 });
  });

  it('classifies a node with no stamps but viaMqtt=true as mqtt', () => {
    const tally = countNodesByTransport([{ viaMqtt: true }]);
    expect(tally).toEqual({ rf: 0, udp: 0, mqtt: 1 });
  });

  it('classifies a node with no stamps and no flag as rf', () => {
    const tally = countNodesByTransport([{}]);
    expect(tally).toEqual({ rf: 1, udp: 0, mqtt: 0 });
  });

  it('returns all-zero tally for an empty node list', () => {
    expect(countNodesByTransport([])).toEqual({ rf: 0, udp: 0, mqtt: 0 });
  });
});
