/**
 * Tests for MeshCore delivery-diagnostics event recording (#4816 Phase 3 WP2b).
 *
 * The manager records a per-message event timeline at five existing transition
 * seams by calling `databaseService.messageEvents.recordEvent(...)`. Each call
 * is fire-and-forget: a diagnostics write must NEVER break a send/ack path, so
 * a throwing recorder is swallowed and logged. These tests assert:
 *  - `submitted` on a genuine outgoing send (provenance 'observed');
 *  - an auto-retry resend does NOT record a second `submitted`;
 *  - `delivered` on the `send_confirmed` ack (provenance 'reported', roundTripMs);
 *  - `retry` on both the DM (#3977) and channel (#3979) auto-retry cadences;
 *  - `timeout` on the DM retries-exhausted terminal path (provenance 'inferred');
 *  - a RECEIVED message records zero events;
 *  - a recorder throw does not break the send/ack path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

interface RecordedEvent {
  sourceId: string;
  messageId: string;
  eventType: string;
  provenance: string;
  timestamp: number;
  detail?: string | null;
}

function makeManager(opts: {
  sends?: Array<{ ackCrc: number; estTimeout: number }>;
  resetPathOk?: boolean;
  channelRetryEnabled?: boolean;
  /** recordEvent implementation override (e.g. to throw) */
  recordEventImpl?: (params: RecordedEvent) => Promise<void>;
} = {}): {
  manager: MeshCoreManager;
  bridgeCalls: BridgeCall[];
  recordEvent: ReturnType<typeof vi.fn>;
  recorded: RecordedEvent[];
} {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: 'local'.padEnd(64, '0'), name: 'Me' };
  (m as any).contacts = new Map([
    ['bob'.padEnd(64, '0'), { publicKey: 'bob'.padEnd(64, '0'), advName: 'Bob' }],
  ]);

  const bridgeCalls: BridgeCall[] = [];
  let sendIdx = 0;
  const sends = opts.sends ?? [
    { ackCrc: 111, estTimeout: 8000 },
    { ackCrc: 222, estTimeout: 8000 },
    { ackCrc: 333, estTimeout: 8000 },
    { ackCrc: 444, estTimeout: 8000 },
  ];

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'send_message') {
      if (!params.to) return { id: '1', success: true, data: {} };
      const next = sends[Math.min(sendIdx, sends.length - 1)];
      sendIdx += 1;
      return { id: '1', success: true, data: { expectedAckCrc: next.ackCrc, estTimeout: next.estTimeout } };
    }
    if (cmd === 'reset_path') {
      return { id: '1', success: opts.resetPathOk ?? true };
    }
    return { id: '1', success: true, data: {} };
  };

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async () => null),
    updateChannelScope: vi.fn(async () => {}),
    upsertChannel: vi.fn(async () => {}),
    getAllChannels: vi.fn(async () => []),
    deleteChannel: vi.fn(async () => {}),
  } as any);

  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async () => null),
    setSourceSetting: vi.fn(async () => {}),
    getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => opts.channelRetryEnabled ?? def ?? false),
  } as any);

  // Leave the meshcore repo mostly real (insertMessage fails gracefully via its
  // own .catch when no DB is wired); only stub the heard-count read used by the
  // channel-retry path so it deterministically sees "zero heard" → resend.
  vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessage').mockResolvedValue([] as any);
  vi.spyOn(databaseService.meshcore, 'insertMessage').mockResolvedValue(undefined as any);

  const recorded: RecordedEvent[] = [];
  const recordEvent = vi.fn(async (params: RecordedEvent) => {
    if (opts.recordEventImpl) return opts.recordEventImpl(params);
    recorded.push(params);
  });
  vi.spyOn(databaseService, 'messageEvents', 'get').mockReturnValue({
    recordEvent,
  } as any);

  return { manager: m, bridgeCalls, recordEvent, recorded };
}

function sendConfirmed(m: MeshCoreManager, ackCode: number, rtt = 500): void {
  // @ts-expect-error - exercising private handler
  m.handleBridgeEvent({ event_type: 'send_confirmed', data: { ack_code: ackCode, round_trip_ms: rtt } });
}

const PUBKEY = 'bob'.padEnd(64, '0');
const eventsOfType = (recorded: RecordedEvent[], type: string) => recorded.filter(e => e.eventType === type);

