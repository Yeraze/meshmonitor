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
const { getNodeMock } = vi.hoisted(() => ({
  getNodeMock: vi.fn().mockResolvedValue({
    nodeNum: 123,
    nodeId: '!0000007b',
    longName: 'Test Node',
    shortName: 'TN',
    hwModel: 1,
  }),
}));
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
      getNode: getNodeMock,
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

// Mock the protobuf service so we can assert on encoded outputs without
// touching the real protobuf root.
const { createNodeInfoMock, createFromRadioWithPacketMock } = vi.hoisted(() => ({
  createNodeInfoMock: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  createFromRadioWithPacketMock: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
}));
vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: createNodeInfoMock,
    createFromRadioWithPacket: createFromRadioWithPacketMock,
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

// Stub packet-log service so processMeshPacket's logging branch stays quiet
vi.mock('./services/packetLogService.js', () => {
  const svc = { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() };
  return { default: svc, packetLogService: svc };
});
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
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

  it('broadcastNodeInfoUpdate broadcasts when VN is enabled', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    broadcastMock.mockClear();
    createNodeInfoMock.mockClear();

    await mgr.broadcastNodeInfoUpdate(123);

    expect(createNodeInfoMock).toHaveBeenCalled();
    expect(broadcastMock).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('broadcastNodeInfoUpdate is a no-op when VN is disabled', async () => {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
    broadcastMock.mockClear();
    createNodeInfoMock.mockClear();

    await mgr.broadcastNodeInfoUpdate(123);

    expect(createNodeInfoMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  // Regression test for #2776: processMeshPacket MUST NOT broadcast to VN clients.
  // processIncomingData already broadcasts the raw FromRadio bytes upstream.
  // A second broadcast here caused every inbound meshPacket to be duplicated to
  // clients like the Meshtastic Android app (and echoed VN-originated packets).
  it('processMeshPacket does not broadcast (broadcast happens in processIncomingData)', async () => {
    const mgr = new MeshtasticManager('src-1', {
      host: '127.0.0.1',
      port: 4403,
      virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
    });
    broadcastMock.mockClear();
    createFromRadioWithPacketMock.mockClear();

    const pkt = { id: 1, from: 2, to: 0xffffffff, channel: 0, decoded: { portnum: 1, payload: new Uint8Array() } };
    await (mgr as any).processMeshPacket(pkt);

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(createFromRadioWithPacketMock).not.toHaveBeenCalled();
  });

  it('processMeshPacket does not throw when VN is disabled', async () => {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
    broadcastMock.mockClear();
    createFromRadioWithPacketMock.mockClear();

    const pkt = { id: 1, from: 2, to: 0xffffffff, channel: 0, decoded: { portnum: 1, payload: new Uint8Array() } };
    await expect((mgr as any).processMeshPacket(pkt)).resolves.toBeUndefined();
    expect(broadcastMock).not.toHaveBeenCalled();
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
