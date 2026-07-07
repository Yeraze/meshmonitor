/**
 * Tests for MeshCore DM auto-retry on ack timeout (#3977).
 *
 * A DM sent on a stale cached path used to go out once and never retry, so it
 * silently never arrived. This replicates the official MeshCore app cadence
 * (MeshCore FAQ §5.3): on each ack timeout, resend on the CURRENT cached path
 * `DM_SAME_PATH_RETRIES` (2) times, then reset the path and resend via flood
 * `DM_FLOOD_RETRIES` (1) time, then give up and mark the message failed. The
 * whole sequence reuses the ORIGINAL message — it never creates a second bubble
 * / DB row; instead it re-points the message's tracked ack CRC via
 * `emitMeshCoreMessageUpdated` and settles on `delivered` (any ACK) or `failed`
 * (all retries exhausted).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

function makeManager(opts: {
  /** expectedAckCrc/estTimeout to hand back for each successive send_message call */
  sends?: Array<{ ackCrc: number; estTimeout: number }>;
  /** whether reset_path succeeds (default true) */
  resetPathOk?: boolean;
} = {}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts = new Map([
    ['bob'.padEnd(64, '0'), { publicKey: 'bob'.padEnd(64, '0'), advName: 'Bob' }],
  ]);

  const bridgeCalls: BridgeCall[] = [];
  let sendIdx = 0;
  // Distinct CRC per attempt so the retry sequence re-points cleanly.
  const sends = opts.sends ?? [
    { ackCrc: 111, estTimeout: 8000 },
    { ackCrc: 222, estTimeout: 8000 },
    { ackCrc: 333, estTimeout: 8000 },
    { ackCrc: 444, estTimeout: 8000 },
  ];

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'send_message') {
      // Channel/broadcast sends (no `to`) are unacked — no ackCrc/estTimeout.
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
  } as any);

  return { manager: m, bridgeCalls };
}

function sendConfirmed(m: MeshCoreManager, ackCode: number): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent({ event_type: 'send_confirmed', data: { ack_code: ackCode, round_trip_ms: 500 } });
}

const PUBKEY = 'bob'.padEnd(64, '0');
const sends = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message');
const resets = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'reset_path');

