/**
 * sendTraceroute sizes the request to the local node's own hop limit, the way
 * admin packets and the Meshtastic CLI do, instead of a fixed 7.
 *
 * Mocks mirror meshtasticManager.txDisabled.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { VNConstructor } = vi.hoisted(() => ({
  VNConstructor: vi.fn(function (this: any, _opts: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.broadcastToClients = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  }),
}));
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

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: vi.fn().mockResolvedValue(null),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    messages: {
      insertMessage: vi.fn().mockResolvedValue(true),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array()),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array()),
    createTextMessage: vi.fn(() => ({ data: new Uint8Array([1, 2, 3]), messageId: 12345 })),
    createTracerouteMessage: vi.fn(() => new Uint8Array([9, 9])),
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});
vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
  packetLogService: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));
vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
    notifyNodeConnected: vi.fn().mockResolvedValue(undefined),
  },
}));

import { MeshtasticManager } from './meshtasticManager.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { DEFAULT_HOP_LIMIT } from './constants/meshtastic.js';

const createTracerouteMessage = meshtasticProtobufService.createTracerouteMessage as unknown as ReturnType<typeof vi.fn>;

function makeReadyManager(lora?: Record<string, unknown>): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined) };
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = { nodeNum: 0x0badbeef, nodeId: '!0badbeef', longName: 'Local', shortName: 'LOCL' };
  if (lora) (mgr as any).actualDeviceConfig = { lora };
  return mgr;
}

describe('MeshtasticManager.sendTraceroute hop limit', () => {
  beforeEach(() => createTracerouteMessage.mockClear());

  it("uses the node's configured hop limit", async () => {
    await makeReadyManager({ hopLimit: 5 }).sendTraceroute(0x11111111, 2).catch(() => undefined);
    expect(createTracerouteMessage).toHaveBeenCalledWith(0x11111111, 2, 5);
  });

  it('uses the firmware default before the LoRa config has arrived', async () => {
    await makeReadyManager().sendTraceroute(0x11111111, 0).catch(() => undefined);
    expect(createTracerouteMessage).toHaveBeenCalledWith(0x11111111, 0, DEFAULT_HOP_LIMIT);
  });
});
