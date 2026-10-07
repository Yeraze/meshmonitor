import { describe, it, expect } from 'vitest';
import { isMqttProxyLinkMisconfigured, type MqttProxyLinkInput, type MqttProxyLinkSource } from './mqttProxyLink';

const node = (config?: unknown, type = 'meshtastic_tcp'): MqttProxyLinkSource => ({
  id: 'node', type, enabled: true, config,
});
const broker: MqttProxyLinkSource = { id: 'broker', type: 'mqtt_broker', enabled: true };
const bridge: MqttProxyLinkSource = { id: 'bridge', type: 'mqtt_bridge', enabled: true };
const linkTo = (id: string, enabled = true) => ({ mqttLink: { enabled, mqttBrokerSourceId: id } });

const base: Omit<MqttProxyLinkInput, 'sources'> = {
  mqttEnabled: true,
  proxyToClientEnabled: true,
  sourceId: 'node',
};

describe('isMqttProxyLinkMisconfigured', () => {
  const cases: Array<[string, MqttProxyLinkInput, boolean]> = [
    ['proxy off, no link', { ...base, proxyToClientEnabled: false, sources: [node()] }, false],
    ['MQTT off on the device, stale proxy flag', { ...base, mqttEnabled: false, sources: [node()] }, false],
    ['proxy on, link to an enabled broker', { ...base, sources: [node(linkTo('broker')), broker] }, false],
    ['proxy on, link to an enabled bridge', { ...base, sources: [node(linkTo('bridge')), bridge] }, false],
    ['proxy on, no link', { ...base, sources: [node(), broker] }, true],
    ['proxy on, config is null', { ...base, sources: [node(null), broker] }, true],
    ['proxy on, link switched off', { ...base, sources: [node(linkTo('broker', false)), broker] }, true],
    ['proxy on, link with no target id', { ...base, sources: [node({ mqttLink: { enabled: true } }), broker] }, true],
    ['proxy on, link to a deleted source', { ...base, sources: [node(linkTo('gone')), broker] }, true],
    [
      'proxy on, link to a disabled source',
      { ...base, sources: [node(linkTo('broker')), { ...broker, enabled: false }] },
      true,
    ],
    [
      'proxy on, link to a source that is not MQTT',
      { ...base, sources: [node(linkTo('other')), { id: 'other', type: 'meshtastic_tcp', enabled: true }] },
      true,
    ],
    ['MeshCore source', { ...base, sources: [node(undefined, 'meshcore')] }, false],
    ['MQTT bridge source', { ...base, sources: [node(undefined, 'mqtt_bridge')] }, false],
    ['no current source', { ...base, sourceId: null, sources: [node()] }, false],
    ['source not in the list', { ...base, sourceId: 'missing', sources: [node()] }, false],
    ['proxy on, no link, a Virtual Node client carries MQTT', { ...base, proxyClientAttached: true, sources: [node()] }, false],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(isMqttProxyLinkMisconfigured(input)).toBe(expected);
  });

  it('treats a target with no `enabled` field as enabled', () => {
    expect(
      isMqttProxyLinkMisconfigured({ ...base, sources: [node(linkTo('broker')), { id: 'broker', type: 'mqtt_broker' }] }),
    ).toBe(false);
  });
});
