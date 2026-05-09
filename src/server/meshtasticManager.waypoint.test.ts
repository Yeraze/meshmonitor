import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be set up before MeshtasticManager is imported
// ---------------------------------------------------------------------------

const { transportSendMock, vnBroadcastMock } = vi.hoisted(() => ({
  transportSendMock: vi.fn().mockResolvedValue(undefined),
  vnBroadcastMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: vi.fn(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.broadcastToClients = vnBroadcastMock;
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  }),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = transportSendMock;
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    waypoints: {
      upsertAsync: vi.fn(),
      getAsync: vi.fn(),
      deleteAsync: vi.fn(),
      listAsync: vi.fn(),
      getExistingIdsAsync: vi.fn(),
      sweepExpiredAsync: vi.fn(),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

const { createWaypointMock } = vi.hoisted(() => ({
  createWaypointMock: vi.fn().mockReturnValue({
    data: new Uint8Array([0xab, 0xcd, 0xef]),
    packetId: 12345,
  }),
}));

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createWaypointMessage: createWaypointMock,
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array([1])),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array([2])),
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

const { upsertFromMeshMock } = vi.hoisted(() => ({
  upsertFromMeshMock: vi.fn().mockResolvedValue({ sourceId: 'src-1', waypointId: 1 }),
}));
vi.mock('./services/waypointService.js', () => ({
  waypointService: { upsertFromMesh: upsertFromMeshMock },
}));

vi.mock('./services/packetLogService.js', () => {
  const svc = { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() };
  return { default: svc, packetLogService: svc };
});
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));

import { MeshtasticManager } from './meshtasticManager.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MeshtasticManager — Waypoint wiring', () => {
  beforeEach(() => {
    transportSendMock.mockClear();
    vnBroadcastMock.mockClear();
    createWaypointMock.mockClear();
    upsertFromMeshMock.mockClear();
  });

  function makeManager(): MeshtasticManager {
    const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
    // Inject the stubbed transport and pretend we're connected.
    (mgr as any).isConnected = true;
    (mgr as any).transport = {
      send: transportSendMock,
      isConnected: () => true,
    };
    (mgr as any).localNodeInfo = { nodeNum: 555, nodeId: '!0000022b' };
    return mgr;
  }

  it('processWaypointMessage forwards decoded packets to waypointService', async () => {
    const mgr = makeManager();
    const meshPacket = { from: BigInt(555) };
    const decoded = {
      id: 99,
      latitude_i: 300000000,
      longitude_i: -900000000,
      expire: 1234,
    };
    await (mgr as any).processWaypointMessage(meshPacket, decoded);

    expect(upsertFromMeshMock).toHaveBeenCalledTimes(1);
    expect(upsertFromMeshMock).toHaveBeenCalledWith('src-1', 555, decoded);
  });

  it('broadcastWaypoint encodes and sends a WAYPOINT_APP packet via the transport', async () => {
    const mgr = makeManager();

    const packetId = await mgr.broadcastWaypoint({
      id: 42,
      latitude: 30,
      longitude: -90,
      expire: 1234567890,
      name: 'Camp',
    });

    expect(packetId).toBe(12345);
    expect(createWaypointMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, latitude: 30, longitude: -90, expire: 1234567890 }),
      expect.any(Object),
    );
    expect(transportSendMock).toHaveBeenCalledTimes(1);
    expect(transportSendMock.mock.calls[0]?.[0]).toEqual(new Uint8Array([0xab, 0xcd, 0xef]));
  });

  it('broadcastWaypointDelete sends an expire=1 tombstone for the given id', async () => {
    const mgr = makeManager();

    await mgr.broadcastWaypointDelete(7);

    const args = createWaypointMock.mock.calls[0]?.[0];
    expect(args).toEqual(expect.objectContaining({ id: 7, expire: 1 }));
  });

  it('broadcastWaypoint returns 0 when the manager is not connected', async () => {
    const mgr = makeManager();
    (mgr as any).isConnected = false;

    const packetId = await mgr.broadcastWaypoint({
      id: 1,
      latitude: 0,
      longitude: 0,
      expire: 100,
    });

    expect(packetId).toBe(0);
    expect(transportSendMock).not.toHaveBeenCalled();
  });
});
