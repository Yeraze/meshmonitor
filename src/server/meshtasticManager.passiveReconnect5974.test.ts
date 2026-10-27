import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockParseIncomingData = vi.fn();
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
    parseIncomingData: mockParseIncomingData,
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

const managerModule = await import('./meshtasticManager.js');
const protobufModule: any = await import('./meshtasticProtobufService.js');
const { logger } = await import('../utils/logger.js');
const { WANT_CONFIG_NONCE_FULL, WANT_CONFIG_NONCE_ONLY_CONFIG } = await import('./constants/meshtastic.js');

const createWantConfigRequest = protobufModule.default.createWantConfigRequest as ReturnType<typeof vi.fn>;
const lastNonce = () => createWantConfigRequest.mock.calls.at(-1)?.[0];
const flush = () => new Promise((r) => setImmediate(r));

/** Feed one FromRadio config_complete_id through the real dispatch path. */
async function deliverConfigComplete(manager: any, id: number) {
  mockParseIncomingData.mockReturnValueOnce({ type: 'configComplete', data: { configCompleteId: id } });
  await manager.processIncomingData(new Uint8Array([1]));
}

/**
 * #5974 — Passive Mode reconnects and TCP-slot diagnostics.
 *
 * 1. The passive skip needs a FULL sync that finished (config_complete_id for
 *    our full want_config_id). A sync the node cut off part way still fills
 *    actualDeviceConfig, which used to be enough to arm the skip.
 * 2. When the skip applies, the manager asks for config only (69420) instead
 *    of sending nothing: the firmware sends a TCP client no packets until it
 *    asks with want_config_id.
 * 3. The config-only config_complete_id is not a sync.
 * 4. Repeated quick closes log one rate-limited warning.
 */
