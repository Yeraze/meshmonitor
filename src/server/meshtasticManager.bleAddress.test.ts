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

describe('MeshtasticManager — DeviceMetadata.ble_address (#6157)', () => {
  it('stores bleAddress from DeviceMetadata when present', async () => {
    const mgr = makeManager('2.8.0');
    await (mgr as any).processDeviceMetadata({
      firmwareVersion: '2.8.0',
      bleAddress: 'AA:BB:CC:DD:EE:FF',
    });
    expect((mgr as any).localNodeInfo.bleAddress).toBe('AA:BB:CC:DD:EE:FF');
    expect(mgr.getLocalNodeInfo()?.bleAddress).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('leaves bleAddress undefined when the field is an empty string', async () => {
    const mgr = makeManager('2.8.0');
    await (mgr as any).processDeviceMetadata({ firmwareVersion: '2.8.0', bleAddress: '' });
    expect((mgr as any).localNodeInfo.bleAddress).toBeUndefined();
  });

  it('leaves bleAddress undefined on older firmware that omits the field', async () => {
    const mgr = makeManager('2.6.0');
    await (mgr as any).processDeviceMetadata({ firmwareVersion: '2.6.0' });
    expect((mgr as any).localNodeInfo.bleAddress).toBeUndefined();
  });
});

describe('MeshtasticManager — DeviceMetadata.bootloader_version (#6321)', () => {
  it('stores bootloaderVersion from DeviceMetadata when non-zero', async () => {
    const mgr = makeManager('2.8.2');
    await (mgr as any).processDeviceMetadata({ firmwareVersion: '2.8.2', bootloaderVersion: 0x020600 });
    expect(mgr.getLocalNodeInfo()?.bootloaderVersion).toBe(0x020600);
  });

  it('leaves bootloaderVersion undefined when the field is 0 (non-nRF52)', async () => {
    const mgr = makeManager('2.8.2');
    await (mgr as any).processDeviceMetadata({ firmwareVersion: '2.8.2', bootloaderVersion: 0 });
    expect(mgr.getLocalNodeInfo()?.bootloaderVersion).toBeUndefined();
  });

  it('leaves bootloaderVersion undefined on firmware that omits the field', async () => {
    const mgr = makeManager('2.7.0');
    await (mgr as any).processDeviceMetadata({ firmwareVersion: '2.7.0' });
    expect(mgr.getLocalNodeInfo()?.bootloaderVersion).toBeUndefined();
  });
});
