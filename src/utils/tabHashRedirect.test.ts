import { describe, it, expect } from 'vitest';
import { getHashTabRedirectTarget, getRetiredTabRedirectTarget, MQTT_BRIDGE_SETTINGS_HASH } from './tabHashRedirect';
import { VALID_TABS } from '../types/ui';

describe('getHashTabRedirectTarget', () => {
  it('redirects every VALID_TABS hash on a bare source path (with trailing slash)', () => {
    for (const tab of VALID_TABS) {
      expect(getHashTabRedirectTarget('/source/abc123/', `#${tab}`)).toBe(`/source/abc123/${tab}`);
    }
  });

  it('redirects every VALID_TABS hash on a bare source path (no trailing slash)', () => {
    for (const tab of VALID_TABS) {
      expect(getHashTabRedirectTarget('/source/abc123', `#${tab}`)).toBe(`/source/abc123/${tab}`);
    }
  });

  it('accepts a hash value without the leading #', () => {
    expect(getHashTabRedirectTarget('/source/abc123', 'messages')).toBe('/source/abc123/messages');
  });

  it('enumerated embed/deep-link refs (#3962 5.4 PR1 census): DashboardPage/NodeMarkersLayer "seen by" jump', () => {
    expect(getHashTabRedirectTarget('/source/abc123/', '#messages')).toBe('/source/abc123/messages');
  });

  it('enumerated embed/deep-link refs: DashboardPage MQTT bridge "Configuration" button', () => {
    expect(getHashTabRedirectTarget('/source/abc123/', '#mqtt-config')).toBe('/source/abc123/mqtt-config');
  });

  it('returns null for an empty hash', () => {
    expect(getHashTabRedirectTarget('/source/abc123', '')).toBeNull();
    expect(getHashTabRedirectTarget('/source/abc123', '#')).toBeNull();
  });

  it('returns null for an unrecognized hash value', () => {
    expect(getHashTabRedirectTarget('/source/abc123', '#not-a-tab')).toBeNull();
  });

  it('returns null for the removed "themes" orphan hash', () => {
    expect(getHashTabRedirectTarget('/source/abc123', '#themes')).toBeNull();
  });

  it('returns null once the path already has a tab segment (already migrated)', () => {
    expect(getHashTabRedirectTarget('/source/abc123/nodes', '#messages')).toBeNull();
  });

  it('returns null for paths outside the source view', () => {
    expect(getHashTabRedirectTarget('/', '#nodes')).toBeNull();
    expect(getHashTabRedirectTarget('/unified/messages', '#nodes')).toBeNull();
  });

  it('returns null for a nested/non-bare source path with extra segments', () => {
    expect(getHashTabRedirectTarget('/source/abc123/foo/bar', '#nodes')).toBeNull();
  });
});

describe('getRetiredTabRedirectTarget: the MQTT bridge tab id (#5683 follow-up)', () => {
  it('keeps mqtt-config a valid tab, so stored tab state and bookmarks still resolve', () => {
    expect(VALID_TABS).toContain('mqtt-config');
  });

  it('sends the old bridge tab to the bridge section of that source\'s Settings page', () => {
    expect(getRetiredTabRedirectTarget('mqtt-config', 'abc', 'mqtt_bridge'))
      .toBe(`/source/abc/settings#${MQTT_BRIDGE_SETTINGS_HASH}`);
    expect(MQTT_BRIDGE_SETTINGS_HASH).toBe('settings-mqtt-bridge');
  });

  it('a legacy #mqtt-config link reaches the same place in two hops', () => {
    // Hop 1: the hash shim turns the bare-source hash into the tab path.
    expect(getHashTabRedirectTarget('/source/abc/', '#mqtt-config')).toBe('/source/abc/mqtt-config');
    // Hop 2: App's route for that tab redirects to the Settings section.
    expect(getRetiredTabRedirectTarget('mqtt-config', 'abc', 'mqtt_bridge'))
      .toBe('/source/abc/settings#settings-mqtt-bridge');
  });

  it('the new target is not itself rewritten by the hash shim', () => {
    expect(getHashTabRedirectTarget('/source/abc/settings', '#settings-mqtt-bridge')).toBeNull();
  });

  it('escapes the source id', () => {
    expect(getRetiredTabRedirectTarget('mqtt-config', 'a/b', 'mqtt_bridge'))
      .toBe('/source/a%2Fb/settings#settings-mqtt-bridge');
  });

  it.each(['meshtastic_tcp', 'mqtt_broker', 'meshcore', null, undefined])(
    'does not redirect on a %s source: only a bridge had that page',
    (sourceType) => {
      expect(getRetiredTabRedirectTarget('mqtt-config', 'abc', sourceType)).toBeNull();
    },
  );

  it('does not redirect without a source, or for a tab that is not retired', () => {
    expect(getRetiredTabRedirectTarget('mqtt-config', null, 'mqtt_bridge')).toBeNull();
    expect(getRetiredTabRedirectTarget('settings', 'abc', 'mqtt_bridge')).toBeNull();
    expect(getRetiredTabRedirectTarget('configuration', 'abc', 'mqtt_bridge')).toBeNull();
  });
});

describe('App wires the retired tab to its redirect', () => {
  it('renders a Navigate for the mqtt-config route and no page of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const app = readFileSync(resolve('src/App.tsx'), 'utf-8');
    const route = app.slice(app.indexOf('path="mqtt-config"'));
    const element = route.slice(0, route.indexOf('/>') + 2 + 60);
    expect(app).toContain("getRetiredTabRedirectTarget('mqtt-config', sourceId, sourceType)");
    expect(element).toContain('<Navigate to={mqttConfigRedirect} replace />');
    expect(element).not.toContain('MqttBridgeConfigurationView');
  });
});
