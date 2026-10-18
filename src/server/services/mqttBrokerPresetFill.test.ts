/**
 * Server-side fill of a saved broker preset's login (#5794), device form shape.
 * The bridge shape is covered end to end in routes/mqttBrokerPresetRoutes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { fillDeviceMqttFromPreset, fillBridgeConfigFromPreset, detachBridgePresetId } from './mqttBrokerPresetFill.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null), getAllManagers: vi.fn().mockReturnValue([]) },
}));

let harness: RouteTestHarness;
let presetId: number;
let tlsPresetId: number;

beforeAll(async () => {
  harness = await createRouteTestApp({ mount: () => {} });
  for (const p of await harness.db.mqttBrokerPresets.listAsync()) await harness.db.mqttBrokerPresets.deleteAsync(p.id);
  presetId = (await harness.db.mqttBrokerPresets.createAsync({
    name: 'Fill FL',
    host: 'broker.fl-mesh.org',
    port: 1883,
    tls: false,
    username: 'fluser',
    password: 'flpass',
    rootTopic: null,
  })).id;
  tlsPresetId = (await harness.db.mqttBrokerPresets.createAsync({
    name: 'Fill TLS odd port',
    host: 'secure.example.org',
    port: 8884,
    tls: true,
    username: null,
    password: 'secret',
    rootTopic: null,
  })).id;
});

afterAll(async () => {
  await harness.cleanup();
});

describe('fillDeviceMqttFromPreset', () => {
  it('does nothing without a preset id', async () => {
    const cfg: Record<string, unknown> = { address: 'x', username: '', password: '' };
    expect(await fillDeviceMqttFromPreset(cfg)).toBeNull();
    expect(cfg).toEqual({ address: 'x', username: '', password: '' });
  });

  it('fills a blank login when the address reaches the preset, and drops the id', async () => {
    const cfg: Record<string, unknown> = {
      address: 'broker.fl-mesh.org',
      tlsEnabled: false,
      username: '',
      password: '',
      brokerPresetId: presetId,
    };
    expect(await fillDeviceMqttFromPreset(cfg)).toBeNull();
    expect(cfg).toEqual({ address: 'broker.fl-mesh.org', tlsEnabled: false, username: 'fluser', password: 'flpass' });
  });

  it('accepts host:port with the preset port, and keeps typed values', async () => {
    const cfg: Record<string, unknown> = {
      address: 'BROKER.fl-mesh.org:1883',
      tlsEnabled: false,
      username: 'me',
      password: '',
      brokerPresetId: String(presetId),
    };
    expect(await fillDeviceMqttFromPreset(cfg)).toBeNull();
    expect(cfg).toMatchObject({ username: 'me', password: 'flpass' });
  });

  it('needs the explicit port when the preset uses a non-default one', async () => {
    const bare: Record<string, unknown> = { address: 'secure.example.org', tlsEnabled: true, brokerPresetId: tlsPresetId };
    expect((await fillDeviceMqttFromPreset(bare))?.code).toBe('BROKER_PRESET_ENDPOINT_MISMATCH');
    expect(bare.password).toBeUndefined();

    const withPort: Record<string, unknown> = { address: 'secure.example.org:8884', tlsEnabled: true, brokerPresetId: tlsPresetId };
    expect(await fillDeviceMqttFromPreset(withPort)).toBeNull();
    expect(withPort.password).toBe('secret');
  });

  it.each([
    [{ address: 'evil.example.org', tlsEnabled: false }],
    [{ address: 'broker.fl-mesh.org:9999', tlsEnabled: false }],
    [{ address: 'broker.fl-mesh.org', tlsEnabled: true }],
    [{ address: '', tlsEnabled: false }],
  ])('refuses an address that does not reach the preset (%#)', async (fields) => {
    const cfg: Record<string, unknown> = { ...fields, username: '', password: '', brokerPresetId: presetId };
    const err = await fillDeviceMqttFromPreset(cfg);
    expect(err).toMatchObject({ status: 400, code: 'BROKER_PRESET_ENDPOINT_MISMATCH' });
    expect(cfg.password).toBe('');
  });

  it('rejects a malformed id and a missing preset', async () => {
    expect((await fillDeviceMqttFromPreset({ brokerPresetId: 'abc' }))?.code).toBe('BROKER_PRESET_INVALID');
    expect((await fillDeviceMqttFromPreset({ brokerPresetId: 987654 }))?.code).toBe('BROKER_PRESET_NOT_FOUND');
  });
});

describe('bridge helpers', () => {
  it('detachBridgePresetId takes the id off without mutating upstream in place', () => {
    const upstream = { url: 'mqtt://a:1883', brokerPresetId: 3 };
    const cfg: Record<string, unknown> = { upstream };
    expect(detachBridgePresetId(cfg)).toBe(3);
    expect(cfg.upstream).toEqual({ url: 'mqtt://a:1883' });
    expect(upstream.brokerPresetId).toBe(3);
    expect(detachBridgePresetId({ upstream: { url: 'x' } })).toBeUndefined();
  });

  it('fillBridgeConfigFromPreset ignores a config with no upstream', async () => {
    expect(await fillBridgeConfigFromPreset({})).toBeNull();
  });
});
