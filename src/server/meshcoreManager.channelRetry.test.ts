/**
 * Tests for MeshCore AUTOMATED channel-send auto-retry on a zero-heard miss
 * (#3979 Part 2). Builds on the Part 1 echo-attribution (#3987): a channel /
 * broadcast send is an unacked fire-and-forget flood, so we can't tell delivery
 * from a firmware ACK. Instead, if NO repeater is heard re-flooding our packet
 * within CHANNEL_RETRY_WINDOW_MS (30s), the send likely reached no one, so we
 * resend it exactly ONCE.
 *
 * The feature is:
 *  - opt-in via the global `meshcoreChannelRetryEnabled` setting (default off);
 *  - armed ONLY for automated senders (which pass `autoRetryOnMiss=true`) — a
 *    user-initiated send never arms it;
 *  - one-shot — the resend never re-arms, so at most ONE retry ever fires;
 *  - self-loop-safe — the resend goes out with `isAutoRetry=true`, so it emits
 *    no `message` event and never re-enters the data bus (can't spawn a fresh
 *    automation trigger);
 *  - DISTINCT from and non-colliding with the DM ack-retry (#3977/#3980): the
 *    channel path keys on the echo-heard signal, the DM path on the firmware ACK.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

function makeManager(opts: {
  /** whether the global opt-in setting is on (default true for these tests) */
  retryEnabled?: boolean;
  /** heard-repeater set returned at the 30s mark (default [] = zero heard) */
  heardRepeaters?: Array<{ repeaterHash: string }>;
} = {}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[]; heardFn: ReturnType<typeof vi.fn> } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;

  const bridgeCalls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'send_message') {
      // Channel/broadcast sends (no `to`) are unacked — no ackCrc/estTimeout.
      if (!params.to) return { id: '1', success: true, data: {} };
      return { id: '1', success: true, data: { expectedAckCrc: 111, estTimeout: 8000 } };
    }
    return { id: '1', success: true, data: {} };
  };

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async () => null),
  } as any);

  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async () => null),
    setSourceSetting: vi.fn(async () => {}),
    getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => opts.retryEnabled ?? def ?? false),
  } as any);

  const heardFn = vi.fn(async () => opts.heardRepeaters ?? []);
  // Leave the rest of the meshcore repo real (insertMessage fails gracefully via
  // its own .catch when no DB is wired); only stub the heard-count read.
  vi.spyOn(databaseService.meshcore, 'getHeardRepeatersForMessage').mockImplementation(heardFn as any);

  return { manager: m, bridgeCalls, heardFn };
}

const sends = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message');

