/**
 * Regression tests for issue #6161 — MeshMonitor's own want_config_id burst
 * must NOT be relayed to virtual node clients.
 *
 * When MeshMonitor refreshes the node DB (hourly, on reconnect, or on a manual
 * resync) it sends its own want_config_id to the physical node. The answer is a
 * config burst (my_info, metadata, config, moduleConfig, node_info) that virtual
 * node clients (e.g. the Meshtastic Android app) never asked for. 'channel' and
 * 'configComplete' were already filtered, so apps saw a config that started with
 * no channels and never finished, and dropped their channel names.
 *
 * The fix: sendWantConfigId() arms a suppression window
 * (VN_CONFIG_RELAY_SUPPRESS_MS, 120s), during which the burst FromRadio types are
 * not relayed to VN clients. A 'configComplete' clears the window immediately;
 * the deadline bounds it if no configComplete ever arrives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the VirtualNodeServer so tests never bind a real TCP port
const { broadcastMock, VNConstructor } = vi.hoisted(() => {
  const startMock = vi.fn().mockResolvedValue(undefined);
  const stopMock = vi.fn().mockResolvedValue(undefined);
  const broadcastMock = vi.fn().mockResolvedValue(undefined);
  const VNConstructor = vi.fn(function (this: any, _opts: any) {
    this.start = startMock;
    this.stop = stopMock;
    this.broadcastToClients = broadcastMock;
    this.broadcastToProxyDelegate = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  });
  return { broadcastMock, VNConstructor };
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
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
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

// Mock the protobuf service so we control what parseIncomingData reports and so
// sendWantConfigId() can encode a request without the real protobuf root.
const { parseIncomingDataMock, createWantConfigRequestMock } = vi.hoisted(() => ({
  parseIncomingDataMock: vi.fn(),
  createWantConfigRequestMock: vi.fn().mockReturnValue(new Uint8Array([7, 7, 7])),
}));
vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    parseIncomingData: parseIncomingDataMock,
    createWantConfigRequest: createWantConfigRequestMock,
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
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

const RAW_FRAME = new Uint8Array([0x12, 0x34, 0x56]);

function makeManager(): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', {
    host: '127.0.0.1',
    port: 4403,
    virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
  });
  // sendWantConfigId() throws without a transport; give it a harmless stub.
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  // Keep the burst dispatch handlers off the DB — the suppression decision runs
  // before the switch, so stubs here only keep the handlers from touching mocks.
  (mgr as any).processNodeInfoProtobuf = vi.fn().mockResolvedValue(undefined);
  (mgr as any).processMyNodeInfo = vi.fn().mockResolvedValue(undefined);
  (mgr as any).processDeviceMetadata = vi.fn().mockResolvedValue(undefined);
  return mgr;
}

// Each burst type and a minimal `data` payload its dispatch handler accepts.
const BURST_FRAMES: Array<{ type: string; data: any }> = [
  { type: 'myInfo', data: { myNodeNum: 123 } },
  { type: 'metadata', data: {} },
  { type: 'config', data: {} },
  { type: 'moduleConfig', data: {} },
  { type: 'nodeInfo', data: { num: 123 } },
];

describe('MeshtasticManager — want_config_id burst VN suppression (#6161)', () => {
  beforeEach(() => {
    broadcastMock.mockClear();
    parseIncomingDataMock.mockReset();
    createWantConfigRequestMock.mockClear();
  });

  for (const frame of BURST_FRAMES) {
    it(`after sendWantConfigId(): a '${frame.type}' frame is NOT relayed to VN clients`, async () => {
      const mgr = makeManager();
      await mgr.sendWantConfigId();

      parseIncomingDataMock.mockReturnValue(frame);
      await mgr.processIncomingData(RAW_FRAME);

      expect(broadcastMock).not.toHaveBeenCalled();
    });
  }

  it('without a pending want_config_id, a nodeInfo frame IS relayed to VN clients', async () => {
    const mgr = makeManager();
    parseIncomingDataMock.mockReturnValue({ type: 'nodeInfo', data: { num: 123 } });

    await mgr.processIncomingData(RAW_FRAME);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(RAW_FRAME);
  });

  it('configComplete clears the window: a nodeInfo after it IS relayed again', async () => {
    const mgr = makeManager();
    await mgr.sendWantConfigId();

    // During the window the burst is dropped...
    parseIncomingDataMock.mockReturnValue({ type: 'nodeInfo', data: { num: 123 } });
    await mgr.processIncomingData(RAW_FRAME);
    expect(broadcastMock).not.toHaveBeenCalled();

    // ...configComplete itself is never relayed (filtered pre-existing), but it
    // clears the suppression window.
    parseIncomingDataMock.mockReturnValue({ type: 'configComplete', data: { configCompleteId: 0 } });
    await mgr.processIncomingData(RAW_FRAME);
    expect(broadcastMock).not.toHaveBeenCalled();

    // A nodeInfo after configComplete is relayed again.
    parseIncomingDataMock.mockReturnValue({ type: 'nodeInfo', data: { num: 123 } });
    await mgr.processIncomingData(RAW_FRAME);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(RAW_FRAME);
  });

  it('the window is bounded: once the deadline passes, relaying resumes without a configComplete', async () => {
    const mgr = makeManager();
    await mgr.sendWantConfigId();

    // Simulate the 120s deadline elapsing by expiring the private field.
    (mgr as any).vnConfigRelaySuppressedUntil = Date.now() - 1;

    parseIncomingDataMock.mockReturnValue({ type: 'nodeInfo', data: { num: 123 } });
    await mgr.processIncomingData(RAW_FRAME);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(RAW_FRAME);
  });
});