describe('MeshCoreManager — delivery-diagnostics event recording (#4816 Phase 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records `submitted` (observed) on a genuine outgoing DM send', async () => {
    const { manager, recorded } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    const messageId = (manager as any).messages[0].id;

    const submitted = eventsOfType(recorded, 'submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      sourceId: 'test-source',
      messageId,
      eventType: 'submitted',
      provenance: 'observed',
    });
    expect(typeof submitted[0].timestamp).toBe('number');
  });

  it('does NOT record a duplicate `submitted` for auto-retry resends', async () => {
    const { manager, recorded } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    // Drive the full same-path + flood retry cadence (multiple resends).
    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #1
    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #2
    await vi.advanceTimersByTimeAsync(10_000); // flood retry

    // Exactly one `submitted` despite several auto-retry resends.
    expect(eventsOfType(recorded, 'submitted')).toHaveLength(1);
    // But the resends DID record `retry` rows.
    expect(eventsOfType(recorded, 'retry').length).toBeGreaterThan(0);
  });

  it('records `delivered` (reported, with roundTripMs) when the ack arrives', async () => {
    const { manager, recorded } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    const messageId = (manager as any).messages[0].id;
    sendConfirmed(manager, 111, 742);

    const delivered = eventsOfType(recorded, 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      messageId,
      eventType: 'delivered',
      provenance: 'reported',
    });
    expect(JSON.parse(delivered[0].detail as string)).toEqual({ roundTripMs: 742 });
  });

  it('records `delivered` keyed to the ORIGINAL messageId even after a retry re-keys the ack CRC', async () => {
    const { manager, recorded } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    const originalId = (manager as any).messages[0].id;
    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #1 → CRC re-keyed 111 → 222
    sendConfirmed(manager, 222);               // ack for the retry attempt

    const delivered = eventsOfType(recorded, 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].messageId).toBe(originalId);
  });

  it('records `retry` (observed, with attempt#) on each DM ack-timeout resend', async () => {
    const { manager, recorded } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    const messageId = (manager as any).messages[0].id;

    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #1
    const retries = eventsOfType(recorded, 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      messageId,
      eventType: 'retry',
      provenance: 'observed',
    });
    // First resend is attempt 2 (initial send is attempt 1).
    expect(JSON.parse(retries[0].detail as string)).toEqual({ attempt: 2 });

    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #2 → attempt 3
    expect(JSON.parse(eventsOfType(recorded, 'retry')[1].detail as string)).toEqual({ attempt: 3 });
  });

  it('records `timeout` (inferred) once when all DM retries are exhausted', async () => {
    const { manager, recorded } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    const messageId = (manager as any).messages[0].id;

    await vi.advanceTimersByTimeAsync(10_000); // same-path #1
    await vi.advanceTimersByTimeAsync(10_000); // same-path #2
    await vi.advanceTimersByTimeAsync(10_000); // flood
    await vi.advanceTimersByTimeAsync(10_000); // exhausted → failed

    const timeouts = eventsOfType(recorded, 'timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({
      messageId,
      eventType: 'timeout',
      provenance: 'inferred',
    });
  });

  it('records `retry` (attempt 1) on the one-shot channel auto-retry resend', async () => {
    const { manager, recorded } = makeManager({ channelRetryEnabled: true });

    // autoRetryOnMiss=true simulates an automated channel sender.
    await manager.sendMessage('hi', undefined, 0, undefined, true);
    const messageId = (manager as any).messages[0].id;

    await vi.advanceTimersByTimeAsync(30_000); // zero heard → one resend

    const retries = eventsOfType(recorded, 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      messageId,
      eventType: 'retry',
      provenance: 'observed',
    });
    expect(JSON.parse(retries[0].detail as string)).toEqual({ attempt: 1 });
  });

  it('records ZERO events for a RECEIVED message', async () => {
    const { manager, recorded } = makeManager();

    // @ts-expect-error - exercising private handler
    manager.handleIncomingMessage(`MSG:${'abcdef'}:hi there`);

    expect(recorded).toHaveLength(0);
  });

  it('does NOT break the send path when the recorder throws', async () => {
    const { manager, bridgeCalls } = makeManager({
      recordEventImpl: () => { throw new Error('recorder exploded'); },
    });

    const result = await manager.sendMessageWithResult('hello', PUBKEY);

    // The send still succeeded and produced exactly one message row.
    expect(result.ok).toBe(true);
    expect((manager as any).messages).toHaveLength(1);
    expect(bridgeCalls.filter(c => c.cmd === 'send_message')).toHaveLength(1);
  });

  it('does NOT break the ack path when the recorder throws', async () => {
    const { manager } = makeManager({
      recordEventImpl: () => { throw new Error('recorder exploded'); },
    });

    await manager.sendMessageWithResult('hello', PUBKEY);
    // The ack must still clear the pending-retry state despite the recorder throwing.
    expect(() => sendConfirmed(manager, 111)).not.toThrow();
    expect((manager as any).pendingDmRetries.size).toBe(0);
  });
});
