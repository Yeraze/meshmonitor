import { describe, it, expect, vi } from 'vitest';

// Stub the TCP transport so constructing a manager never touches a real socket
vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

// Prevent the constructor's async position-recalc path from touching the DB
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

import { MeshtasticManager } from './meshtasticManager.js';

function makeManager(firmwareVersion: string | undefined) {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = {
    nodeNum: 123,
    nodeId: '!0000007b',
    firmwareVersion,
  };
  return mgr;
}

describe('MeshtasticManager — excluded_modules gating (#5065)', () => {
  it('reports every module available when the device excludes nothing', () => {
    const mgr = makeManager('2.7.4');
    const { supportedModules } = (mgr as any).getCurrentConfig();
    expect(supportedModules.mqtt).toBe(true);
    expect(supportedModules.paxcounter).toBe(true);
    expect(supportedModules.rangetest).toBe(true);
  });

  it('marks only the bits the device set as unavailable', () => {
    const mgr = makeManager('2.7.4');
    (mgr as any).localNodeInfo.excludedModules = 0x0001 | 0x1000; // MQTT + Paxcounter
    const { supportedModules } = (mgr as any).getCurrentConfig();
    expect(supportedModules.mqtt).toBe(false);
    expect(supportedModules.paxcounter).toBe(false);
    expect(supportedModules.telemetry).toBe(true);
    expect(supportedModules.network).toBe(true);
  });

  it('keeps the Range Test firmware gate separate from the build gate', () => {
    // 2.7 build that excluded Range Test: the module is gone from this build,
    // but the firmware-version gate (#5031) still says 2.7 has the module.
    const excluded = makeManager('2.7.4');
    (excluded as any).localNodeInfo.excludedModules = 0x0010;
    const excludedModules = (excluded as any).getCurrentConfig().supportedModules;
    expect(excludedModules.rangetest).toBe(false);
    expect(excludedModules.rangeTest).toBe(true);

    // 2.8 node that reports no exclusions: the build kept it, the firmware
    // dropped it.
    const firmware28 = makeManager('2.8.0');
    const modules28 = (firmware28 as any).getCurrentConfig().supportedModules;
    expect(modules28.rangetest).toBe(true);
    expect(modules28.rangeTest).toBe(false);
  });

  it('stores the mask from DeviceMetadata, and leaves it unset when absent', async () => {
    const mgr = makeManager('2.7.4');
    await (mgr as any).processDeviceMetadata({ firmwareVersion: '2.7.4', excludedModules: 0x0020 });
    expect((mgr as any).localNodeInfo.excludedModules).toBe(0x0020);
    expect((mgr as any).getCurrentConfig().supportedModules.telemetry).toBe(false);

    const older = makeManager('2.6.0');
    await (older as any).processDeviceMetadata({ firmwareVersion: '2.6.0' });
    expect((older as any).localNodeInfo.excludedModules).toBeUndefined();
    expect((older as any).getCurrentConfig().supportedModules.telemetry).toBe(true);
  });
});
