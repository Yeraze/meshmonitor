/**
 * MeshCore Auto Welcome send path (#6224, 4.17.3 review H1/L4): the hourly cap
 * must hold against a burst of new contacts inside one pre-send delay window,
 * a welcome must re-check its decision at send time, and pending welcomes must
 * end with the link. Also the split-timer floor at arm time (L2) and the
 * in-memory message pool on duplicate inserts (L11).
 *
 * Runs against the real `:memory:` database. sendMessage is stubbed, so
 * nothing transmits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, type MeshCoreContact, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { SPLIT_TIMER_MIN_INTERVAL_MINUTES } from '../utils/messageSplitLimits.js';

const SRC = 'src-autowelcome-cap';

type Internals = {
  checkAutoWelcome: (c: MeshCoreContact) => Promise<void>;
  cancelPendingAutoWelcomes: () => void;
  flushPendingNewNodeNotifications: () => void;
  notifyNewNodeDiscovered: (c: MeshCoreContact) => Promise<void>;
  armTimerTrigger: (t: unknown) => void;
  addMessage: (m: MeshCoreMessage) => Promise<boolean>;
  autoWelcomeTimers: Map<string, unknown>;
  autoWelcomeReserved: number;
  pendingNewNodeNotifications: Set<string>;
  newNodeNotifySuppressed: boolean;
  contacts: Map<string, MeshCoreContact>;
  messages: MeshCoreMessage[];
  timerTriggerIntervals: Map<string, unknown>;
};

const keyOf = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
const contact = (i: number, over: Partial<MeshCoreContact> = {}): MeshCoreContact =>
  ({ publicKey: keyOf(i), advName: `Node${i}`, advType: 1, ...over }) as MeshCoreContact;

async function setWelcome(over: Record<string, string> = {}) {
  const values: Record<string, string> = {
    meshcoreAutoWelcomeEnabled: 'true',
    meshcoreAutoWelcomeTarget: 'dm',
    meshcoreAutoWelcomeDelaySeconds: '30',
    meshcoreAutoWelcomeMaxPerHour: '6',
    meshcoreAutoWelcomeWelcomed: '[]',
    meshcoreAutoWelcomeSendTimes: '[]',
    ...over,
  };
  for (const [k, v] of Object.entries(values)) {
    await databaseService.settings.setSourceSetting(SRC, k, v);
  }
}

const sendTimes = async () =>
  JSON.parse((await databaseService.settings.getSettingForSource(SRC, 'meshcoreAutoWelcomeSendTimes')) || '[]') as number[];

describe('MeshCore Auto Welcome send path', () => {
  let m: MeshCoreManager;
  let i: Internals;
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await setWelcome();
    m = new MeshCoreManager(SRC);
    i = m as unknown as Internals;
    sendSpy = vi.spyOn(m, 'sendMessage').mockResolvedValue(true);
  });

  afterEach(() => {
    i.cancelPendingAutoWelcomes();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('10 new contacts in one delay window schedule at most 6 welcomes (drop, not queue)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, n) => i.checkAutoWelcome(contact(n + 1))));
    expect(i.autoWelcomeTimers.size).toBe(6);
    expect(i.autoWelcomeReserved).toBe(6);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(i.autoWelcomeReserved).toBe(0));
    expect(sendSpy).toHaveBeenCalledTimes(6);
    expect(await sendTimes()).toHaveLength(6);

    // The four dropped contacts were not queued: nothing more goes out.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sendSpy).toHaveBeenCalledTimes(6);
  });

  it('disabling the feature during the delay sends nothing and frees the slots', async () => {
    await Promise.all([1, 2, 3].map((n) => i.checkAutoWelcome(contact(n))));
    expect(i.autoWelcomeTimers.size).toBe(3);

    await databaseService.settings.setSourceSetting(SRC, 'meshcoreAutoWelcomeEnabled', 'false');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(i.autoWelcomeReserved).toBe(0));
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await sendTimes()).toHaveLength(0);
  });

  it('a send-time re-check drops a key welcomed elsewhere during the delay', async () => {
    await i.checkAutoWelcome(contact(7));
    await databaseService.settings.setSourceSetting(SRC, 'meshcoreAutoWelcomeWelcomed', JSON.stringify([keyOf(7)]));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(i.autoWelcomeReserved).toBe(0));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('a disconnect cancels welcomes still waiting out the delay', async () => {
    await Promise.all([1, 2].map((n) => i.checkAutoWelcome(contact(n))));
    expect(i.autoWelcomeTimers.size).toBe(2);
    i.cancelPendingAutoWelcomes();
    expect(i.autoWelcomeTimers.size).toBe(0);
    expect(i.autoWelcomeReserved).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('counts recorded sends from earlier in the hour against the cap', async () => {
    const recent = Date.now() - 60_000;
    await setWelcome({ meshcoreAutoWelcomeSendTimes: JSON.stringify([recent, recent, recent, recent]) });
    await Promise.all([1, 2, 3, 4].map((n) => i.checkAutoWelcome(contact(n))));
    expect(i.autoWelcomeTimers.size).toBe(2);
  });

  it.each([
    ['Repeater', 2],
    ['Room Server', 3],
    ['Sensor', 4],
  ])('never greets a %s', async (_label, advType) => {
    await i.checkAutoWelcome(contact(9, { advType }));
    expect(i.autoWelcomeTimers.size).toBe(0);
    expect(i.autoWelcomeReserved).toBe(0);
  });

  it('re-checks the contact at send time: a type learned during the delay is honoured', async () => {
    const c = contact(13, { advType: undefined });
    i.contacts.set(c.publicKey, c);
    await i.checkAutoWelcome(c);
    expect(i.autoWelcomeTimers.size).toBe(1);
    i.contacts.set(c.publicKey, { ...c, advType: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(i.autoWelcomeReserved).toBe(0));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('greets a Companion and a contact of unknown type', async () => {
    await i.checkAutoWelcome(contact(10, { advType: 1 }));
    await i.checkAutoWelcome(contact(11, { advType: undefined }));
    expect(i.autoWelcomeTimers.size).toBe(2);
  });

  it('the pending-name flush stays quiet while new-node alerts are suppressed', async () => {
    const notifySpy = vi.spyOn(i, 'notifyNewNodeDiscovered').mockResolvedValue(undefined);
    const c = contact(12);
    i.contacts.set(c.publicKey, c);
    i.pendingNewNodeNotifications.add(c.publicKey);

    i.newNodeNotifySuppressed = true;
    i.flushPendingNewNodeNotifications();
    expect(notifySpy).not.toHaveBeenCalled();
    expect(i.pendingNewNodeNotifications.has(c.publicKey)).toBe(true);

    i.newNodeNotifySuppressed = false;
    i.flushPendingNewNodeNotifications();
    expect(notifySpy).toHaveBeenCalledWith(c);
  });
});

describe('MeshCore split timer floor at arm time (L2)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('raises a split interval timer below the floor to the floor', () => {
    const m = new MeshCoreManager(SRC);
    const i = m as unknown as Internals;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    i.armTimerTrigger({ id: 't1', name: 'fast', enabled: true, scheduleType: 'interval', intervalMinutes: 1, multiline: true, responseType: 'text' });
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), SPLIT_TIMER_MIN_INTERVAL_MINUTES * 60_000);
    clearInterval(i.timerTriggerIntervals.get('t1') as ReturnType<typeof setInterval>);
  });

  it('leaves a non-split interval timer at its own interval', () => {
    const m = new MeshCoreManager(SRC);
    const i = m as unknown as Internals;
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    i.armTimerTrigger({ id: 't2', name: 'plain', enabled: true, scheduleType: 'interval', intervalMinutes: 1, multiline: false, responseType: 'text' });
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    clearInterval(i.timerTriggerIntervals.get('t2') as ReturnType<typeof setInterval>);
  });

  it('skips split cron fires closer together than the floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    const m = new MeshCoreManager(SRC);
    const i = m as unknown as Internals;
    vi.spyOn(m, 'canTransmit').mockReturnValue(true);
    const runSpy = vi.spyOn(m, 'runTimerTrigger').mockResolvedValue({ ok: true });
    i.armTimerTrigger({ id: 't3', name: 'cron', enabled: true, scheduleType: 'cron', cronExpression: '* * * * *', multiline: true, responseType: 'text' });

    // Arming is not a fire: nothing goes out in the first 5 minutes.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();
    // Every-minute cron over the next 6 minutes: one fire (00:06), then the floor.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    m.stopTimerTriggers();
  });
});

describe('MeshCore message pool on duplicate inserts (L11)', () => {
  const msg = (id: string): MeshCoreMessage =>
    ({ id, fromPublicKey: 'cd'.repeat(32), text: 'room post', timestamp: 1_800_000_000, messageType: 'room_post' }) as MeshCoreMessage;

  beforeEach(async () => {
    await databaseService.meshcore.deleteAllMessagesForSource(SRC);
  });

  it('a re-synced room post does not grow a second pool entry', async () => {
    const m = new MeshCoreManager(SRC);
    const i = m as unknown as Internals;
    expect(await i.addMessage(msg('room-dup-1'))).toBe(true);
    expect(await i.addMessage(msg('room-dup-1'))).toBe(false);
    expect(i.messages.filter((x) => x.id === 'room-dup-1')).toHaveLength(1);
  });

  it('drops the pooled copy when the row already existed in the database', async () => {
    const first = new MeshCoreManager(SRC);
    expect(await (first as unknown as Internals).addMessage(msg('room-dup-2'))).toBe(true);

    // A fresh manager (e.g. after a restart) has an empty pool but the row exists.
    const m = new MeshCoreManager(SRC);
    const i = m as unknown as Internals;
    expect(await i.addMessage(msg('room-dup-2'))).toBe(false);
    expect(i.messages.some((x) => x.id === 'room-dup-2')).toBe(false);
  });
});
