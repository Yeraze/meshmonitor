/**
 * Auto Resend until the Required Repeater(s) hear it (#6240).
 *
 * Real `:memory:` SQLite for messages, `retry` events and heard repeaters, so
 * the shared persisted count is exercised for real. Only the radio
 * (`sendBridgeCommand`), the channel lookup and settings are stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

const SELF_KEY = 'a'.repeat(64);
const CHANNEL = 1;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
const REQ = 'bb'.repeat(32);
const OTHER = 'cc'.repeat(32);
const SECRET_B64 = Buffer.from(new Uint8Array(16).map((_, i) => (i * 11 + 3) & 0xff)).toString('base64');

let sourceCounter = 0;
let autoResend: string | null = null;
let requiredList: string | null = null;
let retryEnabled = false;

function makeManager(sourceId: string): { manager: MeshCoreManager; calls: BridgeCall[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF_KEY, name: 'MyNode' };
  (m as any).contacts.set(REQ, { publicKey: REQ, advType: MeshCoreDeviceType.REPEATER });
  (m as any).contacts.set(OTHER, { publicKey: OTHER, advType: MeshCoreDeviceType.REPEATER });
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    return { id: '1', success: true, data: {} };
  };
  return { manager: m, calls };
}

const sends = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message');

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
}

/** Advance fake time and let the async timer bodies finish. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

async function sendOne(m: MeshCoreManager, text = 'hello mesh', autoRetryOnMiss = false): Promise<string> {
  await m.sendMessage(text, undefined, CHANNEL, undefined, autoRetryOnMiss);
  await settle();
  const msgs = (m as any).messages as Array<{ id: string }>;
  return msgs[msgs.length - 1].id;
}

async function retryEvents(sourceId: string, id: string) {
  const events = await databaseService.messageEvents.getEventsForMessage(sourceId, id);
  return events.filter(e => e.eventType === 'retry').map(e => JSON.parse(e.detail!));
}

describe('MeshCoreManager Auto Resend (#6240)', () => {
  let sourceId: string;
  const managers: MeshCoreManager[] = [];
  const make = (src: string) => {
    const r = makeManager(src);
    managers.push(r.manager);
    return r;
  };

  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  beforeEach(() => {
    sourceId = `auto-resend-src-${++sourceCounter}`;
    autoResend = 'true';
    requiredList = JSON.stringify([REQ]);
    retryEnabled = false;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(T0);
    vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
      getChannelById: vi.fn(async (idx: number) => (idx === CHANNEL ? { id: CHANNEL, psk: SECRET_B64 } : null)),
    } as any);
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
      getSettingForSource: vi.fn(async (_src: string, key: string) => {
        if (key === 'meshcoreAutoResendEnabled') return autoResend;
        if (key === 'meshcoreRequiredRepeaters') return requiredList;
        if (key === 'meshcoreRequiredRepeaterMode') return 'any';
        return null;
      }),
      setSourceSetting: vi.fn(async () => {}),
      getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => (retryEnabled ? true : def)),
    } as any);
  });

  afterEach(() => {
    for (const m of managers.splice(0)) (m as any).clearAutoResendTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is off unless the toggle is on', async () => {
    autoResend = null;
    const { manager, calls } = make(sourceId);
    await sendOne(manager);
    await advance(10 * 60_000);
    expect(sends(calls)).toHaveLength(1);
  });

  it('does nothing while the Required Repeater(s) list is empty, even with the toggle on', async () => {
    requiredList = null;
    const { manager, calls } = make(sourceId);
    await sendOne(manager);
    await advance(10 * 60_000);
    expect(sends(calls)).toHaveLength(1);
  });

  it('resends every 30 s, at most 3 times, with the original timestamp, and records auto retry events', async () => {
    const { manager, calls } = make(sourceId);
    const id = await sendOne(manager);
    await advance(29_000);
    expect(sends(calls)).toHaveLength(1);
    await advance(1_000);
    expect(sends(calls)).toHaveLength(2);
    await advance(30_000);
    await advance(30_000);
    expect(sends(calls)).toHaveLength(4);
    await advance(30 * 60_000);
    expect(sends(calls)).toHaveLength(4);
    const ts = sends(calls)[0].params.sender_timestamp;
    expect(sends(calls).every(c => c.params.sender_timestamp === ts)).toBe(true);
    expect(await retryEvents(sourceId, id)).toEqual([
      { attempt: 1, auto: true }, { attempt: 2, auto: true }, { attempt: 3, auto: true },
    ]);
  });

  it('stops once a required repeater is heard', async () => {
    const { manager, calls } = make(sourceId);
    const id = await sendOne(manager);
    await advance(30_000);
    expect(sends(calls)).toHaveLength(2);
    await databaseService.meshcore.recordHeardRepeater({
      sourceId, messageId: id, repeaterHash: 'bb', repeaterName: null, snr: 4, heardAt: Date.now(),
    });
    await advance(5 * 60_000);
    expect(sends(calls)).toHaveLength(2);
  });

  it('keeps resending when only a repeater NOT on the list relayed it', async () => {
    const { manager, calls } = make(sourceId);
    const id = await sendOne(manager);
    await databaseService.meshcore.recordHeardRepeater({
      sourceId, messageId: id, repeaterHash: 'cc', repeaterName: null, snr: 4, heardAt: T0 + 1000,
    });
    await advance(30_000);
    expect(sends(calls)).toHaveLength(2);
  });

  it('shares the 3-per-message cap with manual resends', async () => {
    autoResend = null; // send with Auto Resend off, resend twice by hand
    const { manager, calls } = make(sourceId);
    const id = await sendOne(manager);
    vi.setSystemTime(T0 + 31_000);
    await manager.resendChannelMessage(id);
    vi.setSystemTime(T0 + 62_000);
    await manager.resendChannelMessage(id);
    expect(sends(calls)).toHaveLength(3);

    // Turning it on and reconnecting leaves room for exactly one auto copy.
    autoResend = 'true';
    await (manager as any).armAutoResendForRecentSends();
    await advance(10 * 60_000);
    expect(sends(calls)).toHaveLength(4);
  });

  it('turning the toggle off stops resends already scheduled', async () => {
    const { manager, calls } = make(sourceId);
    await sendOne(manager);
    await advance(30_000);
    expect(sends(calls)).toHaveLength(2);
    autoResend = 'false';
    await advance(5 * 60_000);
    expect(sends(calls)).toHaveLength(2);
  });

  it('a restart re-arms recent sends but never goes past 3 copies in total', async () => {
    const first = make(sourceId);
    const id = await sendOne(first.manager);
    await advance(30_000);
    await advance(30_000);
    expect(sends(first.calls)).toHaveLength(3); // original + 2 auto
    (first.manager as any).clearAutoResendTimers(); // the process dies

    const second = make(sourceId);
    await (second.manager as any).armAutoResendForRecentSends();
    await advance(10 * 60_000);
    expect(sends(second.calls)).toHaveLength(1);
    expect(await retryEvents(sourceId, id)).toHaveLength(3);
  });

  it('a restart does not send before the cooldown after the last copy', async () => {
    const first = make(sourceId);
    await sendOne(first.manager);
    await advance(30_000); // auto copy at T0+30s
    (first.manager as any).clearAutoResendTimers();

    await advance(5_000);
    const second = make(sourceId);
    await (second.manager as any).armAutoResendForRecentSends();
    await advance(24_000); // T0+59s: cooldown runs to T0+60s
    expect(sends(second.calls)).toHaveLength(0);
    await advance(10_000);
    expect(sends(second.calls)).toHaveLength(1);
  });

  it('pauses the channel for an hour once a message uses all 3 with the rule unmet; manual Resend still works', async () => {
    const { manager, calls } = make(sourceId);
    await sendOne(manager);
    await advance(30_000);
    await advance(30_000);
    await advance(30_000);
    expect(sends(calls)).toHaveLength(4);
    await advance(30_000); // echo window after the last copy: pause set

    const next = await sendOne(manager, 'second message');
    await advance(5 * 60_000);
    expect(sends(calls)).toHaveLength(5); // no auto copy of the second message

    await manager.resendChannelMessage(next);
    expect(sends(calls)).toHaveLength(6);

    await advance(60 * 60_000); // pause over
    const third = await sendOne(manager, 'third message');
    await advance(30_000);
    expect(sends(calls).filter(c => c.params.text === 'third message')).toHaveLength(2);
    expect(third).toBeTruthy();
  });

  it('waits while a DM is still in its ack-retry cascade', async () => {
    const { manager, calls } = make(sourceId);
    const peer = 'd'.repeat(64);
    await manager.sendMessage('hi there', peer);
    await settle();
    const msgs = (manager as any).messages as Array<{ id: string }>;
    const id = msgs[msgs.length - 1].id;
    const timer = setTimeout(() => {}, 1e9);
    (manager as any).pendingDmRetries.set(4242, { messageId: id, timer });
    await advance(30_000);
    expect(sends(calls)).toHaveLength(1);

    (manager as any).pendingDmRetries.delete(4242);
    clearTimeout(timer);
    await advance(30_000);
    expect(sends(calls)).toHaveLength(2);
    expect(sends(calls)[1].params.to).toBe(peer);
  });

  it('does not also arm the one-shot #3979 retry for a message it covers', async () => {
    retryEnabled = true;
    const { manager } = make(sourceId);
    await sendOne(manager, 'automated', true);
    expect((manager as any).pendingChannelRetries.size).toBe(0);
    expect((manager as any).autoResendTimers.size).toBe(1);
  });

  it('a disconnect clears pending Auto Resend timers', async () => {
    const { manager, calls } = make(sourceId);
    await sendOne(manager);
    expect((manager as any).autoResendTimers.size).toBe(1);
    await manager.disconnect({ userInitiated: true });
    expect((manager as any).autoResendTimers.size).toBe(0);
    await advance(5 * 60_000);
    expect(sends(calls)).toHaveLength(1);
  });
});
