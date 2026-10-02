/**
 * User-initiated resend of a channel message no repeater relayed (#5512).
 *
 * Runs against the real `:memory:` SQLite singleton so the parts that must
 * survive a restart (stored wire timestamp, resend events, heard repeaters)
 * are exercised through the real repositories. Only the radio
 * (`sendBridgeCommand`), the channel lookup and settings are stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { encodeGroupTextPayload } from './utils/meshcoreGroupEcho.js';
import { isMeshCoreResendError } from './errors/meshcoreResendError.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

const SELF_KEY = 'a'.repeat(64);
const SELF_NAME = 'MyNode';
const CHANNEL = 1;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const SECRET = new Uint8Array(16).map((_, i) => (i * 11 + 3) & 0xff);
const SECRET_B64 = Buffer.from(SECRET).toString('base64');

let sourceCounter = 0;
let retryEnabled = false;

function makeManager(sourceId: string): { manager: MeshCoreManager; calls: BridgeCall[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF_KEY, name: SELF_NAME };
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    return { id: '1', success: true, data: {} };
  };
  return { manager: m, calls };
}

const sends = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message');

/** Let fire-and-forget DB writes settle. Not faked by `toFake: ['Date']`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
}

async function expectRefusal(p: Promise<unknown>, code: string): Promise<any> {
  try {
    await p;
  } catch (err) {
    expect(isMeshCoreResendError(err)).toBe(true);
    expect((err as any).code).toBe(code);
    return err;
  }
  throw new Error(`expected refusal ${code}, but the resend succeeded`);
}

/** Send a channel message and return its id once its row has landed. */
async function sendOne(m: MeshCoreManager, text = 'hello mesh', autoRetryOnMiss = false): Promise<string> {
  await m.sendMessage(text, undefined, CHANNEL, undefined, autoRetryOnMiss);
  await settle();
  const msgs = (m as any).messages as Array<{ id: string; text: string }>;
  return msgs[msgs.length - 1].id;
}

/** Build the OTA echo a repeater would produce for our message. */
function echoOf(text: string, senderTimestamp: number, hops: string[]): Record<string, unknown> {
  const payloadHex = encodeGroupTextPayload(SECRET, SELF_NAME, text, senderTimestamp);
  const header = 0x01 | (0x05 << 2);
  const bytes = [header, hops.length & 0x3f, ...hops.map(h => parseInt(h, 16) & 0xff)];
  return {
    payload_type: 0x05,
    path_hops: hops,
    snr: 5,
    raw_hex: Buffer.concat([Buffer.from(bytes), Buffer.from(payloadHex, 'hex')]).toString('hex'),
  };
}

