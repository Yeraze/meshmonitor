/**
 * Meshtastic split long messages through the shared sender (#6330).
 *
 * - `sendAutomatedText`: 200-byte cap, up to 3 "(i/N)" parts, 10 s gap, part
 *   by part across channels, "..." on a cut, reply id on the first part only,
 *   a per-source mutex, the receive-only re-check, and the direct path.
 * - Auto Responder "multiline" now splits through it (no more unbounded,
 *   unmarked parts), and multi-response JSON never splits.
 * - Timer Triggers skip a fire while the previous fire is still in flight or
 *   still in the message queue.
 *
 * Mock preamble copied from meshtasticManager.autoAckResponderPingTxDisabled.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetSettingForSource = vi.fn();
const mockGetNode = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: mockGetSettingForSource,
      setSettingForSource: vi.fn().mockResolvedValue(undefined),
    },
    nodes: {
      getNode: mockGetNode,
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      markNodeAsWelcomedIfNotAlready: vi.fn().mockResolvedValue(false),
      getNodeCount: vi.fn().mockResolvedValue(0),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: vi.fn().mockResolvedValue(undefined),
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
    telemetry: {
      insertTelemetry: vi.fn().mockResolvedValue(undefined),
      insertTelemetryBatch: vi.fn().mockResolvedValue(0),
      getLatestTelemetryForType: vi.fn().mockResolvedValue(null),
    },
    messages: {
      insertMessage: vi.fn().mockResolvedValue(true),
      getMessages: vi.fn().mockResolvedValue([]),
      updateMessageTimestamps: vi.fn().mockResolvedValue(true),
      updateMessageDeliveryState: vi.fn().mockResolvedValue(true),
    },
    traceroutes: {
      insertTraceroute: vi.fn().mockResolvedValue(undefined),
      insertRouteSegment: vi.fn().mockResolvedValue(undefined),
    },
    neighbors: {
      upsertNeighborInfo: vi.fn().mockResolvedValue(undefined),
      deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0),
    },
    logKeyRepairAttemptAsync: vi.fn().mockResolvedValue(0),
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    deleteNodeAsync: vi.fn().mockResolvedValue({}),
    getNodeNeedingTimeSyncAsync: vi.fn().mockResolvedValue(null),
    getNodeNeedingRemoteAdminCheckAsync: vi.fn().mockResolvedValue(null),
    updateNodeRemoteAdminStatusAsync: vi.fn().mockResolvedValue(undefined),
    getNodesNeedingKeyRepairAsync: vi.fn().mockResolvedValue([]),
    getKeyRepairLogAsync: vi.fn().mockResolvedValue([]),
    setKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    insertTelemetryAsync: vi.fn().mockResolvedValue(undefined),
    getLatestTelemetryForTypeAsync: vi.fn().mockResolvedValue(null),
    getMessageByRequestIdAsync: vi.fn().mockResolvedValue(null),
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(0),
    getRecentEstimatedPositionsAsync: vi.fn().mockResolvedValue([]),
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    setGeofenceCooldownAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
    getNodeNeedingTracerouteAsync: vi.fn().mockResolvedValue(null),
    logAutoTracerouteAttemptAsync: vi.fn().mockResolvedValue(0),
    updateAutoTracerouteResultByNodeAsync: vi.fn().mockResolvedValue(undefined),
    recordTracerouteRequest: vi.fn(),
    getNodesNeedingRemoteLocalStatsAsync: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: {
    encode: vi.fn(),
    decode: vi.fn(),
  },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({
  getProtobufRoot: vi.fn(),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    checkAndSendNotifications: vi.fn(),
  },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: {
    logPacket: vi.fn(),
  },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    tryDecrypt: vi.fn(),
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emit: vi.fn(),
    on: vi.fn(),
    emitAutoPingUpdate: vi.fn(),
  },
}));

let queueSeq = 0;
/** Queue ids the fake queue still holds (#6330 skip-if-still-queued). */
const stillQueued = new Set<string>();
const mockEnqueue = vi.fn((..._args: unknown[]) => `q${++queueSeq}`);
const mockHasQueued = vi.fn((ids: Iterable<string>) => [...ids].some((id) => stillQueued.has(id)));
vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: mockEnqueue,
    hasQueued: mockHasQueued,
    setSendCallback: vi.fn(),
    handleAck: vi.fn(),
    handleFailure: vi.fn(),
    recordExternalSend: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return {
    messageQueueService: mockInstance,
    MessageQueueService,
  };
});

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn((_expression: string, _callback: () => void) => ({
    stop: vi.fn(),
  })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    NODE_IP: '127.0.0.1',
    TCP_PORT: 4403,
    LOG_LEVEL: 'info',
  })),
}));


vi.mock('../utils/nodeHelpers.js', () => ({
  isNodeComplete: vi.fn(),
}));

const LOCAL_NODE_NUM = 1234567890;
const REMOTE_NODE_NUM = 987654321;