describe('MeshCoreManager — automated channel-send auto-retry (#3979 Part 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(a) zero repeaters heard within 30s → exactly ONE resend fires', async () => {
    const { manager, bridgeCalls } = makeManager({ retryEnabled: true, heardRepeaters: [] });

    // autoRetryOnMiss=true simulates an automated sender.
    await manager.sendMessage('hi', undefined, 0, undefined, true);
    expect(sends(bridgeCalls)).toHaveLength(1);
    expect((manager as any).pendingChannelRetries.size).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(sends(bridgeCalls)).toHaveLength(2);
    // The resend went out on the same channel (no `to`).
    expect(sends(bridgeCalls)[1].params.to).toBeFalsy();
    expect(sends(bridgeCalls)[1].params.channel_idx).toBe(0);
    expect((manager as any).pendingChannelRetries.size).toBe(0);
  });

  it('(b) at least one repeater heard within 30s → NO resend', async () => {
    const { manager, bridgeCalls } = makeManager({
      retryEnabled: true,
      heardRepeaters: [{ repeaterHash: 'ab' }],
    });

    await manager.sendMessage('hi', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sends(bridgeCalls)).toHaveLength(1);
    expect((manager as any).pendingChannelRetries.size).toBe(0);
  });

  it('(c) the resend emits NO message event (cannot re-enter the automation bus)', async () => {
    const { manager, bridgeCalls } = makeManager({ retryEnabled: true, heardRepeaters: [] });
    const busEmit = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
    const localEmit = vi.spyOn(manager, 'emit');

    await manager.sendMessage('hi', undefined, 0, undefined, true);
    // Initial send emits exactly once onto the bus + the local emitter.
    expect(busEmit).toHaveBeenCalledTimes(1);
    const localMessageEmitsAfterInitial = localEmit.mock.calls.filter(c => c[0] === 'message').length;
    expect(localMessageEmitsAfterInitial).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);

    // The resend fired on the wire...
    expect(sends(bridgeCalls)).toHaveLength(2);
    // ...but did NOT re-emit onto the data bus (no second automation trigger)...
    expect(busEmit).toHaveBeenCalledTimes(1);
    // ...nor onto the local emitter, and created no second message row.
    const localMessageEmits = localEmit.mock.calls.filter(c => c[0] === 'message').length;
    expect(localMessageEmits).toBe(1);
    expect((manager as any).messages).toHaveLength(1);
  });

  it('(d) only ONE retry ever — a resend that also hears zero repeaters does not retry again', async () => {
    const { manager, bridgeCalls } = makeManager({ retryEnabled: true, heardRepeaters: [] });

    await manager.sendMessage('hi', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(30_000); // resend #1
    expect(sends(bridgeCalls)).toHaveLength(2);
    expect((manager as any).pendingChannelRetries.size).toBe(0);

    // Even though the resend also heard zero repeaters, no further retry is armed.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends(bridgeCalls)).toHaveLength(2);
  });

  it('(e) a user-initiated send never arms a retry (autoRetryOnMiss defaults false)', async () => {
    const { manager, bridgeCalls } = makeManager({ retryEnabled: true, heardRepeaters: [] });

    // No 5th arg → user-initiated path (as meshcoreRoutes.ts calls it).
    await manager.sendMessage('hi', undefined, 0);
    expect((manager as any).pendingChannelRetries.size).toBe(0);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(sends(bridgeCalls)).toHaveLength(1);
  });

  it('(f) setting OFF → an automated send never arms a retry', async () => {
    const { manager, bridgeCalls } = makeManager({ retryEnabled: false, heardRepeaters: [] });

    await manager.sendMessage('hi', undefined, 0, undefined, true);
    expect((manager as any).pendingChannelRetries.size).toBe(0);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(sends(bridgeCalls)).toHaveLength(1);
  });

  it('(g) disconnect mid-window clears the pending retry so a torn-down manager cannot resend', async () => {
    const { manager, bridgeCalls } = makeManager({ retryEnabled: true, heardRepeaters: [] });
    vi.spyOn(manager as any, 'stopVirtualNodeServer').mockResolvedValue(undefined);

    await manager.sendMessage('hi', undefined, 0, undefined, true);
    await vi.advanceTimersByTimeAsync(10_000); // mid-window
    expect((manager as any).pendingChannelRetries.size).toBe(1);

    await manager.disconnect();
    expect((manager as any).pendingChannelRetries.size).toBe(0);

    const callsBefore = bridgeCalls.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(bridgeCalls.length).toBe(callsBefore);
  });

  it('does not arm a channel retry for a DM send (mutually exclusive with the DM machine)', async () => {
    const { manager } = makeManager({ retryEnabled: true, heardRepeaters: [] });
    const PUBKEY = 'bob'.padEnd(64, '0');
    (manager as any).contacts = new Map([[PUBKEY, { publicKey: PUBKEY, advName: 'Bob' }]]);

    // A DM send with the automated flag set: the channel machine must not arm
    // (no channelIdx / toPublicKey present); the DM ack-retry machine handles it.
    await manager.sendMessage('hi', PUBKEY, undefined, undefined, true);

    expect((manager as any).pendingChannelRetries.size).toBe(0);
    expect((manager as any).pendingDmRetries.size).toBe(1);
  });
});
