/**
 * Pin test for the announce-scheduler lifecycle across connect/disconnect/
 * reconnect (#3962 Phase 4.2a PR3 §5b, invariant I4).
 *
 * Confirmed gap (task42a_spec.md §0.7 / §5b): `disconnect()` used to stop
 * every other periodic scheduler (traceroute/remoteLocalStats/
 * remoteAdminScanner/timeSync/distanceDelete/localStats/timeOffset) but
 * never `announceScheduler` — only `userDisconnect()` did. An unexpected
 * disconnect (the auto-reconnect path via `handleDisconnected → disconnect()`)
 * left the announce scheduler ticking (self-guarded by `isDeviceConnected()`,
 * so harmless-but-wrong) instead of being torn down like its siblings.
 *
 * This test drives the real connect → disconnect → reconnect lifecycle
 * (via `handleConnected()`, exactly as issue #3247's connectRace test does)
 * and asserts:
 *   1. connect  → the extracted `AutoAnnounceService` is armed (`running`).
 *   2. disconnect() → it is stopped AND no orphaned timer survives (advancing
 *      fake time well past the configured interval never fires another send).
 *   3. reconnect → it re-arms and actually fires an announcement.
 *
 * `sendAutoAnnouncement` itself is stubbed (its business logic — token
 * expansion, multi-channel enqueue, NodeInfo broadcast — is covered by
 * `services/autoAnnounceService.test.ts` and the pre-existing
 * `meshtasticManager.announce-datetime.test.ts` /
 * `meshtasticManager.node-identity-guards.test.ts`); this file is scoped to
 * the *lifecycle* wiring only.
 *
 * Mock variables are declared via `vi.hoisted()` (rather than relying on the
 * `mock`-prefix hoisting convention) so factory references are unambiguous.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Stubs (mirrors meshtasticManager.connectRace.test.ts, the existing
// precedent for driving handleConnected() without a real TCP socket) -------

const {
  mockGetSetting,
  mockNotifyNodeConnected,
  mockNotifyNodeDisconnected,
  mockEmitConnectionStatus,
} = vi.hoisted(() => ({
  mockGetSetting: vi.fn(),
  mockNotifyNodeConnected: vi.fn().mockResolvedValue(undefined),
  mockNotifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
  mockEmitConnectionStatus: vi.fn(),
}));

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: vi.fn(),
    settings: {
      getSetting: mockGetSetting,
      setSetting: vi.fn(),
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn(),
      setSourceSetting: vi.fn().mockResolvedValue(undefined),
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
      getSource: vi.fn().mockResolvedValue({ id: 'test-announce-lifecycle', name: 'test', type: 'meshtastic' }),
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

// --- Imports (after vi.mock hoisting) --------------------------------------

import { MeshtasticManager } from './meshtasticManager.js';
import { AutoAnnounceService } from './services/autoAnnounceService.js';

// Delay between staggered scheduler starts in handleConnected's
// onConfigCaptureComplete callback (S). Announce is the 6th staggered start.
const SCHEDULER_STAGGER_MS = 5000;
const ANNOUNCE_STAGGER_MS = SCHEDULER_STAGGER_MS * 6;

function makeMockTransport() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
}

describe('MeshtasticManager — announce scheduler lifecycle (#3962 Phase 4.2a PR3 §5b, I4)', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Auto-announce enabled, interval mode (not cron), 3h interval, no
    // announce-on-start (keeps the test scoped to the recurring tick).
    mockGetSetting.mockImplementation((key: string) => {
      switch (key) {
        case 'autoAnnounceEnabled': return 'true';
        case 'autoAnnounceUseSchedule': return null;
        case 'autoAnnounceIntervalHours': return '3';
        case 'autoAnnounceOnStart': return null;
        default: return null;
      }
    });

    // Stub the actual send — this file asserts lifecycle wiring only.
    // `services/autoAnnounceService.test.ts` covers `sendAutoAnnouncement`'s
    // own logic in isolation.
    sendSpy = vi.spyOn(AutoAnnounceService.prototype, 'sendAutoAnnouncement').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connect arms the scheduler, disconnect() stops it with no orphaned timer, and reconnect re-arms and fires', async () => {
    const mgr = new MeshtasticManager('test-announce-lifecycle');
    const service = (mgr as any).autoAnnounceService as AutoAnnounceService;

    // ── 1. Connect ──────────────────────────────────────────────────────
    (mgr as any).transport = makeMockTransport();
    await (mgr as any).handleConnected();
    // Simulate the device's configComplete packet (the real dispatch path
    // calls the same callback from processMeshPacket's config-complete case).
    expect((mgr as any).onConfigCaptureComplete).toBeTypeOf('function');
    // The real dispatch path (processMeshPacket's config-complete case, L4112)
    // sets this immediately before invoking the callback — replicate that so
    // the CONFIG_COMPLETE_FALLBACK_MS fallback timer doesn't also fire the
    // callback a second time later and re-arm (stop+rearm) the scheduler out
    // from under this test's timing assertions.
    (mgr as any).configCaptureComplete = true;
    (mgr as any).onConfigCaptureComplete();

    // Advance past the announce scheduler's staggered start (6th of 11).
    await vi.advanceTimersByTimeAsync(ANNOUNCE_STAGGER_MS);

    expect(service.running).toBe(true);
    expect((mgr as any).isConnected).toBe(true);

    // ── 2. Disconnect ───────────────────────────────────────────────────
    mgr.disconnect();

    expect(service.running).toBe(false);
    expect((mgr as any).isConnected).toBe(false);

    // No orphaned timer: advance well past the configured 3h interval —
    // the scheduler must not tick after being stopped.
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(sendSpy).not.toHaveBeenCalled();

    // ── 3. Reconnect ────────────────────────────────────────────────────
    (mgr as any).transport = makeMockTransport();
    await (mgr as any).handleConnected();
    (mgr as any).configCaptureComplete = true;
    (mgr as any).onConfigCaptureComplete();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_STAGGER_MS);

    expect(service.running).toBe(true);

    // Cross the 3h interval — the re-armed scheduler must fire.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(true);
  });

  it('userDisconnect() also stops the scheduler (pre-existing behavior, unaffected by the extraction)', async () => {
    const mgr = new MeshtasticManager('test-announce-lifecycle-user');
    const service = (mgr as any).autoAnnounceService as AutoAnnounceService;

    (mgr as any).transport = makeMockTransport();
    await (mgr as any).handleConnected();
    (mgr as any).configCaptureComplete = true;
    (mgr as any).onConfigCaptureComplete();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_STAGGER_MS);

    expect(service.running).toBe(true);

    await mgr.userDisconnect();

    expect(service.running).toBe(false);
  });
});