describe('MeshCoreManager.resendChannelMessage (#5512)', () => {
  let sourceId: string;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  beforeEach(() => {
    sourceId = `resend-src-${++sourceCounter}`;
    retryEnabled = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
      getChannelById: vi.fn(async (idx: number) => (idx === CHANNEL ? { id: CHANNEL, psk: SECRET_B64 } : null)),
    } as any);
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
      getSettingForSource: vi.fn(async () => null),
      setSourceSetting: vi.fn(async () => {}),
      getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => (retryEnabled ? true : def)),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stores the wire timestamp on the outgoing row', async () => {
    const { manager, calls } = makeManager(sourceId);
    const id = await sendOne(manager);
    const row = await databaseService.meshcore.getMessageForSource(id, sourceId);
    expect(row?.senderTimestamp).toBe(sends(calls)[0].params.sender_timestamp);
    expect(row?.senderTimestamp).toBe(Math.floor(T0 / 1000));
  });

  it('resends the same text on the same channel with the ORIGINAL timestamp, adding no row or message event', async () => {
    const { manager, calls } = makeManager(sourceId);
    const id = await sendOne(manager);
    const busMessage = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
    const updated = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessageUpdated');
    const localEmit = vi.spyOn(manager, 'emit');

    vi.setSystemTime(T0 + 31_000);
    const result = await manager.resendChannelMessage(id);
    await settle();

    expect(result).toEqual({ id, resendCount: 1, lastResendAt: T0 + 31_000 });
    const [first, second] = sends(calls);
    expect(second.params.text).toBe('hello mesh');
    expect(second.params.channel_idx).toBe(CHANNEL);
    expect(second.params.to).toBeFalsy();
    expect(second.params.sender_timestamp).toBe(first.params.sender_timestamp);

    expect(busMessage).not.toHaveBeenCalled();
    expect(localEmit.mock.calls.filter(c => c[0] === 'message')).toHaveLength(0);
    expect((manager as any).messages).toHaveLength(1);
    const rows = await databaseService.meshcore.getRecentMessages(50, sourceId);
    expect(rows).toHaveLength(1);
    // Never arms the automated retry.
    expect((manager as any).pendingChannelRetries.size).toBe(0);
    expect(updated).toHaveBeenCalledWith({ id, resendCount: 1, lastResendAt: T0 + 31_000 }, sourceId);

    const events = await databaseService.messageEvents.getEventsForMessage(sourceId, id);
    const retries = events.filter(e => e.eventType === 'retry');
    expect(retries).toHaveLength(1);
    expect(JSON.parse(retries[0].detail!)).toEqual({ attempt: 1, userInitiated: true });
  });

  it('credits an echo of the resend to the ORIGINAL message id', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);
    const ts = Math.floor(T0 / 1000);
    vi.setSystemTime(T0 + 31_000);
    await manager.resendChannelMessage(id);

    const pending = (manager as any).pendingChannelSends as Map<string, unknown>;
    expect([...pending.keys()]).toEqual([id]);

    await (manager as any).correlateChannelEcho(echoOf('hello mesh', ts, ['7f']));
    const heard = await databaseService.meshcore.getHeardRepeatersForMessage(id, sourceId);
    expect(heard.map(h => h.repeaterHash)).toEqual(['7f']);
    expect((manager as any).messages[0].heardBy).toHaveLength(1);
  });

  it('refuses during the 30 s cooldown after the send, with retryAfterSeconds', async () => {
    const { manager, calls } = makeManager(sourceId);
    const id = await sendOne(manager);
    vi.setSystemTime(T0 + 10_000);
    const err = await expectRefusal(manager.resendChannelMessage(id), 'RESEND_COOLDOWN');
    expect(err.retryAfterSeconds).toBe(20);
    expect(sends(calls)).toHaveLength(1);
  });

  it('refuses during the cooldown after a resend', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);
    vi.setSystemTime(T0 + 31_000);
    await manager.resendChannelMessage(id);
    vi.setSystemTime(T0 + 45_000);
    const err = await expectRefusal(manager.resendChannelMessage(id), 'RESEND_COOLDOWN');
    expect(err.retryAfterSeconds).toBe(16);
  });

  it('caps at 3 user resends', async () => {
    const { manager, calls } = makeManager(sourceId);
    const id = await sendOne(manager);
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * 31_000);
      expect((await manager.resendChannelMessage(id)).resendCount).toBe(i);
    }
    vi.setSystemTime(T0 + 4 * 31_000);
    await expectRefusal(manager.resendChannelMessage(id), 'RESEND_LIMIT');
    expect(sends(calls)).toHaveLength(4);
  });

  it('still caps at 3 when recording the resend event fails', async () => {
    const { manager, calls } = makeManager(sourceId);
    const id = await sendOne(manager);
    const record = vi.spyOn(databaseService.messageEvents, 'recordEvent').mockRejectedValue(new Error('db down'));
    try {
      for (let i = 1; i <= 3; i++) {
        vi.setSystemTime(T0 + i * 31_000);
        expect((await manager.resendChannelMessage(id)).resendCount).toBe(i);
      }
      vi.setSystemTime(T0 + 4 * 31_000);
      await expectRefusal(manager.resendChannelMessage(id), 'RESEND_LIMIT');
      // The cooldown also holds without the persisted row.
      expect(sends(calls)).toHaveLength(4);
    } finally {
      record.mockRestore();
    }
  });

  it('counts the cap and cooldown from persisted events, so a restart resets neither', async () => {
    const a = makeManager(sourceId);
    const id = await sendOne(a.manager);
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * 31_000);
      await a.manager.resendChannelMessage(id);
    }

    // A fresh manager for the same source: nothing in memory.
    const b = makeManager(sourceId);
    vi.setSystemTime(T0 + 10 * 31_000);
    await expectRefusal(b.manager.resendChannelMessage(id), 'RESEND_LIMIT');
    expect(sends(b.calls)).toHaveLength(0);

    // Its message read path carries the stored state for the UI.
    const msgs = await b.manager.getChannelMessages(CHANNEL);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id, senderTimestamp: Math.floor(T0 / 1000), resendCount: 3, lastResendAt: T0 + 3 * 31_000 });
  });

  it('keeps the cooldown across a restart', async () => {
    const a = makeManager(sourceId);
    const id = await sendOne(a.manager);
    vi.setSystemTime(T0 + 31_000);
    await a.manager.resendChannelMessage(id);

    const b = makeManager(sourceId);
    vi.setSystemTime(T0 + 40_000);
    await expectRefusal(b.manager.resendChannelMessage(id), 'RESEND_COOLDOWN');
  });

  it('refuses a message a repeater already relayed', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);
    await databaseService.meshcore.recordHeardRepeater({
      sourceId, messageId: id, repeaterHash: 'ab', repeaterName: null, snr: 4, heardAt: T0 + 1000,
    });
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage(id), 'ALREADY_HEARD');
  });

  it('refuses a message older than one hour', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);
    vi.setSystemTime(T0 + 60 * 60 * 1000 + 1);
    await expectRefusal(manager.resendChannelMessage(id), 'RESEND_TOO_OLD');
  });

  it('refuses a row with no stored timestamp (sent before migration 187)', async () => {
    const { manager } = makeManager(sourceId);
    await databaseService.meshcore.insertMessage({
      id: 'legacy-1', fromPublicKey: SELF_KEY, toPublicKey: `channel-${CHANNEL}`, text: 'old',
      timestamp: T0, createdAt: T0,
    }, sourceId);
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage('legacy-1'), 'RESEND_UNAVAILABLE');
  });

  it('refuses a received message', async () => {
    const { manager } = makeManager(sourceId);
    await databaseService.meshcore.insertMessage({
      id: 'rx-1', fromPublicKey: `channel-${CHANNEL}`, fromName: 'Bob', text: 'hi', timestamp: T0, createdAt: T0,
      senderTimestamp: Math.floor(T0 / 1000),
    }, sourceId);
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage('rx-1'), 'NOT_OWN_MESSAGE');
  });

  it('refuses a DM', async () => {
    const { manager } = makeManager(sourceId);
    await databaseService.meshcore.insertMessage({
      id: 'dm-1', fromPublicKey: SELF_KEY, toPublicKey: 'b'.repeat(64), text: 'hi', timestamp: T0, createdAt: T0,
      senderTimestamp: Math.floor(T0 / 1000),
    }, sourceId);
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage('dm-1'), 'NOT_CHANNEL_MESSAGE');
  });

  it('refuses an unknown id, and another source\'s message', async () => {
    const { manager } = makeManager(sourceId);
    const other = makeManager(`${sourceId}-other`);
    const id = await sendOne(other.manager);
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage('nope'), 'MESSAGE_NOT_FOUND');
    await expectRefusal(manager.resendChannelMessage(id), 'MESSAGE_NOT_FOUND');
  });

  it('refuses when receive-only (TX disabled) without touching the radio', async () => {
    const { manager, calls } = makeManager(sourceId);
    const id = await sendOne(manager);
    manager.setReceiveOnly(true);
    vi.setSystemTime(T0 + 31_000);
    await expect(manager.resendChannelMessage(id)).rejects.toSatisfy(isTxDisabledError);
    expect(sends(calls)).toHaveLength(1);
  });

  it('refuses when disconnected', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);
    (manager as any).connected = false;
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage(id), 'SOURCE_NOT_CONNECTED');
  });

  it('refuses while the automated echo-miss retry is pending, and flags it on read', async () => {
    retryEnabled = true;
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager, 'auto', true);
    expect((manager as any).pendingChannelRetries.has(id)).toBe(true);
    expect(manager.getRecentMessages(10)[0].autoRetryPending).toBe(true);
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage(id), 'AUTO_RETRY_PENDING');
    for (const [, r] of (manager as any).pendingChannelRetries) clearTimeout(r.timer);
  });

  it('fails cleanly when the radio rejects the resend, recording nothing', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);
    (manager as any).sendBridgeCommand = async () => ({ id: '1', success: false, error: 'busy' });
    vi.setSystemTime(T0 + 31_000);
    await expectRefusal(manager.resendChannelMessage(id), 'SEND_FAILED');
    const events = await databaseService.messageEvents.getEventsForMessage(sourceId, id);
    expect(events.filter(e => e.eventType === 'retry')).toHaveLength(0);
  });
});

