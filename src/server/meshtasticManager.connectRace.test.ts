/**
 * Regression test for issue #3247: per-minute reconnect loop caused by
 * the connect-handshake race.
 *
 * Symptoms in production: `Connection status: connected` → 17–40 ms later
 * `Connection status: disconnected` → `Initial sendWantConfigId failed
 * (Transport not initialized) — treating as transient post-connect reset`,
 * three times per minute, deterministic. The underlying TCP socket is
 * healthy (the device's config response still arrives ~300 ms after we've
 * already declared disconnect), so the loop is purely an internal state
 * race: `this.transport` becomes null between the transport's 'connect'
 * event and `handleConnected`'s eventual `await this.sendWantConfigId()`,
 * the send throws, and the catch block treats it as a fatal post-connect
 * reset — which immediately re-fires the same race on the next reconnect.
 *
 * The fix introduces a transport-identity guard at `handleConnected` entry
 * and uses it in the catch block to distinguish "transport went away under
 * me during the handshake" (silent bail) from a genuine transport-layer
 * send failure (existing teardown path).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetNode = vi.fn();
const mockGetAllChannels = vi.fn().mockResolvedValue([]);
const mockNotifyNodeConnected = vi.fn().mockResolvedValue(undefined);
const mockNotifyNodeDisconnected = vi.fn().mockResolvedValue(undefined);
const mockEmitConnectionStatus = vi.fn();

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
      getNode: mockGetNode,
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: mockUpsertNode,
      getNodeCount: vi.fn().mockResolvedValue(0),
    },
    channels: {
      getAllChannels: mockGetAllChannels,
      upsertChannel: vi.fn().mockResolvedValue(undefined),
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
    telemetry: {
      insertTelemetryBatch: vi.fn().mockResolvedValue(0),
    },
    messages: {
      getMessages: vi.fn().mockResolvedValue([]),
    },
    neighbors: {
      deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0),
    },
    sources: {
      getSource: vi.fn().mockResolvedValue({ id: 'default', name: 'test', type: 'meshtastic' }),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createWantConfigRequest: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: { encode: vi.fn(), decode: vi.fn() },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({ getProtobufRoot: vi.fn() }));
vi.mock('./tcpTransport.js', () => ({ TcpTransport: vi.fn() }));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: mockNotifyNodeConnected,
    notifyNodeDisconnected: mockNotifyNodeDisconnected,
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emit: vi.fn(),
    emitConnectionStatus: mockEmitConnectionStatus,
    on: vi.fn(),
  },
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
  getEnvironmentConfig: vi.fn(() => ({ NODE_IP: '127.0.0.1', TCP_PORT: 4403, LOG_LEVEL: 'info' })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({ normalizeTriggerPatterns: vi.fn() }));
vi.mock('../utils/nodeHelpers.js', () => ({ isNodeComplete: vi.fn() }));

describe('MeshtasticManager - issue #3247 connect-handshake race', () => {
  let manager: any;
  let logger: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAllChannels.mockResolvedValue([]);
    mockNotifyNodeConnected.mockResolvedValue(undefined);

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    logger = (await import('../utils/logger.js')).logger;

    // Reset per-test state on the singleton.
    manager.isConnected = false;
    manager.transport = null;
    manager.localNodeInfo = null;
    manager.actualDeviceConfig = null;
    manager.lastDisconnectAt = null;
    manager.passiveMode = false;
    manager.suppressNextAutoSync = false;
    manager.postResetCooldownUntil = 0;
    manager.preConfigChannelSnapshot = [];
    manager.initConfigCache = [];
    manager.configCaptureComplete = false;
    manager.isCapturingInitConfig = false;
    manager.deviceNodeNums = new Set();
  });

  it('bails silently when transport is null at handleConnected entry (no teardown)', async () => {
    // Simulate: transport's 'connect' event scheduled the handler, but a
    // racing disconnect path nulled `this.transport` before the handler
    // ran. The handler must NOT proceed to mutate state, emit a connected
    // event, or fall into the post-reset cooldown.
    manager.transport = null;

    await manager.handleConnected();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[connect-race] handleConnected fired with no transport')
    );
    // Did NOT set isConnected, did NOT emit a connected status, did NOT
    // arm the post-reset cooldown.
    expect(manager.isConnected).toBe(false);
    expect(manager.postResetCooldownUntil).toBe(0);
    expect(mockEmitConnectionStatus).not.toHaveBeenCalled();
    expect(mockNotifyNodeConnected).not.toHaveBeenCalled();
  });

  it('bails silently when transport is replaced during the handshake await chain', async () => {
    // The exact #3247 scenario: transport is present at handler entry, but
    // a parallel disconnect handler nulls it during one of the awaits
    // (notifyNodeConnected here) before sendWantConfigId is reached. The
    // catch block must detect the swap and bail WITHOUT triggering the
    // post-connect-reset teardown that produces the 3×/min reconnect loop.
    const mockTransport = {
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    manager.transport = mockTransport;

    // Null the transport mid-await — simulating the disconnect event firing
    // while handleConnected is suspended.
    mockNotifyNodeConnected.mockImplementation(async () => {
      manager.transport = null;
    });

    await manager.handleConnected();

    // The connected-status emit at the top of handleConnected still fires
    // (we hadn't observed the race yet) — that's fine.
    expect(mockEmitConnectionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true }),
      expect.anything()
    );
    // But the post-connect-reset teardown emit must NOT have fired.
    const teardownEmits = mockEmitConnectionStatus.mock.calls.filter(
      (call: any[]) => call[0]?.connected === false
    );
    expect(teardownEmits).toEqual([]);
    // And we must NOT have armed the cooldown, because that re-triggers
    // the same race on the next reconnect.
    expect(manager.postResetCooldownUntil).toBe(0);
    // The race-detection debug should have fired in place of the warn.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[connect-race] sendWantConfigId aborted')
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('treating as transient post-connect reset')
    );
    // The transport's own send was never called (we lost the reference
    // before sendWantConfigId could use it).
    expect(mockTransport.send).not.toHaveBeenCalled();
  });

  it('still treats a genuine transport-layer send failure as a post-connect reset', async () => {
    // Counter-test: when the transport reference is STABLE across the
    // handshake but send() itself throws (e.g. tcpTransport's "Not
    // connected to TCP server" after an OTA-induced socket close), the
    // existing teardown + cooldown behavior must still kick in.
    const sendError = new Error('Not connected to TCP server');
    const mockTransport = {
      send: vi.fn().mockRejectedValue(sendError),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
    manager.transport = mockTransport;

    await manager.handleConnected();

    // The connected emit fired, and at least one teardown emit fired
    // identifying the post-connect-reset reason. (handleDisconnected may
    // emit its own connected:false event too — we only care that the
    // catch block's specific "Transport reset immediately after connect"
    // emit is among them.)
    const teardownEmits = mockEmitConnectionStatus.mock.calls.filter(
      (call: any[]) => call[0]?.connected === false
    );
    expect(teardownEmits.length).toBeGreaterThanOrEqual(1);
    expect(teardownEmits.some(
      (call: any[]) => /Transport reset immediately after connect/.test(call[0]?.reason ?? '')
    )).toBe(true);
    // Cooldown was armed — this is the legitimate post-reset case.
    expect(manager.postResetCooldownUntil).toBeGreaterThan(Date.now());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('treating as transient post-connect reset')
    );
  });
});
