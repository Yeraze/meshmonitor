import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the VirtualNodeServer so tests never bind a real TCP port
const { startMock, stopMock, broadcastMock, VNConstructor } = vi.hoisted(() => {
  const startMock = vi.fn().mockResolvedValue(undefined);
  const stopMock = vi.fn().mockResolvedValue(undefined);
  const broadcastMock = vi.fn().mockResolvedValue(undefined);
  const VNConstructor = vi.fn(function (this: any, _opts: any) {
    this.start = startMock;
    this.stop = stopMock;
    this.broadcastToClients = broadcastMock;
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  });
  return { startMock, stopMock, broadcastMock, VNConstructor };
});
vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: VNConstructor,
}));

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
vi.mock('../services/database.js', () => ({
  default: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
  },
  databaseService: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: {
      getSource: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { MeshtasticManager } from './meshtasticManager.js';

describe('MeshtasticManager — Virtual Node wiring', () => {
  beforeEach(() => {
    VNConstructor.mockClear();
    startMock.mockClear();
    stopMock.mockClear();
  });

  it('does not create a VirtualNodeServer when virtualNode is absent', () => {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
    expect(VNConstructor).not.toHaveBeenCalled();
    expect((mgr as any).virtualNodeServer).toBeUndefined();
  });

  it('creates a VirtualNodeServer when virtualNode.enabled is true', () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    expect(VNConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4503, allowAdminCommands: false })
    );
    expect((mgr as any).virtualNodeServer).toBeDefined();
  });

  it('does not create a VirtualNodeServer when virtualNode.enabled is false', () => {
    new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: false, port: 4503, allowAdminCommands: false },
    });
    expect(VNConstructor).not.toHaveBeenCalled();
  });

  it('reconfigureVirtualNode(config) stops the old server and starts a new one', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    VNConstructor.mockClear();
    stopMock.mockClear();

    await mgr.reconfigureVirtualNode({ enabled: true, port: 4504, allowAdminCommands: true });

    expect(stopMock).toHaveBeenCalled();
    expect(VNConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4504, allowAdminCommands: true })
    );
  });

  it('reconfigureVirtualNode(undefined) stops and clears the server', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    stopMock.mockClear();

    await mgr.reconfigureVirtualNode(undefined);

    expect(stopMock).toHaveBeenCalled();
    expect((mgr as any).virtualNodeServer).toBeUndefined();
  });
});