describe('#3979 auto-retry credits its echo to the original message (#5512)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-registers the resend under the original id and reports the retry is no longer pending', async () => {
    vi.useFakeTimers();
    const sourceId = `resend-src-${++sourceCounter}`;
    vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
      getChannelById: vi.fn(async () => ({ id: CHANNEL, psk: SECRET_B64 })),
    } as any);
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
      getSettingForSource: vi.fn(async () => null),
      setSourceSetting: vi.fn(async () => {}),
      getSettingAsBoolean: vi.fn(async () => true),
    } as any);
    const updated = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessageUpdated');
    const { manager, calls } = makeManager(sourceId);

    await manager.sendMessage('auto', undefined, CHANNEL, undefined, true);
    const id = (manager as any).messages[0].id as string;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sends(calls)).toHaveLength(2);
    const pending = (manager as any).pendingChannelSends as Map<string, unknown>;
    expect([...pending.keys()]).toEqual([id]);
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ id, autoRetryPending: false, lastResendAt: expect.any(Number) }),
      sourceId,
    );
    expect((manager as any).messages[0].lastResendAt).toEqual(expect.any(Number));
  });
});

describe('MeshCoreManager.summarizeResends (#5512)', () => {
  it('counts only user-initiated retries but times the cooldown from any retry', () => {
    expect(MeshCoreManager.summarizeResends([
      { detail: JSON.stringify({ attempt: 1 }), timestamp: 100 },
      { detail: JSON.stringify({ attempt: 1, userInitiated: true }), timestamp: 300 },
      { detail: 'not json', timestamp: 200 },
      { detail: null, timestamp: 50 },
    ])).toEqual({ resendCount: 1, lastResendAt: 300 });
    expect(MeshCoreManager.summarizeResends([])).toEqual({ resendCount: 0, lastResendAt: null });
  });
});
