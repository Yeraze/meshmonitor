import { describe, it, expect } from 'vitest';
import {
  buildBridgeConfig,
  formFromBridgeConfig,
  emptyBridgeForm,
  type BridgeConfigForm,
} from './mqttBridgeConfig';

describe('mqttBridgeConfig', () => {
  describe('buildBridgeConfig', () => {
    it('requires an upstream URL', () => {
      const form = { ...emptyBridgeForm(), url: '' };
      const { error, config } = buildBridgeConfig(form, { editing: false });
      expect(config).toBeUndefined();
      expect(error?.key).toBe('source.form.error_mqtt_url_required');
    });

    it('serializes a minimal standalone bridge with defaults omitted', () => {
      const form = { ...emptyBridgeForm(), url: 'mqtt://broker:1883' };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config).toEqual({
        upstream: { url: 'mqtt://broker:1883', username: undefined, password: undefined },
        subscriptions: ['msh/#'],
      });
      // Non-default keys must be absent.
      expect(config).not.toHaveProperty('mode');
      expect(config).not.toHaveProperty('forwardingMode');
      expect(config).not.toHaveProperty('ignoreOkToMqtt');
      expect(config).not.toHaveProperty('brokerSourceId');
    });

    it('serializes non-default mode/forwarding/ignore and splits subscriptions', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        subscriptions: 'msh/US/#\n  msh/EU/#  \n\n',
        mode: 'publish_only',
        forwardingMode: 'single',
        ignoreOkToMqtt: true,
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config?.subscriptions).toEqual(['msh/US/#', 'msh/EU/#']);
      expect(config?.mode).toBe('publish_only');
      expect(config?.forwardingMode).toBe('single');
      expect(config?.ignoreOkToMqtt).toBe(true);
    });

    it('writes uplinkFilters.channels.allow for a channel multiselect (#3294)', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkChannels: ['LongFast', 'Telemetry'],
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config?.uplinkFilters).toEqual({
        channels: { allow: ['LongFast', 'Telemetry'] },
      });
    });

    it('removes uplinkFilters.channels when no channels are selected', () => {
      const base = { uplinkFilters: { channels: { allow: ['Old'] } } };
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkChannels: [],
      };
      const { config } = buildBridgeConfig(form, { editing: true, base });
      expect(config).not.toHaveProperty('uplinkFilters');
    });

    it('keeps channel allow-list and topic filter together in uplinkFilters', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkChannels: ['LongFast'],
        uplinkTopicMode: 'block',
        uplinkTopics: 'msh/CA/#',
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config?.uplinkFilters).toEqual({
        channels: { allow: ['LongFast'] },
        topics: { block: ['msh/CA/#'] },
      });
    });

    it('trims and drops blank channel names', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkChannels: ['  LongFast  ', '', '   '],
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config?.uplinkFilters).toEqual({ channels: { allow: ['LongFast'] } });
    });

    it('writes uplinkFilters.topics.allow for a publish allow-list (#3294)', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkTopicMode: 'allow',
        uplinkTopics: 'msh/US/FL/+/+/LongFast/#',
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config?.uplinkFilters).toEqual({
        topics: { allow: ['msh/US/FL/+/+/LongFast/#'] },
      });
    });

    it('writes uplinkFilters.topics.block for a publish block-list and clears allow', () => {
      const base = { uplinkFilters: { topics: { allow: ['old'] } } };
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkTopicMode: 'block',
        uplinkTopics: 'msh/CA/#',
      };
      const { config } = buildBridgeConfig(form, { editing: true, base });
      expect(config?.uplinkFilters).toEqual({ topics: { block: ['msh/CA/#'] } });
    });

    it('removes uplinkFilters when the publish filter is turned off', () => {
      const base = { uplinkFilters: { topics: { allow: ['x'] } } };
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        uplinkTopicMode: 'off',
        uplinkTopics: '',
      };
      const { config } = buildBridgeConfig(form, { editing: true, base });
      expect(config).not.toHaveProperty('uplinkFilters');
    });

    it('preserves all advanced fields when the modal posts only the basics', () => {
      // The lightweight modal sends just broker/url/creds/subscriptions.
      const base = {
        brokerSourceId: 'broker-1',
        upstream: { url: 'mqtt://old:1883', username: 'old', password: 'secret' },
        subscriptions: ['msh/#'],
        mode: 'subscribe_only',
        forwardingMode: 'single',
        ignoreOkToMqtt: true,
        downlinkFilters: { topics: { block: ['msh/CA/#'] }, geo: { minLat: 1 } },
        uplinkFilters: { channels: { allow: ['LongFast'] } },
        downlinkTopicRewrite: { from: 'msh/US', to: 'msh/local' },
      };
      const { config } = buildBridgeConfig(
        {
          brokerId: 'broker-1',
          url: 'mqtt://new:1883',
          username: 'new',
          password: '',
          subscriptions: 'msh/US/#',
        },
        { editing: true, base },
      );
      // Basics updated:
      expect(config?.upstream.url).toBe('mqtt://new:1883');
      expect(config?.upstream.username).toBe('new');
      expect(config?.subscriptions).toEqual(['msh/US/#']);
      // Everything the modal doesn't render is preserved verbatim:
      expect(config?.mode).toBe('subscribe_only');
      expect(config?.forwardingMode).toBe('single');
      expect(config?.ignoreOkToMqtt).toBe(true);
      expect(config?.downlinkFilters).toEqual({ topics: { block: ['msh/CA/#'] }, geo: { minLat: 1 } });
      expect(config?.uplinkFilters).toEqual({ channels: { allow: ['LongFast'] } });
      expect(config?.downlinkTopicRewrite).toEqual({ from: 'msh/US', to: 'msh/local' });
    });

    it('preserves base.uplinkFilters when the caller does not manage uplink (modal)', () => {
      const base = { uplinkFilters: { topics: { block: ['keep'] } } };
      // Modal-style form: uplinkTopicMode omitted.
      const form = { ...emptyBridgeForm(), url: 'mqtt://broker:1883' };
      delete (form as Partial<BridgeConfigForm>).uplinkChannels;
      delete (form as Partial<BridgeConfigForm>).uplinkTopicMode;
      delete (form as Partial<BridgeConfigForm>).uplinkTopics;
      const { config } = buildBridgeConfig(form, { editing: true, base });
      expect(config?.uplinkFilters).toEqual({ topics: { block: ['keep'] } });
    });

    it('preserves unmanaged downlink subkeys while updating topics.block', () => {
      const base = { downlinkFilters: { nodes: { block: ['!deadbeef'] } } };
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        useTopicBlock: true,
        topicBlock: 'msh/CA/QC/#',
      };
      const { config } = buildBridgeConfig(form, { editing: true, base });
      expect(config?.downlinkFilters).toEqual({
        nodes: { block: ['!deadbeef'] },
        topics: { block: ['msh/CA/QC/#'] },
      });
    });

    it('rejects non-numeric geo bounds', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        useGeo: true,
        geo: { minLat: 'abc', maxLat: '', minLng: '', maxLng: '' },
      };
      const { error } = buildBridgeConfig(form, { editing: false });
      expect(error?.key).toBe('source.form.error_geo_invalid');
    });

    it('writes downlink geo bounds', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        useGeo: true,
        geo: { minLat: '25', maxLat: '31', minLng: '-87', maxLng: '-80' },
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      expect(config?.downlinkFilters?.geo).toEqual({
        minLat: 25,
        maxLat: 31,
        minLng: -87,
        maxLng: -80,
      });
    });

    it('omits the password on edit so the server preserves the stored one', () => {
      const form: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        username: 'me',
        password: '',
      };
      const { config } = buildBridgeConfig(form, {
        editing: true,
        base: { upstream: { url: 'mqtt://broker:1883', username: 'me', password: 'secret' } },
      });
      expect(config?.upstream.password).toBeUndefined();
      // Round-trips through JSON without leaking the stored password.
      expect(JSON.parse(JSON.stringify(config)).upstream).not.toHaveProperty('password');
    });

    it('emits topic rewrites only when attached to a parent broker', () => {
      const attached: BridgeConfigForm = {
        ...emptyBridgeForm(),
        url: 'mqtt://broker:1883',
        brokerId: 'broker-1',
        downlinkRewrite: { from: 'msh/US', to: 'msh/local' },
        uplinkRewrite: { from: '', to: '' },
      };
      const a = buildBridgeConfig(attached, { editing: false });
      expect(a.config?.downlinkTopicRewrite).toEqual({ from: 'msh/US', to: 'msh/local' });
      expect(a.config).not.toHaveProperty('uplinkTopicRewrite');

      const standalone: BridgeConfigForm = {
        ...attached,
        brokerId: '',
      };
      const s = buildBridgeConfig(standalone, { editing: false });
      expect(s.config).not.toHaveProperty('downlinkTopicRewrite');
    });
  });

  describe('round-trip', () => {
    it('formFromBridgeConfig(buildBridgeConfig(form)) preserves all managed fields', () => {
      const form: BridgeConfigForm = {
        brokerId: 'broker-1',
        url: 'mqtt://broker:1883',
        username: 'user',
        password: '', // not persisted in config output
        subscriptions: 'msh/US/#\nmsh/EU/#',
        mode: 'subscribe_only',
        forwardingMode: 'single',
        ignoreOkToMqtt: true,
        useTopicBlock: true,
        topicBlock: 'msh/CA/#',
        useGeo: true,
        geo: { minLat: '25', maxLat: '31', minLng: '-87', maxLng: '-80' },
        uplinkChannels: ['LongFast', 'Telemetry'],
        uplinkTopicMode: 'allow',
        uplinkTopics: 'msh/US/FL/+/+/LongFast/#',
        downlinkRewrite: { from: 'msh/US', to: 'msh/local' },
        uplinkRewrite: { from: 'msh/local', to: 'msh/US' },
      };
      const { config } = buildBridgeConfig(form, { editing: false });
      const round = formFromBridgeConfig(config);
      expect(round).toEqual({ ...form, password: '' });
    });
  });
});