describe('MeshtasticManager — passive reconnect + TCP slot diagnostics (#5974)', () => {
  let manager: any;

  beforeEach(() => {
    vi.clearAllMocks();
    createdTransports.length = 0;
    mockGetSetting.mockImplementation(() => null);

    manager = managerModule.fallbackManager;
    manager.sourceConfigOverride = { host: '127.0.0.1', port: 4403 };
    manager.isConnected = false;
    manager.userDisconnectedState = false;
    manager.transport = null;
    manager.passiveMode = true;
    manager.suppressNextAutoSync = false;
    manager.postResetCooldownUntil = 0;
    manager.localNodeInfo = null;
    manager.actualDeviceConfig = null;
    manager.actualModuleConfig = null;
    manager.lastDisconnectAt = null;
    manager.lastCompletedSyncAt = null;
    manager.preConfigChannelSnapshot = [];
    manager.initConfigCache = [];
    manager.configCaptureComplete = false;
    manager.isCapturingInitConfig = false;
    manager.deviceNodeNums = new Set();
    manager.manualResyncInFlight = false;
    manager.manualResyncLastAt = null;
    manager.favoritesSupportCache = null;
    manager.virtualNodeServer = undefined;
    manager.quickCloseDetector.reset();
    (manager.quickCloseDetector as any).lastWarnAt = null;
    // Work the full-sync completion path runs that this file does not exercise.
    manager.detectAndMigrateChannelChanges = vi.fn().mockResolvedValue(undefined);
    manager.flushPendingFavoriteResyncs = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager.cancelConfigCompleteFallbackTimer();
  });

  /** Connect with a fresh fake transport, as the transport's 'connect' event would. */
  async function connect() {
    manager.transport = makeFakeTransport();
    await manager.handleConnected();
    return manager.transport;
  }

  /** Seed the cache a sync leaves behind (MyInfo + Config frames). */
  function seedCache() {
    manager.localNodeInfo = { nodeNum: 0xaabbccdd, nodeId: '!aabbccdd' };
    manager.actualDeviceConfig = { device: { role: 0 } };
  }

  describe('skip gating', () => {
    it('a sync that died part way (Config frames, no config_complete_id) does not arm the skip', async () => {
      await connect();
      expect(lastNonce()).toBe(WANT_CONFIG_NONCE_FULL);
      seedCache(); // config frames arrived ...
      await manager.handleDisconnected(); // ... then the node closed the link

      // The passive cache survived the disconnect as before ...
      expect(manager.actualDeviceConfig).not.toBeNull();
      expect(manager.lastCompletedSyncAt).toBeNull();

      createWantConfigRequest.mockClear();
      await connect();

      // ... but the reconnect does a full sync, not the skip.
      expect(manager.isCapturingInitConfig).toBe(true);
      expect(createWantConfigRequest).toHaveBeenCalledTimes(1);
      expect(lastNonce()).toBe(WANT_CONFIG_NONCE_FULL);
    });

    it('a completed full sync arms the skip, and the marker and cache survive a passive disconnect', async () => {
      await connect();
      seedCache();
      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_FULL);
      expect(manager.configCaptureComplete).toBe(true);
      expect(manager.lastCompletedSyncAt).not.toBeNull();

      await manager.handleDisconnected();
      expect(manager.lastCompletedSyncAt).not.toBeNull();
      expect(manager.localNodeInfo).not.toBeNull();
      expect(manager.actualDeviceConfig).toEqual({ device: { role: 0 } });

      createWantConfigRequest.mockClear();
      await connect();

      expect(manager.isCapturingInitConfig).toBe(false);
      expect(manager.configCaptureComplete).toBe(true);
      expect(manager.localNodeInfo).not.toBeNull();
      expect(createWantConfigRequest).toHaveBeenCalledTimes(1);
      expect(lastNonce()).toBe(WANT_CONFIG_NONCE_ONLY_CONFIG);
    });

    it('a config_complete_id that does not answer our full request does not set the marker', async () => {
      await connect();
      seedCache();
      await deliverConfigComplete(manager, 12345);
      expect(manager.configCaptureComplete).toBe(true);
      expect(manager.lastCompletedSyncAt).toBeNull();
    });

    it('a non-passive disconnect clears the marker with the rest of the cache', async () => {
      manager.passiveMode = false;
      await connect();
      seedCache();
      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_FULL);
      expect(manager.lastCompletedSyncAt).not.toBeNull();

      await manager.handleDisconnected();
      expect(manager.lastCompletedSyncAt).toBeNull();
    });
  });

  describe('which nonce a connect sends', () => {
    it('a first connect sends the full nonce', async () => {
      await connect();
      expect(lastNonce()).toBe(WANT_CONFIG_NONCE_FULL);
    });

    it('a non-passive reconnect sends the full nonce even after a completed sync', async () => {
      manager.passiveMode = false;
      await connect();
      seedCache();
      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_FULL);
      await manager.handleDisconnected();

      createWantConfigRequest.mockClear();
      const t = await connect();
      expect(lastNonce()).toBe(WANT_CONFIG_NONCE_FULL);
      expect(t.send).toHaveBeenCalledTimes(1);
    });

    it('a passive reconnect sends the config-only nonce over the transport', async () => {
      await connect();
      seedCache();
      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_FULL);
      await manager.handleDisconnected();

      const t = await connect();
      expect(lastNonce()).toBe(WANT_CONFIG_NONCE_ONLY_CONFIG);
      expect(t.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('config-only completion', () => {
    async function passiveReconnect() {
      await connect();
      seedCache();
      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_FULL);
      await manager.handleDisconnected();
      await connect();
    }

    it('does not clear nodes or re-run once-per-session work', async () => {
      const callback = vi.fn();
      await passiveReconnect();
      // The skip path ran the post-config callback once already; swap in a
      // spy to see whether the config-only completion runs it again.
      manager.onConfigCaptureComplete = callback;
      manager.deviceNodeNums = new Set([1, 2, 3]);
      manager.initConfigCache = [{ type: 'nodeInfo', data: new Uint8Array([9]) }];
      const markerBefore = manager.lastCompletedSyncAt;
      (manager.detectAndMigrateChannelChanges as any).mockClear();
      (logger.info as ReturnType<typeof vi.fn>).mockClear();

      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_ONLY_CONFIG);

      expect(callback).not.toHaveBeenCalled();
      expect(manager.detectAndMigrateChannelChanges).not.toHaveBeenCalled();
      expect(manager.deviceNodeNums.size).toBe(3);
      expect(manager.initConfigCache).toHaveLength(1);
      expect(manager.localNodeInfo).not.toBeNull();
      expect(manager.configCaptureComplete).toBe(true);
      expect(manager.lastCompletedSyncAt).toBe(markerBefore);
      expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Config sync complete'));
    });

    it('a late config-only completion does not end a full sync in progress', async () => {
      await connect();
      expect(manager.isCapturingInitConfig).toBe(true);

      await deliverConfigComplete(manager, WANT_CONFIG_NONCE_ONLY_CONFIG);

      expect(manager.isCapturingInitConfig).toBe(true);
      expect(manager.configCaptureComplete).toBe(false);
      expect(manager.lastCompletedSyncAt).toBeNull();
    });
  });

  describe('quick-close warning', () => {
    const slotWarnings = () =>
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
        String(c[0]).includes("single TCP slot"));

    async function quickCycle() {
      await connect();
      await manager.handleDisconnected();
      await flush();
    }

    it('warns once after three quick closes in a row, naming the endpoint', async () => {
      manager.passiveMode = false;
      await quickCycle();
      await quickCycle();
      expect(slotWarnings()).toHaveLength(0);
      await quickCycle();
      expect(slotWarnings()).toHaveLength(1);
      expect(String(slotWarnings()[0][0])).toContain('127.0.0.1:4403');
      expect(String(slotWarnings()[0][0])).toContain('3 times');
    });

    it('does not repeat the warning inside the rate-limit window', async () => {
      manager.passiveMode = false;
      for (let i = 0; i < 9; i++) await quickCycle();
      expect(slotWarnings()).toHaveLength(1);
    });

    it('does not count an operator disconnect', async () => {
      manager.passiveMode = false;
      await quickCycle();
      await quickCycle();
      await connect();
      await manager.userDisconnect();
      await manager.handleDisconnected();
      await flush();
      manager.userDisconnectedState = false;
      await quickCycle();
      expect(slotWarnings()).toHaveLength(0);
    });
  });
});
