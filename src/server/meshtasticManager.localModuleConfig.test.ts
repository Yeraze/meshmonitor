import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

// Mock protobufService — auto-stub any method via a Proxy so the constructor
// never crashes on an unmocked call; override decodeAdminMessage per test.
const { decodeAdminMessageMock } = vi.hoisted(() => ({
  decodeAdminMessageMock: vi.fn(),
}));
vi.mock('./protobufService.js', () => {
  const base: any = {
    decodeAdminMessage: decodeAdminMessageMock,
    createGetModuleConfigRequest: vi.fn(() => new Uint8Array()),
    createAdminPacket: vi.fn(() => new Uint8Array()),
  };
  const proxy = new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn();
      return target[prop];
    },
  });
  return { default: proxy, convertIpv4ConfigToStrings: vi.fn((x: any) => x) };
});

import { MeshtasticManager } from './meshtasticManager.js';

const LOCAL_NODE_NUM = 123;

function makeManager() {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = {
    nodeNum: LOCAL_NODE_NUM,
    nodeId: '!0000007b',
    firmwareVersion: '2.7.24',
  };
  return mgr;
}

describe('MeshtasticManager — local module config response handling', () => {
  beforeEach(() => {
    decodeAdminMessageMock.mockReset();
  });

  it('merges a non-empty local getModuleConfigResponse into actualModuleConfig', async () => {
    const mgr = makeManager();
    (mgr as any).actualModuleConfig = { mqtt: { enabled: true } };

    decodeAdminMessageMock.mockReturnValue({
      getModuleConfigResponse: { telemetry: { deviceUpdateInterval: 900 } },
    });

    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from: LOCAL_NODE_NUM });

    expect((mgr as any).actualModuleConfig.telemetry).toEqual({ deviceUpdateInterval: 900 });
    // Existing keys preserved (merge, not replace)
    expect((mgr as any).actualModuleConfig.mqtt).toEqual({ enabled: true });
  });

  it('records an all-default (empty) local response under the pending key', async () => {
    const mgr = makeManager();
    (mgr as any).actualModuleConfig = {};
    // requestModuleConfig(14) would set this; simulate it directly
    (mgr as any).pendingModuleConfigRequests.set(LOCAL_NODE_NUM, 'trafficManagement');

    decodeAdminMessageMock.mockReturnValue({ getModuleConfigResponse: {} });

    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from: LOCAL_NODE_NUM });

    expect((mgr as any).actualModuleConfig.trafficManagement).toEqual({});
    // Pending entry consumed
    expect((mgr as any).pendingModuleConfigRequests.has(LOCAL_NODE_NUM)).toBe(false);
  });

  it('handles an empty local response when packet `from` is 0 (local origin)', async () => {
    const mgr = makeManager();
    (mgr as any).actualModuleConfig = {};
    (mgr as any).pendingModuleConfigRequests.set(LOCAL_NODE_NUM, 'statusmessage');

    decodeAdminMessageMock.mockReturnValue({ getModuleConfigResponse: {} });

    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from: 0 });

    expect((mgr as any).actualModuleConfig.statusmessage).toEqual({});
  });

  it('does not overwrite an existing populated config with empty defaults', async () => {
    const mgr = makeManager();
    (mgr as any).actualModuleConfig = { trafficManagement: { enabled: true } };
    (mgr as any).pendingModuleConfigRequests.set(LOCAL_NODE_NUM, 'trafficManagement');

    decodeAdminMessageMock.mockReturnValue({ getModuleConfigResponse: {} });

    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from: LOCAL_NODE_NUM });

    expect((mgr as any).actualModuleConfig.trafficManagement).toEqual({ enabled: true });
  });

  it('does not store a remote response into the local actualModuleConfig', async () => {
    const mgr = makeManager();
    (mgr as any).actualModuleConfig = {};

    decodeAdminMessageMock.mockReturnValue({
      getModuleConfigResponse: { trafficManagement: { enabled: true } },
    });

    // from a different node => remote path
    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from: 999 });

    expect((mgr as any).actualModuleConfig.trafficManagement).toBeUndefined();
    expect((mgr as any).remoteNodeConfigs.get(999)?.moduleConfig.trafficManagement).toEqual({ enabled: true });
  });

  it('requestModuleConfig tracks the pending key for the local node', async () => {
    const mgr = makeManager();
    (mgr as any).isConnected = true;
    (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };

    await (mgr as any).requestModuleConfig(14); // TRAFFICMANAGEMENT_CONFIG

    expect((mgr as any).pendingModuleConfigRequests.get(LOCAL_NODE_NUM)).toBe('trafficManagement');
  });
});