/** Backing store for getSettingForSource, keyed by settings key (sourceId ignored — single source in these tests). */
function wireSettings(overrides: Record<string, string | null>) {
  mockGetSettingForSource.mockImplementation((_sourceId: string, key: string) =>
    Promise.resolve(Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null)
  );
}

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
// host) to the first test's hook budget; collection has no such budget.
const managerModule = await import('./meshtasticManager.js');

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const LONG = 'word '.repeat(60).trim(); // 299 bytes: two parts
const VERY_LONG = 'word '.repeat(200).trim(); // ~1000 bytes: past 3 parts

describe('MeshtasticManager.sendAutomatedText (#6330)', () => {
  let manager: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = managerModule.fallbackManager;
    manager.isConnected = true;
    manager.actualDeviceConfig = { lora: { txEnabled: true } };
    manager.sendTextMessage = vi.fn().mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cuts to 200 bytes with "..." and sends one part when split is off', async () => {
    const res = await manager.sendAutomatedText(VERY_LONG, { channels: [0], split: false, label: 'T' });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const text = mockEnqueue.mock.calls[0][0] as string;
    expect(bytes(text)).toBeLessThanOrEqual(200);
    expect(text.endsWith('...')).toBe(true);
    expect(res).toMatchObject({ ok: true, totalParts: 1, truncated: true });
  });

  it('leaves a short text untouched, with no marker', async () => {
    await manager.sendAutomatedText('hello', { channels: [0], split: true, label: 'T' });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue.mock.calls[0][0]).toBe('hello');
  });

  it('splits into marked parts, part by part across channels, 10 s apart', async () => {
    const p = manager.sendAutomatedText(LONG, { channels: [0, 3], split: true, label: 'T' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockEnqueue.mock.calls.map((c) => c[5])).toEqual([0, 3]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(mockEnqueue.mock.calls.map((c) => c[5])).toEqual([0, 3, 0, 3]);
    expect((mockEnqueue.mock.calls[0][0] as string).startsWith('(1/2) ')).toBe(true);
    expect((mockEnqueue.mock.calls[2][0] as string).startsWith('(2/2) ')).toBe(true);
    for (const c of mockEnqueue.mock.calls) expect(bytes(c[0] as string)).toBeLessThanOrEqual(200);
    expect(res).toMatchObject({ ok: true, sentParts: 2, totalParts: 2, truncated: false });
  });

  it('stops at 3 parts and ends the last one with "..."', async () => {
    const p = manager.sendAutomatedText(VERY_LONG, { channels: [0], split: true, label: 'T' });
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await p;
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    const last = mockEnqueue.mock.calls[2][0] as string;
    expect(last.startsWith('(3/3) ')).toBe(true);
    expect(last.endsWith('...')).toBe(true);
    expect(bytes(last)).toBeLessThanOrEqual(200);
    expect(res).toMatchObject({ totalParts: 3, truncated: true });
  });

  it('puts the reply id on the first part only and keeps DM attempts on every part', async () => {
    const p = manager.sendAutomatedText(LONG, { destination: 42, split: true, label: 'T', replyId: 777, maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const [first, second] = mockEnqueue.mock.calls;
    expect(first[1]).toBe(42);
    expect(first[2]).toBe(777);
    expect(second[2]).toBeUndefined();
    expect(first[5]).toBeUndefined(); // DM: no channel
    expect(first[6]).toBe(3);
    expect(second[6]).toBe(3);
    expect(first[9]).toBe('automation');
  });

  it('drops the remaining parts when receive-only is switched on mid-sequence', async () => {
    const p = manager.sendAutomatedText(LONG, { channels: [0], split: true, label: 'T' });
    await vi.advanceTimersByTimeAsync(0);
    manager.actualDeviceConfig = { lora: { txEnabled: false } };
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: false, sentParts: 1, totalParts: 2 });
  });

  it('never interleaves two split sequences on one source', async () => {
    const a = manager.sendAutomatedText(LONG.replace(/word/g, 'aaaa'), { channels: [0], split: true, label: 'A' });
    const b = manager.sendAutomatedText(LONG.replace(/word/g, 'bbbb'), { channels: [0], split: true, label: 'B' });
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([a, b]);
    const order = mockEnqueue.mock.calls.map((c) => (c[0] as string).slice(0, 10));
    expect(order).toEqual(['(1/2) aaaa', '(2/2) aaaa', '(1/2) bbbb', '(2/2) bbbb']);
  });

  it('sends direct through sendTextMessage when asked', async () => {
    const p = manager.sendAutomatedText(LONG, { channels: [1], split: true, label: 'T', direct: true, hopLimitOverride: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(manager.sendTextMessage).toHaveBeenCalledTimes(2);
    const [text, channel, dest, , , , , opts] = manager.sendTextMessage.mock.calls[0];
    expect((text as string).startsWith('(1/2) ')).toBe(true);
    expect(channel).toBe(1);
    expect(dest).toBeUndefined();
    expect(opts).toEqual({ hopLimitOverride: 2, origin: 'automation' });
    expect(res.ok).toBe(true);
  });
});

describe('Auto Responder multiline uses the shared split (#6330)', () => {
  let manager: any;
  const message = { text: 'hello', fromNodeNum: REMOTE_NODE_NUM, channel: 0, timestamp: Date.now() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = managerModule.fallbackManager;
    manager.isConnected = true;
    manager.actualDeviceConfig = { lora: { txEnabled: true } };
    manager.localNodeInfo = { nodeNum: LOCAL_NODE_NUM, nodeId: '!499602d2', longName: 'Test Local Node', shortName: 'TLN' };
    manager.autoResponderProcessedPackets = new Set();
    manager.autoResponderCooldowns = new Map();
    manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const trigger = (over: Record<string, unknown>) => JSON.stringify([{
    id: 't1', trigger: 'hello', responseType: 'text', response: LONG, channels: [0], ...over,
  }]);

  it('splits a long text reply into marked parts when multiline is on', async () => {
    wireSettings({ autoResponderEnabled: 'true', autoResponderTriggers: trigger({ multiline: true }) });
    await manager.checkAutoResponder(message, false, 1001);
    await vi.advanceTimersByTimeAsync(10_000);
    const texts = mockEnqueue.mock.calls.map((c) => c[0] as string);
    expect(texts).toHaveLength(2);
    expect(texts[0].startsWith('(1/2) ')).toBe(true);
    expect(texts[1].startsWith('(2/2) ')).toBe(true);
    expect(mockEnqueue.mock.calls[0][2]).toBe(1001); // reply to the trigger on part 1
    expect(mockEnqueue.mock.calls[1][2]).toBeUndefined();
  });

  it('cuts a long reply to one 200-byte message when multiline is off', async () => {
    wireSettings({ autoResponderEnabled: 'true', autoResponderTriggers: trigger({}) });
    await manager.checkAutoResponder(message, false, 1002);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const text = mockEnqueue.mock.calls[0][0] as string;
    expect(bytes(text)).toBeLessThanOrEqual(200);
    expect(text.endsWith('...')).toBe(true);
  });

  it('never splits a multi-response JSON reply, even with multiline on', async () => {
    const response = JSON.stringify({ responses: [LONG, 'second'] });
    wireSettings({ autoResponderEnabled: 'true', autoResponderTriggers: trigger({ multiline: true, response }) });
    await manager.checkAutoResponder(message, false, 1003);
    await vi.advanceTimersByTimeAsync(10_000);
    const texts = mockEnqueue.mock.calls.map((c) => c[0] as string);
    expect(texts).toHaveLength(2);
    expect(texts[0].startsWith('(1/')).toBe(false);
    expect(bytes(texts[0])).toBeLessThanOrEqual(200);
    expect(texts[1]).toBe('second');
  });
});

describe('Timer Triggers skip a fire while the previous one is still queued (#6330)', () => {
  let manager: any;
  let cron: typeof import('./utils/cronScheduler.js');
  let loggerModule: any;

  const timers = (over: Record<string, unknown> = {}) => JSON.stringify([
    { id: 'tA', name: 'A', cronExpression: '*/10 * * * *', responseType: 'text', response: 'hello', channels: [0], enabled: true, ...over },
    { id: 'tB', name: 'B', cronExpression: '*/10 * * * *', responseType: 'text', response: 'other', channels: [1], enabled: true },
  ]);

  /** Arm the timers and return each one's cron callback, by timer id. */
  async function arm(json: string): Promise<Record<string, () => Promise<void>>> {
    wireSettings({ timerTriggers: json });
    (cron.scheduleCron as any).mockClear();
    await manager.startTimerScheduler();
    const out: Record<string, () => Promise<void>> = {};
    const ids = JSON.parse(json).map((t: { id: string }) => t.id);
    (cron.scheduleCron as any).mock.calls.forEach((c: unknown[], i: number) => { out[ids[i]] = c[1] as () => Promise<void>; });
    return out;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    stillQueued.clear();
    cron = await import('./utils/cronScheduler.js');
    loggerModule = await import('../utils/logger.js');
    manager = managerModule.fallbackManager;
    manager.isConnected = true;
    manager.actualDeviceConfig = { lora: { txEnabled: true } };
    manager.isAutomationAirtimeGated = vi.fn().mockResolvedValue(false);
    manager.replaceAnnouncementTokens = vi.fn(async (m: string) => m);
    manager.automationBacklog = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips while its items are queued, fires again once they are sent, and leaves other timers alone', async () => {
    const fire = await arm(timers());
    await fire.tA();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    stillQueued.add(mockEnqueue.mock.results[0].value as string);

    await fire.tA();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(loggerModule.logger.info).toHaveBeenCalledWith(expect.stringContaining('(tA): skipped'));

    await fire.tB(); // a different timer is not held back
    expect(mockEnqueue).toHaveBeenCalledTimes(2);

    stillQueued.clear();
    await fire.tA();
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
  });

  it('applies with split off too, and while a split sequence is still being queued', async () => {
    vi.useFakeTimers();
    const fire = await arm(timers({ response: LONG, multiline: true }));
    const first = fire.tA();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockEnqueue).toHaveBeenCalledTimes(1); // part 1; part 2 waits for the gap

    await fire.tA(); // in flight: skipped
    expect(mockEnqueue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    stillQueued.add(mockEnqueue.mock.results[1].value as string);
    await fire.tA(); // part 2 still queued: skipped
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });
});
