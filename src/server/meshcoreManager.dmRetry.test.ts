/**
 * Tests for MeshCore DM auto-retry-via-flood on ack timeout (#3977).
 *
 * A DM sent on a stale cached path just goes out once today and is never
 * retried, so it silently never arrives. This automates exactly what the
 * existing "Reset Path" button already does by hand: if no `SendConfirmed`
 * ack arrives within the firmware's own `estTimeout` (+margin), reset the
 * contact's cached path and resend once via flood. The retry's own send is
 * not itself tracked — a second miss is left to the frontend's existing
 * per-message ack timer, exactly as any other unacked send today.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

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
  const sends = opts.sends ?? [{ ackCrc: 111, estTimeout: 8000 }, { ackCrc: 222, estTimeout: 8000 }];

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

    const sendCalls = bridgeCalls.filter(c => c.cmd === 'send_message');
    expect(sendCalls).toHaveLength(1);
    expect(bridgeCalls.some(c => c.cmd === 'reset_path')).toBe(false);
  });

  it('resets the path and resends once via flood when no ack arrives in time', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    // No send_confirmed dispatched — let the ack timeout (estTimeout=8000, +20% margin) fire.
    await vi.advanceTimersByTimeAsync(10_000);

    const resetCalls = bridgeCalls.filter(c => c.cmd === 'reset_path');
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0].params.public_key).toBe(PUBKEY);

    const sendCalls = bridgeCalls.filter(c => c.cmd === 'send_message');
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1].params.text).toBe('hello');
    expect(sendCalls[1].params.to).toBe(PUBKEY);
  });

  it('gives up silently if the flood retry also goes unacked (no second retry)', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // first timeout -> retry fires
    await vi.advanceTimersByTimeAsync(10_000); // retry's own timeout -> should NOT retry again

    expect(bridgeCalls.filter(c => c.cmd === 'reset_path')).toHaveLength(1);
    expect(bridgeCalls.filter(c => c.cmd === 'send_message')).toHaveLength(2);
  });

  it('does not resend when reset_path itself fails', async () => {
    const { manager, bridgeCalls } = makeManager({ resetPathOk: false });

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bridgeCalls.filter(c => c.cmd === 'reset_path')).toHaveLength(1);
    // Only the original send — the resend never fires since reset_path failed.
    expect(bridgeCalls.filter(c => c.cmd === 'send_message')).toHaveLength(1);
  });

  it('cancels the retry if the ack for the flood resend arrives', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', PUBKEY);
    await vi.advanceTimersByTimeAsync(10_000); // first timeout -> retry fires with ackCrc=222
    sendConfirmed(manager, 222);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bridgeCalls.filter(c => c.cmd === 'send_message')).toHaveLength(2);
  });

  it('does not schedule a retry for channel/broadcast sends', async () => {
    const { manager, bridgeCalls } = makeManager();

    await manager.sendMessageWithResult('hello', undefined, 0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(bridgeCalls.filter(c => c.cmd === 'send_message')).toHaveLength(1);
    expect(bridgeCalls.some(c => c.cmd === 'reset_path')).toBe(false);
  });

  it('clears pending retry timers on disconnect so a torn-down manager cannot retry', async () => {
    const { manager, bridgeCalls } = makeManager();
    vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);

    await manager.sendMessageWithResult('hello', PUBKEY);
    expect((manager as any).pendingDmRetries.size).toBe(1);

    await manager.disconnect();
    expect((manager as any).pendingDmRetries.size).toBe(0);

    const callsBefore = bridgeCalls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bridgeCalls.length).toBe(callsBefore);
  });
});
