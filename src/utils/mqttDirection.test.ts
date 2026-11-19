import { describe, it, expect } from 'vitest';
import {
  getMqttDirection,
  resolveBridgeMode,
  type MqttDirectionSource,
  type MqttBridgeModeValue,
} from './mqttDirection';

const broker: MqttDirectionSource = { id: 'b', type: 'mqtt_broker', config: {} };
const bridge = (config: Record<string, unknown>, id = 'br'): MqttDirectionSource => ({ id, type: 'mqtt_bridge', config });
const node = (target: string | null, enabled = true): MqttDirectionSource => ({
  id: 'n',
  type: 'meshtastic_tcp',
  config: target ? { mqttLink: { enabled, mqttBrokerSourceId: target } } : {},
});
/** Mode straight from each bridge's config, as an admin sees it. */
const adminMode = (s: MqttDirectionSource) => resolveBridgeMode(s, undefined, true);

describe('resolveBridgeMode', () => {
  it('prefers the live status', () => {
    expect(resolveBridgeMode(bridge({ mode: 'publish_only' }), 'subscribe_only', false)).toBe('subscribe_only');
  });
  it('reads a missing config mode as bidirectional for an admin', () => {
    expect(resolveBridgeMode(bridge({}), undefined, true)).toBe('bidirectional');
  });
  it('returns null for a non-admin without status, since config withholds the mode', () => {
    expect(resolveBridgeMode(bridge({}), undefined, false)).toBeNull();
  });
  it('rejects an unknown value', () => {
    expect(resolveBridgeMode(bridge({ mode: 'sideways' }), 'sideways', true)).toBeNull();
  });
});

describe('getMqttDirection — bridge', () => {
  const cases: Array<[string, MqttBridgeModeValue, boolean, string | null]> = [
    ['standalone, default mode', 'bidirectional', false, 'monitor'],
    ['standalone, subscribe only', 'subscribe_only', false, 'monitor'],
    ['standalone, publish only', 'publish_only', false, null],
    ['with parent, bidirectional', 'bidirectional', true, 'both'],
    ['with parent, subscribe only', 'subscribe_only', true, 'downlink'],
    ['with parent, publish only', 'publish_only', true, 'uplink'],
  ];
  it.each(cases)('%s', (_name, mode, withParent, expected) => {
    const b = bridge({ mode, ...(withParent ? { brokerSourceId: 'b' } : {}) });
    expect(getMqttDirection(b, [broker, b], adminMode)).toBe(expected);
  });

  it('counts a node linked to a standalone bridge as its local side', () => {
    const b = bridge({});
    expect(getMqttDirection(b, [b, node('br')], adminMode)).toBe('both');
  });

  it('ignores a disabled link and a disabled node', () => {
    const b = bridge({});
    expect(getMqttDirection(b, [b, node('br', false)], adminMode)).toBe('monitor');
    expect(getMqttDirection(b, [b, { ...node('br'), enabled: false }], adminMode)).toBe('monitor');
  });

  it('shows nothing when the mode is unknown', () => {
    const b = bridge({});
    expect(getMqttDirection(b, [b], () => null)).toBeNull();
  });
});

describe('getMqttDirection — broker', () => {
  it('is local with no bridges', () => {
    expect(getMqttDirection(broker, [broker], adminMode)).toBe('local');
  });
  it('takes its direction from its bridges', () => {
    const up = bridge({ brokerSourceId: 'b', mode: 'publish_only' }, 'u');
    const down = bridge({ brokerSourceId: 'b', mode: 'subscribe_only' }, 'd');
    expect(getMqttDirection(broker, [broker, up], adminMode)).toBe('uplink');
    expect(getMqttDirection(broker, [broker, down], adminMode)).toBe('downlink');
    expect(getMqttDirection(broker, [broker, up, down], adminMode)).toBe('both');
  });
  it('skips disabled bridges and bridges on other brokers', () => {
    const off = { ...bridge({ brokerSourceId: 'b' }, 'x'), enabled: false };
    const other = bridge({ brokerSourceId: 'z' }, 'y');
    expect(getMqttDirection(broker, [broker, off, other], adminMode)).toBe('local');
  });
  it('shows nothing when any child bridge mode is unknown, even if others are known', () => {
    const up = bridge({ brokerSourceId: 'b', mode: 'publish_only' }, 'u');
    const unk = bridge({ brokerSourceId: 'b' }, 'unk');
    expect(getMqttDirection(broker, [broker, up, unk], (s) => (s.id === 'unk' ? null : adminMode(s)))).toBeNull();
  });
  it('shows nothing when a child bridge mode is unknown', () => {
    const b = bridge({ brokerSourceId: 'b' });
    expect(getMqttDirection(broker, [broker, b], () => null)).toBeNull();
  });
});

describe('getMqttDirection — other types', () => {
  it('marks a linked node as client proxy', () => {
    expect(getMqttDirection(node('b'), [broker, node('b')], adminMode)).toBe('client_proxy');
    expect(getMqttDirection(node(null), [], adminMode)).toBeNull();
  });
  it('drops client proxy when the visible target is disabled or not MQTT', () => {
    expect(getMqttDirection(node('b'), [{ ...broker, enabled: false }], adminMode)).toBeNull();
    expect(getMqttDirection(node('b'), [{ id: 'b', type: 'meshcore' }], adminMode)).toBeNull();
  });
  it('trusts a link to a source the viewer cannot see', () => {
    expect(getMqttDirection(node('hidden'), [], adminMode)).toBe('client_proxy');
  });
  it('marks MeshCore MQTT sources as monitor only', () => {
    expect(getMqttDirection({ id: 'm', type: 'meshcore_mqtt' }, [], adminMode)).toBe('monitor');
    expect(getMqttDirection({ id: 'm', type: 'meshcore_mqtt_broker' }, [], adminMode)).toBe('monitor');
  });
  it('has no badge for a plain MeshCore source', () => {
    expect(getMqttDirection({ id: 'm', type: 'meshcore' }, [], adminMode)).toBeNull();
  });
});
