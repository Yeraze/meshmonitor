import { describe, it, expect, vi } from 'vitest';
import {
  ADMIN_LOAD_SECTIONS,
  CONFIG_APPLIERS,
  LOAD_CONFIG_TYPES,
  allSectionStatus,
  applyLoadedConfig,
  type LoadedConfigSetters,
} from './applyLoadedConfig';
import { MESH_BEACON_FLAGS } from './useAdminCommandsState';

function makeSetters(): LoadedConfigSetters & Record<string, ReturnType<typeof vi.fn>> {
  return {
    setDeviceConfig: vi.fn(),
    setLoRaConfig: vi.fn(),
    setPositionConfig: vi.fn(),
    setMQTTConfig: vi.fn(),
    setSecurityConfig: vi.fn(),
    setBluetoothConfig: vi.fn(),
    setNetworkConfig: vi.fn(),
    setNeighborInfoConfig: vi.fn(),
    setTelemetryConfig: vi.fn(),
    setStatusMessageConfig: vi.fn(),
    setTrafficManagementConfig: vi.fn(),
    setMeshBeaconConfig: vi.fn(),
    setTAKConfig: vi.fn(),
  };
}

const callCount = (setters: Record<string, ReturnType<typeof vi.fn>>) =>
  Object.values(setters).reduce((sum, setter) => sum + setter.mock.calls.length, 0);

describe('applyLoadedConfig', () => {
  it('has an applier for every load-config section, and no stray ones', () => {
    expect(Object.keys(CONFIG_APPLIERS).sort()).toEqual([...LOAD_CONFIG_TYPES].sort());
  });

  it('lists owner and channels as the only sections with their own loader', () => {
    expect(ADMIN_LOAD_SECTIONS.filter(section => !(LOAD_CONFIG_TYPES as readonly string[]).includes(section)))
      .toEqual(['owner', 'channels']);
  });

  it.each([...LOAD_CONFIG_TYPES])('%s: an empty config object still writes state and reports applied', (configType) => {
    const setters = makeSetters();
    expect(applyLoadedConfig(configType, {}, setters, { nodeNum: 100 })).toBe(true);
    expect(callCount(setters)).toBeGreaterThan(0);
  });

  it.each([null, undefined, '', 0, 'config'])('writes nothing and reports not-applied for a %j reply', (config) => {
    const setters = makeSetters();
    for (const configType of LOAD_CONFIG_TYPES) {
      expect(applyLoadedConfig(configType, config, setters, { nodeNum: 100 })).toBe(false);
    }
    expect(callCount(setters)).toBe(0);
  });

  it.each(['owner', 'channels', 'display', ''])('writes nothing and reports not-applied for section "%s"', (configType) => {
    const setters = makeSetters();
    expect(applyLoadedConfig(configType, { anything: 1 }, setters, { nodeNum: 100 })).toBe(false);
    expect(callCount(setters)).toBe(0);
  });

  it('applies a status message reply', () => {
    const setters = makeSetters();
    applyLoadedConfig('statusmessage', { nodeStatus: 'On the hill' }, setters, { nodeNum: 100 });
    expect(setters.setStatusMessageConfig).toHaveBeenCalledWith({ nodeStatus: 'On the hill' });
  });

  it('applies a traffic management reply, reading absent knobs as 0', () => {
    const setters = makeSetters();
    applyLoadedConfig('trafficmanagement', { positionMinIntervalSecs: 600, rateLimitMaxPackets: 40 }, setters, { nodeNum: 100 });
    expect(setters.setTrafficManagementConfig).toHaveBeenCalledWith({
      positionMinIntervalSecs: 600,
      nodeinfoDirectResponseMaxHops: 0,
      rateLimitWindowSecs: 0,
      rateLimitMaxPackets: 40,
      unknownPacketThreshold: 0,
    });
  });

  it('applies a MeshBeacon reply through the shared parser', () => {
    const setters = makeSetters();
    applyLoadedConfig(
      'meshbeacon',
      { flags: MESH_BEACON_FLAGS.BROADCAST_ENABLED, broadcastMessage: 'hello', broadcastIntervalSecs: 7200 },
      setters,
      { nodeNum: 100 },
    );
    expect(setters.setMeshBeaconConfig).toHaveBeenCalledWith(expect.objectContaining({
      listenEnabled: false,
      broadcastEnabled: true,
      broadcastMessage: 'hello',
      broadcastIntervalSecs: 7200,
      broadcastOfferPreset: null,
    }));
  });

  it('decodes position flags into the position write', () => {
    const setters = makeSetters();
    applyLoadedConfig('position', { positionBroadcastSecs: 900, positionFlags: 0x0001 | 0x0200 }, setters, { nodeNum: 100 });
    expect(setters.setPositionConfig).toHaveBeenCalledTimes(1);
    const written = setters.setPositionConfig.mock.calls[0][0];
    expect(written.positionBroadcastSecs).toBe(900);
    expect(written.positionFlags).toMatchObject({ altitude: true, speed: true, heading: false });
  });

  it('leaves position flags alone when the reply has none', () => {
    const setters = makeSetters();
    applyLoadedConfig('position', { positionBroadcastSecs: 900 }, setters, { nodeNum: 100 });
    expect('positionFlags' in setters.setPositionConfig.mock.calls[0][0]).toBe(false);
  });

  it('stamps the security Save gate with the node the reply came from (#4736, #5077)', () => {
    const setters = makeSetters();
    applyLoadedConfig('security', { isManaged: true }, setters, { nodeNum: 4242 });
    const merged = Object.assign({}, ...setters.setSecurityConfig.mock.calls.map(([update]) => update));
    expect(merged.loadedForNodeNum).toBe(4242);
  });
});

describe('allSectionStatus', () => {
  it('covers every section with a Load button', () => {
    const status = allSectionStatus('idle');
    expect(Object.keys(status).sort()).toEqual([...ADMIN_LOAD_SECTIONS].sort());
    expect(new Set(Object.values(status))).toEqual(new Set(['idle']));
  });
});
