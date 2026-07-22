/**
 * Regression test for issue #3270: per-source TCP flap caused by an orphaned
 * transport.
 *
 * Symptoms in production: one of two configured TCP sources cycles
 * `Connection status: connected` → `disconnected` every 25–60s while the
 * other is rock-solid, with the daemon logging ~2 "Force close previous TCP
 * connection" events per MeshMonitor disconnect and NO want_config_id /
 * connect-race errors.
 *
 * Root cause: `MeshtasticManager.connect()` reassigned `this.transport`
 * without tearing down the previous TcpTransport. A second connect() call —
 * `refreshNodeDatabase()` landing in a transient disconnect window, a user
 * reconnect, or a startup race on the env-bootstrap singleton — orphaned the
 * old transport. The orphan kept its socket open, kept its 'connect'/
 * 'disconnect' listeners bound to the manager, and kept its internal
 * shouldReconnect flag set, so it auto-reconnected forever. Two live
 * transports against the same meshtasticd (single API-client policy) then
 * ping-ponged: each new socket force-closed the other, both saw 'close',
 * both reconnected.
 *
 * The fix tears down any existing transport at the top of connect() before
 * creating the new one, guaranteeing exactly one live transport per manager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();

// Track every TcpTransport the manager constructs so we can assert the new
// transport is distinct from the torn-down one.
const createdTransports: any[] = [];
const makeFakeTransport = () => ({
  setStaleConnectionTimeout: vi.fn(),
  setConnectTimeout: vi.fn(),
  setReconnectTiming: vi.fn(),
  setStartupGraceReconnect: vi.fn(),
  setHeartbeatInterval: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  disconnect: vi.fn(),
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
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
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
    notifyNodeConnected: vi.fn().mockResolvedValue(undefined),
    notifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emit: vi.fn(), emitConnectionStatus: vi.fn(), on: vi.fn() },
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

describe('MeshtasticManager - issue #3270 orphaned-transport flap', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    createdTransports.length = 0;

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;

    // Use a per-source config override so getConfig() short-circuits without
    // touching settings.
    manager.sourceConfigOverride = { host: '127.0.0.1', port: 4403 };
    manager.isConnected = false;
    manager.transport = null;
    manager.passiveMode = false;
    manager.postResetCooldownUntil = 0;
    manager.userDisconnectedState = false;
  });

  it('tears down an existing transport before creating a new one', async () => {
    const oldTransport = makeFakeTransport();
    manager.transport = oldTransport;

    await manager.connect();

    // The old transport was fully decommissioned: listeners removed and socket
    // closed (which clears its shouldReconnect flag), so it can no longer
    // auto-reconnect and fight the new transport for the daemon's API slot.
    expect(oldTransport.removeAllListeners).toHaveBeenCalled();
    expect(oldTransport.disconnect).toHaveBeenCalled();

    // A single fresh transport was created and installed.
    expect(createdTransports.length).toBe(1);
    expect(manager.transport).toBe(createdTransports[0]);
    expect(manager.transport).not.toBe(oldTransport);
  });

  it('does not orphan a transport across repeated connect() calls', async () => {
    await manager.connect();
    const first = manager.transport;
    await manager.connect();
    const second = manager.transport;

    // Two connect() calls => exactly two transports constructed, and the first
    // was torn down rather than left running in parallel.
    expect(createdTransports.length).toBe(2);
    expect(second).not.toBe(first);
    expect(first.disconnect).toHaveBeenCalled();
    expect(first.removeAllListeners).toHaveBeenCalled();
    expect(second.disconnect).not.toHaveBeenCalled();
  });

  it('first connect with no prior transport does not attempt a teardown', async () => {
    manager.transport = null;

    await expect(manager.connect()).resolves.toBe(true);

    expect(createdTransports.length).toBe(1);
    expect(manager.transport).toBe(createdTransports[0]);
  });

  it('serializes concurrent connect() calls into a single transport (#3270 follow-up: startup-race orphan)', async () => {
    manager.transport = null;

    // Fire two connect() calls without awaiting the first. This reproduces the
    // residual #3270 flap: on the legacy singleton, a startup connect() is
    // still mid-handshake (awaiting getConfig / protobuf init / transport
    // connect) while a legacy route's refreshNodeDatabase() — which calls
    // connect() whenever isConnected is false — fires a second connect().
    // Without a connect mutex, both calls pass the null-transport teardown
    // check and each constructs a TcpTransport; the first becomes an
    // unreferenced orphan that auto-reconnects forever (the transport-level
    // flap the #3276 teardown can no longer reach).
    const [r1, r2] = await Promise.all([manager.connect(), manager.connect()]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);

    // Exactly one transport was constructed — the second call joined the
    // in-flight attempt instead of building a parallel (orphan) transport.
    expect(createdTransports.length).toBe(1);
    expect(manager.transport).toBe(createdTransports[0]);
  });

  it('allows a fresh connect() after the previous attempt settles (mutex clears)', async () => {
    await manager.connect();
    expect(createdTransports.length).toBe(1);

    // Once the in-flight attempt has resolved, a later connect() must proceed
    // normally (the mutex must not latch permanently).
    await manager.connect();
    expect(createdTransports.length).toBe(2);
  });

  it('does not tear down an injected transport that is reused as-is', async () => {
    const injected = makeFakeTransport();
    manager.transport = injected;

    await manager.connect(injected);

    // Re-injecting the same transport must not destroy it — the guard skips
    // teardown when this.transport === injectedTransport.
    expect(injected.disconnect).not.toHaveBeenCalled();
    expect(injected.removeAllListeners).not.toHaveBeenCalled();
    expect(manager.transport).toBe(injected);
    // No fresh TcpTransport was constructed.
    expect(createdTransports.length).toBe(0);
  });
});
