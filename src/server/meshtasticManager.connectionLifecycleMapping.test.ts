/**
 * Real-lifecycle mapping tests for the connection state machine (#3962 Phase
 * 4.2b C3, task42b_spec.md §1.2 "real-lifecycle driving" technique).
 *
 * connectionStateMachine.test.ts pins the pure reducer's transition table
 * with zero mocks. This file drives the REAL manager methods
 * (connect/doConnectInternal/handleConnected/handleDisconnected/
 * userDisconnect/userReconnect) exactly the way connectRace.test.ts and
 * orphanTransport.test.ts do — `import { fallbackManager }`, mock the DB/
 * notification/event-emitter modules, seed per-test state, then await the
 * real method — and asserts each NAMED transition produces the right
 * observable effect (the derived booleans, mock calls, and timer behavior),
 * not just the right internal `#state` (which is a true JS private field and
 * can't be read from a test even via `as any`).
 *
 * Scope: transitions/behaviors NOT already exhaustively pinned by the
 * existing connectRace/orphanTransport/passiveMode/manualResync/
 * announceLifecycle files — the CONNECT_REQUESTED->Probing->PROBE_DONE path,
 * the handleDisconnected-after-userDisconnect() non-regression guard added
 * in C2, and the promoted fallback-timer leak fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockNotifyNodeConnected = vi.fn().mockResolvedValue(undefined);
const mockNotifyNodeDisconnected = vi.fn().mockResolvedValue(undefined);
const mockEmitConnectionStatus = vi.fn();

// Track every TcpTransport the manager constructs (orphanTransport.test.ts's
// technique) so the Probing/PROBE_DONE test can assert on the transport
// instance the manager actually used.
const createdTransports: any[] = [];
const makeFakeTransport = () => ({
  setStaleConnectionTimeout: vi.fn(),
  setConnectTimeout: vi.fn(),
  setReconnectTiming: vi.fn(),
  setStartupGraceReconnect: vi.fn(),
  setHeartbeatInterval: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
});

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: vi.fn(),
    settings: {
      getSetting: mockGetSetting,
      setSetting: vi.fn(),
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn(),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getNodeCount: vi.fn().mockResolvedValue(0),
    },
    channels: {
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: vi.fn().mockResolvedValue(undefined),
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
    telemetry: { insertTelemetryBatch: vi.fn().mockResolvedValue(0) },
    messages: { getMessages: vi.fn().mockResolvedValue([]) },
    neighbors: { deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0) },
    sources: {
      getSource: vi.fn().mockResolvedValue({ id: 'default', name: 'test', type: 'meshtastic' }),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn().mockResolvedValue(undefined),
    createWantConfigRequest: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: { encode: vi.fn(), decode: vi.fn() },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({ getProtobufRoot: vi.fn() }));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: vi.fn(function () {
    const t = makeFakeTransport();
    createdTransports.push(t);
    return t;
  }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: mockNotifyNodeConnected,
    notifyNodeDisconnected: mockNotifyNodeDisconnected,
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emit: vi.fn(), emitConnectionStatus: mockEmitConnectionStatus, on: vi.fn() },
}));

vi.mock('./services/packetLogService.js', () => ({ default: { logPacket: vi.fn() } }));
vi.mock('./services/channelDecryptionService.js', () => ({ channelDecryptionService: { tryDecrypt: vi.fn() } }));
vi.mock('./services/notificationService.js', () => ({ notificationService: { checkAndSendNotifications: vi.fn() } }));

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    handleAck: vi.fn(),
    handleFailure: vi.fn(),
    recordExternalSend: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    meshtasticNodeIp: '127.0.0.1',
    meshtasticTcpPort: 4403,
    meshtasticStaleConnectionTimeout: 300000,
    meshtasticConnectTimeoutMs: 10000,
    meshtasticReconnectInitialDelayMs: 1000,
    meshtasticReconnectMaxDelayMs: 60000,
  })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({ normalizeTriggerPatterns: vi.fn() }));
vi.mock('../utils/nodeHelpers.js', () => ({ isNodeComplete: vi.fn() }));

describe('MeshtasticManager — connection-lifecycle SM mapping (#3962 Phase 4.2b C3)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    createdTransports.length = 0;
    mockGetAllChannelsSafe();

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;

    manager.sourceConfigOverride = { host: '127.0.0.1', port: 4403 };
    manager.isConnected = false;
    manager.userDisconnectedState = false;
    manager.transport = null;
    manager.passiveMode = false;
    manager.suppressNextAutoSync = false;
    manager.postResetCooldownUntil = 0;
    manager.localNodeInfo = null;
    manager.actualDeviceConfig = null;
    manager.actualModuleConfig = null;
    manager.lastDisconnectAt = null;
    manager.preConfigChannelSnapshot = [];
    manager.initConfigCache = [];
    manager.configCaptureComplete = false;
    manager.isCapturingInitConfig = false;
    manager.deviceNodeNums = new Set();
    manager.manualResyncInFlight = false;
    manager.manualResyncLastAt = null;
    manager.favoritesSupportCache = null;
  });

  function mockGetAllChannelsSafe() {
    // vi.clearAllMocks() above clears implementations too — restore the ones
    // these tests rely on.
    mockGetSetting.mockImplementation(() => null);
  }

  describe('CONNECT_REQUESTED -> Probing -> PROBE_DONE (postResetCooldownUntil)', () => {
    it('waits out the cooldown, probes TCP readiness, clears the cooldown, then connects the transport', async () => {
      manager.postResetCooldownUntil = Date.now() - 5; // already expired — no real wait
      manager.waitForTcpReady = vi.fn().mockResolvedValue(undefined);

      const ok = await manager.connect();

      expect(ok).toBe(true);
      expect(manager.waitForTcpReady).toHaveBeenCalledWith('127.0.0.1', 4403);
      // PROBE_DONE cleared the cooldown latch.
      expect(manager.postResetCooldownUntil).toBe(0);
      // ...and proceeded to the actual transport connect.
      expect(createdTransports.length).toBe(1);
      expect(createdTransports[0].connect).toHaveBeenCalledWith('127.0.0.1', 4403);
    });

    it('skips the probe entirely on a normal (non-cooldown) connect', async () => {
      manager.postResetCooldownUntil = 0;
      manager.waitForTcpReady = vi.fn().mockResolvedValue(undefined);

      await manager.connect();

      expect(manager.waitForTcpReady).not.toHaveBeenCalled();
      expect(createdTransports[0].connect).toHaveBeenCalled();
    });
  });

  describe('TRANSPORT_CONNECTED — full handshake (cold connect)', () => {
    it('enters ConfigSync-equivalent state: capture flags set, want_config_id sent, localNodeInfo cleared', async () => {
      const mockTransport = makeFakeTransport();
      manager.transport = mockTransport;
      manager.localNodeInfo = { nodeNum: 1, nodeId: '!00000001' };

      await manager.handleConnected();

      expect(manager.isConnected).toBe(true);
      expect(manager.isCapturingInitConfig).toBe(true);
      expect(manager.configCaptureComplete).toBe(false);
      expect(manager.localNodeInfo).toBeNull();
      expect(mockTransport.send).toHaveBeenCalled();
      expect(mockEmitConnectionStatus).toHaveBeenCalledWith(
        expect.objectContaining({ connected: true }),
        expect.anything()
      );
    });
  });

  describe('TRANSPORT_CONNECTED — skip via passive+fresh cache', () => {
    it('marks capture complete immediately without sending want_config_id, keeps localNodeInfo', async () => {
      const mockTransport = makeFakeTransport();
      manager.transport = mockTransport;
      manager.passiveMode = true;
      manager.localNodeInfo = { nodeNum: 1, nodeId: '!00000001' };
      manager.actualDeviceConfig = { device: {} };
      manager.lastDisconnectAt = Date.now() - 1000; // well within the 4h window

      await manager.handleConnected();

      expect(manager.isConnected).toBe(true);
      expect(manager.configCaptureComplete).toBe(true);
      expect(manager.localNodeInfo).not.toBeNull();
      expect(mockTransport.send).not.toHaveBeenCalled();
    });
  });

  describe('TRANSPORT_CONNECTED — skip via manual-resync recovery suppress latch', () => {
    it('consumes the latch, clears manual-resync in-flight, skips want_config_id', async () => {
      const mockTransport = makeFakeTransport();
      manager.transport = mockTransport;
      manager.suppressNextAutoSync = true;
      manager.manualResyncInFlight = true;

      await manager.handleConnected();

      expect(manager.isConnected).toBe(true);
      expect(manager.suppressNextAutoSync).toBe(false);
      expect(manager.manualResyncInFlight).toBe(false);
      expect(manager.configCaptureComplete).toBe(true);
      expect(mockTransport.send).not.toHaveBeenCalled();
    });
  });

  describe('TRANSPORT_DISCONNECTED — after an operator userDisconnect() (non-regression guard, new in C2)', () => {
    it('stays UserDisconnected and does not send a second disconnect notification', async () => {
      const mockTransport = makeFakeTransport();
      manager.transport = mockTransport;

      await manager.userDisconnect();
      expect(manager.isUserDisconnected()).toBe(true);
      expect(mockNotifyNodeDisconnected).toHaveBeenCalledTimes(1);

      // The transport's own 'disconnect' event handler fires independently
      // (simulated here directly, as connectRace.test.ts does).
      await manager.handleDisconnected();

      // Still user-disconnected — a transport-level disconnect must not
      // regress UserDisconnected back to auto-reconnecting Disconnected.
      expect(manager.isUserDisconnected()).toBe(true);
      expect(manager.isConnected).toBe(false);
      // userDisconnect() already notified — handleDisconnected() must not
      // have notified a second time.
      expect(mockNotifyNodeDisconnected).toHaveBeenCalledTimes(1);
    });

    it('still clears caches even though state does not regress', async () => {
      manager.localNodeInfo = { nodeNum: 1, nodeId: '!00000001' };
      manager.actualDeviceConfig = { device: {} };
      manager.userDisconnectedState = true; // seed directly, as other pin tests do

      await manager.handleDisconnected();

      expect(manager.localNodeInfo).toBeNull();
      expect(manager.actualDeviceConfig).toBeNull();
      expect(manager.isUserDisconnected()).toBe(true);
    });
  });

  describe('USER_RECONNECT', () => {
    it('clears the user-disconnected flag and reconnects', async () => {
      manager.userDisconnectedState = true;
      manager.transport = null;

      const ok = await manager.userReconnect();

      expect(ok).toBe(true);
      expect(manager.isUserDisconnected()).toBe(false);
      expect(createdTransports.length).toBe(1);
    });
  });

  describe('config-complete fallback timer leak fix (#3962 Phase 4.2b C2)', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('does not leak a pending timer across repeated connect -> disconnect cycles', async () => {
      for (let i = 0; i < 3; i++) {
        const mockTransport = makeFakeTransport();
        manager.transport = mockTransport;
        await manager.handleConnected();
        // Mid-handshake (ConfigSync-equivalent) — the fallback timer is armed.
        expect(manager.isCapturingInitConfig).toBe(true);
        manager.disconnect();
      }

      // Every prior fallback timer was cancelled on disconnect — none should
      // still be pending. Advancing well past the fallback window must not
      // throw or re-invoke a stale onConfigCaptureComplete callback bound to
      // a torn-down cycle.
      const timerCountBefore = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(130_000);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timerCountBefore);
      expect(manager.configCaptureComplete).toBe(false);
    });

    it('cancels the fallback timer on a genuine post-connect reset (HANDSHAKE_SEND_FAILED)', async () => {
      const sendError = new Error('Not connected to TCP server');
      const mockTransport = makeFakeTransport();
      mockTransport.send = vi.fn().mockRejectedValue(sendError);
      manager.transport = mockTransport;

      await manager.handleConnected();

      // No pending fallback timer should survive the reset — advancing past
      // the fallback window must not fire a stale callback.
      await vi.advanceTimersByTimeAsync(130_000);
      expect(manager.configCaptureComplete).toBe(false);
      expect(manager.postResetCooldownUntil).toBeGreaterThan(0);
    });
  });
});