describe('MeshCoreManager — DM ack-timeout auto-retry (#3977)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not retry when the ack arrives before the timeout', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    sendConfirmed(manager, 111);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(sends(bridgeCalls)).toHaveLength(1);
    expect(resets(bridgeCalls)).toHaveLength(0);
    expect((manager as any).pendingDmRetries.size).toBe(0);
  });

  it('resends on the CURRENT path (no reset) for the first same-path retries', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);

    // First timeout -> same-path retry #1 (no reset).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(bridgeCalls)).toHaveLength(2);
    expect(resets(bridgeCalls)).toHaveLength(0);
    expect(sends(bridgeCalls)[1].params.to).toBe(PUBKEY);

    // Second timeout -> same-path retry #2 (still no reset).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(bridgeCalls)).toHaveLength(3);
    expect(resets(bridgeCalls)).toHaveLength(0);
  });

  it('falls back to flood (reset path) only after same-path retries are exhausted', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #1
    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #2
    expect(resets(bridgeCalls)).toHaveLength(0);

    // Third timeout -> path is reset and the message floods.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resets(bridgeCalls)).toHaveLength(1);
    expect(resets(bridgeCalls)[0].params.public_key).toBe(PUBKEY);
    expect(sends(bridgeCalls)).toHaveLength(4);
    expect(sends(bridgeCalls)[3].params.to).toBe(PUBKEY);
  });

  it('marks the message failed after all same-path + flood retries are exhausted', async () => {
    const { manager, bridgeCalls } = makeManager();
    const updated = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessageUpdated');

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // same-path #1
    await vi.advanceTimersByTimeAsync(10_000); // same-path #2
    await vi.advanceTimersByTimeAsync(10_000); // flood
    await vi.advanceTimersByTimeAsync(10_000); // exhausted -> failed

    // 1 initial + 2 same-path + 1 flood = 4 total, exactly one reset.
    expect(sends(bridgeCalls)).toHaveLength(4);
    expect(resets(bridgeCalls)).toHaveLength(1);

    // A terminal 'failed' status was emitted for the single message.
    const failedCalls = updated.mock.calls.filter(c => (c[0] as any).deliveryStatus === 'failed');
    expect(failedCalls).toHaveLength(1);
    expect((manager as any).pendingDmRetries.size).toBe(0);

    // No further sends after exhaustion.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sends(bridgeCalls)).toHaveLength(4);
  });

  it('keeps a SINGLE bubble: retries update the original message, never emit a new one', async () => {
    const { manager } = makeManager();
    const newMessage = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
    const updated = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessageUpdated');

    await manager.sendMessageWithResult('hello', PUBKEY);
    const originalId = (manager as any).messages[0].id;

    // Exactly one new-message emit — the original send.
    expect(newMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #1

    // Still only one new-message emit; the retry updated the original instead.
    expect(newMessage).toHaveBeenCalledTimes(1);
    // No second message row was persisted.
    expect((manager as any).messages).toHaveLength(1);

    // The update re-points the SAME message id from CRC 111 -> 222.
    const call = updated.mock.calls.at(-1)![0] as any;
    expect(call.id).toBe(originalId);
    expect(call.previousAckCrc).toBe(111);
    expect(call.expectedAckCrc).toBe(222);
    expect(call.deliveryStatus).toBe('sent');

    // The in-memory message tracks the latest attempt's CRC.
    expect((manager as any).messages[0].expectedAckCrc).toBe(222);
  });

  it('settles delivered (cancels the sequence) when a later attempt is acked', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // same-path retry #1 -> CRC 222
    sendConfirmed(manager, 222);               // ack for the retry
    await vi.advanceTimersByTimeAsync(30_000); // no further retries should fire

    expect(sends(bridgeCalls)).toHaveLength(2);
    expect((manager as any).pendingDmRetries.size).toBe(0);
  });

  it('does not resend when reset_path itself fails (flood impossible)', async () => {
    const { manager, bridgeCalls } = makeManager({ resetPathOk: false });
    const updated = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessageUpdated');

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // same-path #1
    await vi.advanceTimersByTimeAsync(10_000); // same-path #2
    await vi.advanceTimersByTimeAsync(10_000); // flood attempt -> reset_path fails

    expect(resets(bridgeCalls)).toHaveLength(1);
    // 1 initial + 2 same-path only; the flood resend never fires.
    expect(sends(bridgeCalls)).toHaveLength(3);
    // The failed flood marks the message failed.
    expect(updated.mock.calls.some(c => (c[0] as any).deliveryStatus === 'failed')).toBe(true);
  });

  it('does not schedule a retry for channel/broadcast sends', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', undefined, 0);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(sends(bridgeCalls)).toHaveLength(1);
    expect(resets(bridgeCalls)).toHaveLength(0);
    expect((manager as any).pendingDmRetries.size).toBe(0);
  });

  it('learns/persists the new path when a flood ack arrives (contact_path_updated)', async () => {
    const { manager, bridgeCalls } = makeManager();
    // schedulePathRefresh is the existing entry point that re-reads and
    // persists the firmware-learned route (debounced); assert the flood-ack
    // push still drives it (path persistence "exactly like PathUpdated").
    const refresh = vi.spyOn(manager as any, 'schedulePathRefresh').mockImplementation(() => {});

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // same-path #1
    await vi.advanceTimersByTimeAsync(10_000); // same-path #2
    await vi.advanceTimersByTimeAsync(10_000); // flood (reset + resend)
    expect(resets(bridgeCalls)).toHaveLength(1);

    // Firmware auto-emits contact_path_updated after the flood ACK teaches the
    // route; the existing handler persists it onto the contact.
    // @ts-expect-error - exercising private handler
    manager.handleBridgeEvent({
      event_type: 'contact_path_updated',
      data: { public_key: PUBKEY },
    });

    expect(refresh).toHaveBeenCalledWith(PUBKEY);
  });

  it('clears pending retry timers on disconnect mid-sequence so a torn-down manager cannot retry', async () => {
    const { manager, bridgeCalls } = makeManager();
    vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // one same-path retry, mid-sequence
    expect((manager as any).pendingDmRetries.size).toBe(1);

    await manager.disconnect();
    expect((manager as any).pendingDmRetries.size).toBe(0);

    const callsBefore = bridgeCalls.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(bridgeCalls.length).toBe(callsBefore);
  });
});
