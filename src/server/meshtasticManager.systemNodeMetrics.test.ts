/**
 * `saveSystemNodeMetrics()` — the systemNodeCount / systemDirectNodeCount
 * telemetry rows (#5376).
 *
 * With maxNodeAgeHours = 0 ("unlimited", #4947) this used to call
 * getActiveNodes(0), whose cutoff is `now`, so the graphed node count dropped
 * to 0. It now counts every heard node, the same set the Nodes list shows.
 *
 * The mock set mirrors `meshtasticManager.adminHopLimit.test.ts` — enough to
 * construct a manager without touching a socket, a DB, or a real TCP port.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { VNConstructor, getActiveNodesMock, getHeardNodesMock, getSettingForSourceMock, insertTelemetryMock } =
  vi.hoisted(() => ({
    VNConstructor: vi.fn(function (this: any, _opts: any) {
      this.start = vi.fn().mockResolvedValue(undefined);
      this.stop = vi.fn().mockResolvedValue(undefined);
      this.broadcastToClients = vi.fn().mockResolvedValue(undefined);
      this.isRunning = () => true;
      this.getClientCount = () => 0;
    }),
    getActiveNodesMock: vi.fn(),
    getHeardNodesMock: vi.fn(),
    getSettingForSourceMock: vi.fn(),
    insertTelemetryMock: vi.fn(),
  }));

vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: VNConstructor,
}));

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
      getSettingForSource: getSettingForSourceMock,
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: getActiveNodesMock,
      getHeardNodes: getHeardNodesMock,
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    messages: { insertMessage: vi.fn().mockResolvedValue(true) },
    insertTelemetryAsync: insertTelemetryMock,
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

const nowSec = () => Math.floor(Date.now() / 1000);
const NODES = [
  { nodeNum: 1, hopsAway: 0, lastHeard: nowSec() },
  { nodeNum: 2, hopsAway: 2, lastHeard: nowSec() - 90 * 24 * 3600 },
];

function makeManager(): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = { nodeId: '!00000abc', nodeNum: 0xabc };
  return mgr;
}

function savedCount(type: string): number | undefined {
  const call = insertTelemetryMock.mock.calls.find(([row]) => row.telemetryType === type);
  return call?.[0].value;
}

describe('MeshtasticManager.saveSystemNodeMetrics()', () => {
  beforeEach(() => {
    getActiveNodesMock.mockReset().mockResolvedValue([]);
    getHeardNodesMock.mockReset().mockResolvedValue(NODES);
    getSettingForSourceMock.mockReset();
    insertTelemetryMock.mockReset().mockResolvedValue(undefined);
  });

  it('bounds the count by the node window when maxNodeAgeHours > 0', async () => {
    getSettingForSourceMock.mockResolvedValue('48');
    getActiveNodesMock.mockResolvedValue([NODES[0]]);

    await (makeManager() as any).saveSystemNodeMetrics();

    expect(getActiveNodesMock).toHaveBeenCalledWith(2, 'src-1');
    expect(getHeardNodesMock).not.toHaveBeenCalled();
    expect(savedCount('systemNodeCount')).toBe(1);
  });

  it('counts every heard node when maxNodeAgeHours is 0 ("unlimited")', async () => {
    getSettingForSourceMock.mockResolvedValue('0');

    await (makeManager() as any).saveSystemNodeMetrics();

    // Before #5376: getActiveNodes(0) → cutoff = now → a count of 0.
    expect(getActiveNodesMock).not.toHaveBeenCalled();
    expect(getHeardNodesMock).toHaveBeenCalledWith('src-1');
    expect(savedCount('systemNodeCount')).toBe(2);
    expect(savedCount('systemDirectNodeCount')).toBe(1);
  });
});
