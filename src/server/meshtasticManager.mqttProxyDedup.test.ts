/**
 * Tests for issue #4037 follow-up — duplicate MQTT client-proxy publishing.
 *
 * When a device has mqtt.proxy_to_client_enabled, it emits
 * FromRadio.mqttClientProxyMessage frames asking its client to publish them
 * to the MQTT broker. Two consumers can act on the SAME frame:
 *
 *   1. handleDeviceMqttProxyMessage() publishes to the linked embedded broker
 *      when the source has an active mqttLink (mqttLinkBroker non-null).
 *   2. _processIncomingDataImpl broadcasts every FromRadio frame to ALL
 *      virtual-node clients, and each connected Meshtastic app then runs its
 *      own broker connection and publishes the same envelope again.
 *
 * The fix: when the mqttLink is active, the proxy frame must NOT reach VN
 * clients at all (MeshMonitor is the proxy). When it is not active, the frame
 * goes to exactly ONE delegate client via broadcastToProxyDelegate (a
 * physical node never double-publishes because BLE is single-client).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the VirtualNodeServer so tests never bind a real TCP port
const { broadcastMock, proxyDelegateMock, VNConstructor } = vi.hoisted(() => {
  const startMock = vi.fn().mockResolvedValue(undefined);
  const stopMock = vi.fn().mockResolvedValue(undefined);
  const broadcastMock = vi.fn().mockResolvedValue(undefined);
  const proxyDelegateMock = vi.fn().mockResolvedValue(undefined);
  const VNConstructor = vi.fn(function (this: any, _opts: any) {
    this.start = startMock;
    this.stop = stopMock;
    this.broadcastToClients = broadcastMock;
    this.broadcastToProxyDelegate = proxyDelegateMock;
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  });
  return { broadcastMock, proxyDelegateMock, VNConstructor };
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

// Mock the protobuf service so we control what parseIncomingData reports
const { parseIncomingDataMock } = vi.hoisted(() => ({
  parseIncomingDataMock: vi.fn(),
}));
vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    parseIncomingData: parseIncomingDataMock,
    // peekServiceEnvelopePacketId (mqttProxyBridge) probes the payload for a
    // packet id; returning null makes echo suppression a quiet no-op.
    decodeServiceEnvelope: vi.fn().mockReturnValue(null),
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
  return new MeshtasticManager('src-1', {
    host: '127.0.0.1',
    port: 4403,
    virtualNode: { enabled: true, port: 4503, allowAdminCommands: false },
  });
}

function proxyParsed() {
  return {
    type: 'mqttClientProxyMessage',
    data: {
      topic: 'msh/US/2/e/LongFast/!abcdef01',
      data: new Uint8Array([9, 9, 9]),
      retained: false,
    },
  };
}

describe('MeshtasticManager — mqttClientProxyMessage VN dedup (#4037 follow-up)', () => {
  beforeEach(() => {
    broadcastMock.mockClear();
    proxyDelegateMock.mockClear();
    parseIncomingDataMock.mockReset();
  });

  it('with mqttLink active: no VN client receives the frame, and the link handler publishes it', async () => {
    const mgr = makeManager();
    const publishMock = vi.fn().mockResolvedValue(undefined);
    (mgr as any).mqttLinkBroker = { publish: publishMock };
    parseIncomingDataMock.mockReturnValue(proxyParsed());

    await mgr.processIncomingData(RAW_FRAME);

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(proxyDelegateMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      'msh/US/2/e/LongFast/!abcdef01',
      expect.any(Buffer),
      false,
    );
  });

  it('with NO mqttLink: exactly one delegate client receives the frame (not broadcast-to-all)', async () => {
    const mgr = makeManager();
    parseIncomingDataMock.mockReturnValue(proxyParsed());

    await mgr.processIncomingData(RAW_FRAME);

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(proxyDelegateMock).toHaveBeenCalledTimes(1);
    expect(proxyDelegateMock).toHaveBeenCalledWith(RAW_FRAME);
  });

  it('regression: a non-proxy frame (nodeInfo) still reaches ALL clients via broadcastToClients', async () => {
    const mgr = makeManager();
    // Stub the dispatch target so the test stays off the DB path.
    (mgr as any).processNodeInfoProtobuf = vi.fn().mockResolvedValue(undefined);
    parseIncomingDataMock.mockReturnValue({ type: 'nodeInfo', data: { num: 123 } });

    await mgr.processIncomingData(RAW_FRAME);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(RAW_FRAME);
    expect(proxyDelegateMock).not.toHaveBeenCalled();
  });

  it('regression: channel and configComplete frames stay filtered from every VN path (#1567)', async () => {
    const mgr = makeManager();
    parseIncomingDataMock.mockReturnValue({ type: 'channel', data: { index: 0 } });

    await mgr.processIncomingData(RAW_FRAME);

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(proxyDelegateMock).not.toHaveBeenCalled();
  });
});
