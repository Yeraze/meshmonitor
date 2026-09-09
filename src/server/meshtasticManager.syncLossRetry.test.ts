import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the VirtualNodeServer so tests never bind a real TCP port
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

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createNodeInfo: vi.fn().mockResolvedValue(new Uint8Array()),
    createFromRadioWithPacket: vi.fn().mockResolvedValue(new Uint8Array()),
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
// serverEventNotificationService is invoked from handleDisconnected
vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
    notifyNodeConnected: vi.fn().mockResolvedValue(undefined),
  },
}));


import { MeshtasticManager } from './meshtasticManager.js';

/**
 * Arming the transport's mid-sync fast-retry ramp (#5122).
 *
 * The transport owns the ramp itself (see tcpTransport.syncLossRetry.test.ts);
 * what the manager owns is knowing WHICH disconnects deserve it. That
 * distinction is the whole point: `setConfigSyncActive(false)` fires on a sync
 * that succeeded as well as one that died, so hanging the fast retry off it
 * would shorten the backoff after perfectly healthy sessions too.
 */
describe('MeshtasticManager — arming the mid-sync fast retry (#5122)', () => {
  let mgr: any;
  let transport: {
    noteConfigSyncLoss: ReturnType<typeof vi.fn>;
    resetConfigSyncLossRetries: ReturnType<typeof vi.fn>;
    setConfigSyncActive: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 }) as any;
    transport = {
      noteConfigSyncLoss: vi.fn(),
      resetConfigSyncLossRetries: vi.fn(),
      setConfigSyncActive: vi.fn(),
    };
    mgr.transport = transport;
  });

  it('arms the ramp when the link drops mid-sync', async () => {
    mgr.isCapturingInitConfig = true;
    mgr.configCaptureComplete = false;

    await mgr.handleDisconnected();

    expect(transport.noteConfigSyncLoss).toHaveBeenCalledTimes(1);
  });

  it('leaves the backoff alone for a disconnect outside the sync', async () => {
    // The control that keeps a powered-off node on the ordinary 60s backoff
    // instead of collecting a SYN every three seconds at every startup.
    mgr.isCapturingInitConfig = false;
    mgr.configCaptureComplete = true;

    await mgr.handleDisconnected();

    expect(transport.noteConfigSyncLoss).not.toHaveBeenCalled();
  });

  it('resets the ramp when a sync completes', () => {
    mgr.completeConfigCapture();

    expect(transport.resetConfigSyncLossRetries).toHaveBeenCalledTimes(1);
  });

  it('does not reset the ramp when the capture is merely cleared', () => {
    // `clearConfigCapture` runs on teardown paths where no sync finished.
    // Resetting there would hand a failing source a fresh 3s rung every cycle.
    mgr.clearConfigCapture();

    expect(transport.resetConfigSyncLossRetries).not.toHaveBeenCalled();
  });

  it('survives a transport that implements neither hook', async () => {
    // Both are optional on ITransport — a MeshCore/MQTT manager or a test
    // double must not throw its way out of the disconnect path.
    mgr.transport = { setConfigSyncActive: vi.fn() };
    mgr.isCapturingInitConfig = true;
    mgr.configCaptureComplete = false;

    await expect(mgr.handleDisconnected()).resolves.not.toThrow();
    expect(() => mgr.completeConfigCapture()).not.toThrow();
  });
});
