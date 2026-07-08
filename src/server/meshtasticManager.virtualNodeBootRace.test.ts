/**
 * Regression test for issue #4000 — Virtual Node Server never starts if the
 * source's initial connect fails (boot race).
 *
 * Prior to the fix, `start()` awaited `connect()` unguarded: a rejected
 * initial connect (e.g. ECONNREFUSED while a companion container is still
 * booting) unwound `start()` before `virtualNodeServer.start()` ever ran.
 * The transport's own background reconnect brought the source back, but
 * nothing re-ran the VN-start sequence, leaving the VN permanently
 * "Running: No" until a manual disable/enable.
 *
 * `start()` must now start the VirtualNodeServer regardless of whether the
 * initial `connect()` succeeds or throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { startMock, stopMock, VNConstructor } = vi.hoisted(() => {
  const startMock = vi.fn().mockResolvedValue(undefined);
  const stopMock = vi.fn().mockResolvedValue(undefined);
  const VNConstructor = vi.fn(function (this: any, _opts: any) {
    this.start = startMock;
    this.stop = stopMock;
    this.broadcastToClients = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  });
  return { startMock, stopMock, VNConstructor };
});
vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: VNConstructor,
}));

// The transport's connect() rejects to simulate a boot-race ECONNREFUSED.
const { transportConnectMock } = vi.hoisted(() => ({
  transportConnectMock: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 172.x.0.2:4403')),
}));
vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = transportConnectMock;
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    removeAllListeners = vi.fn();
    isConnected = () => false;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
    setHeartbeatInterval = vi.fn();
    setStartupGraceReconnect = vi.fn();
  },
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
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
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./services/packetLogService.js', () => {
  const svc = { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() };
  return { default: svc, packetLogService: svc };
});
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));

import { MeshtasticManager } from './meshtasticManager.js';

describe('MeshtasticManager.start() — issue #4000 boot race', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
    startMock.mockClear();
    stopMock.mockClear();
    transportConnectMock.mockClear();
  });

  it('still starts the VirtualNodeServer when the initial connect() rejects', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });

    // start() must not throw even though connect() rejects — the caller
    // (sourceManagerRegistry.addManager) treats a thrown start() as a
    // failed-to-start source and never emits 'manager-started'.
    await expect(mgr.start()).resolves.toBeUndefined();

    expect(transportConnectMock).toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('still starts the VirtualNodeServer when the initial connect() succeeds', async () => {
    transportConnectMock.mockResolvedValueOnce(undefined);
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });

    await expect(mgr.start()).resolves.toBeUndefined();

    expect(startMock).toHaveBeenCalledTimes(1);
  });
});
