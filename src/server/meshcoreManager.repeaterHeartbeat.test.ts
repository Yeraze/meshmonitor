/**
 * MeshCore Repeater serial link health (#5563):
 *  - the port's `close` / post-open `error` events always reconnect with the
 *    normal backoff, and a manual disconnect() cancels that,
 *  - the opt-in stall probe (`heartbeatIntervalSeconds`): serial `clock`,
 *    N misses in a row close the port and reconnect,
 *  - a console that answered within the interval is not probed,
 *  - a connect whose `get name` gets no reply fails, so backoff keeps growing,
 *  - a recovered link sends no on-start advert.
 *
 * The real connect() / connectSerialDirect() path runs against a fake
 * `serialport` module: no hardware, and the real port listeners are the ones
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  /** Every port the manager constructed, oldest first. */
  ports: [] as any[],
  device: {
    /** false = the console is wedged: bytes go in, nothing comes out. */
    alive: true,
    replies: {} as Record<string, string[]>,
  },
}));

vi.mock('serialport', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeSerialPort extends EventEmitter {
    isOpen = false;
    writes: string[] = [];
    closeCalls = 0;
    parser: InstanceType<typeof EventEmitter> | null = null;
    constructor(public opts: { path: string; baudRate: number }) {
      super();
      fake.ports.push(this);
      setTimeout(() => {
        this.isOpen = true;
        this.emit('open');
      }, 1);
    }
    pipe(parser: InstanceType<typeof EventEmitter>) {
      this.parser = parser;
      return parser;
    }
    write(data: string) {
      const cmd = data.replace(/\r$/, '');
      this.writes.push(cmd);
      if (!fake.device.alive || cmd === '') return;
      const lines = [cmd, ...(fake.device.replies[cmd] ?? ['  -> Unknown command'])];
      lines.forEach((line, n) => setTimeout(() => this.parser?.emit('data', line), n + 1));
    }
    flush(cb: () => void) {
      cb();
    }
    close(cb?: () => void) {
      this.closeCalls += 1;
      this.isOpen = false;
      this.emit('close');
      cb?.();
    }
    /** The OS took the port away: USB unplug, device reset. */
    drop() {
      this.isOpen = false;
      this.emit('close');
    }
  }
  return { SerialPort: FakeSerialPort };
});

vi.mock('@serialport/parser-readline', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeReadlineParser extends EventEmitter {}
  return { ReadlineParser: FakeReadlineParser };
});

import { MeshCoreManager, ConnectionType, type MeshCoreConfig } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';

const HEALTHY_REPLIES: Record<string, string[]> = {
  'get name': ['  -> > Test Repeater'],
  'get radio': ['  -> > 910.525,62.5,7,5'],
  'get tx': ['  -> > 22'],
  'get lat': ['  -> > 0.0'],
  'get lon': ['  -> > 0.0'],
  'get public.key': [`  -> > ${'ab'.repeat(32)}`],
  clock: ['  -> 14:05 - 2/10/2026 UTC'],
  ver: ['  -> v1.17.1 (Build: 14 Aug 2026)'],
};

function config(extra: Partial<MeshCoreConfig> = {}): MeshCoreConfig {
  return {
    connectionType: ConnectionType.SERIAL,
    firmwareType: 'repeater',
    serialPort: '/dev/ttyTEST',
    ...extra,
  };
}

/** A manager with everything but the serial link and the reconnect machinery stubbed. */
function makeManager() {
  const m = new MeshCoreManager('src-hb');
  const a = m as any;
  a.refreshKnownScopes = vi.fn().mockResolvedValue(undefined);
  a.refreshChannelSecrets = vi.fn().mockResolvedValue(undefined);
  a.refreshReceiveOnly = vi.fn().mockResolvedValue(undefined);
  a.seedContactsFromDb = vi.fn().mockResolvedValue(undefined);
  a.refreshContacts = vi.fn().mockResolvedValue(undefined);
  a.startVirtualNodeServer = vi.fn().mockResolvedValue(undefined);
  a.startObserver = vi.fn().mockResolvedValue(undefined);
  a.startAutoPathfinding = vi.fn().mockResolvedValue(undefined);
  a.startAutoAnnounce = vi.fn().mockResolvedValue(undefined);
  a.startTimerTriggers = vi.fn().mockResolvedValue(undefined);
  a.applyDefaultPathHashSize = vi.fn().mockResolvedValue(undefined);
  a.distanceDeleteScheduler = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  const announce = vi.fn().mockResolvedValue({ sent: 0, total: 0 });
  a.runAutoAnnounceCycle = announce;
  const delays: number[] = [];
  m.on('reconnecting', (e: { nextDelayMs: number }) => delays.push(e.nextDelayMs));
  return { m, a, announce, delays };
}

/** connect() under fake timers: the open, the 500 ms wake and each reply are timers. */
async function connectOk(m: MeshCoreManager, cfg: MeshCoreConfig): Promise<void> {
  const p = m.connect(cfg);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await p).toBe(true);
}

/** Step fake time in 100 ms slices until `cond` holds. Fails the test if it never does. */
async function advanceUntil(cond: () => boolean, maxMs: number): Promise<void> {
  for (let t = 0; t < maxMs && !cond(); t += 100) {
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(cond()).toBe(true);
}

const allWrites = () => fake.ports.flatMap((p) => p.writes as string[]);
const state = (a: any) => a.connectionState as string;

describe('Repeater serial link health (#5563)', () => {
  let autoAnnounce: 'true' | 'false';
  let managers: MeshCoreManager[];

  beforeEach(() => {
    vi.useFakeTimers();
    fake.ports.length = 0;
    fake.device.alive = true;
    fake.device.replies = { ...HEALTHY_REPLIES };
    autoAnnounce = 'false';
    managers = [];
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(databaseService.meshcore, 'getRecentMessages').mockResolvedValue([]);
    vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(async (_s, key) =>
      key === 'meshcoreAutoAnnounceOnStart' || key === 'meshcoreAutoAnnounceEnabled' ? autoAnnounce : null,
    );
  });

  afterEach(async () => {
    for (const m of managers) await m.disconnect();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup() {
    const made = makeManager();
    managers.push(made.m);
    return made;
  }

  describe('port close / error (always on)', () => {
    it('reconnects after a `close` event with no heartbeat configured', async () => {
      const { m, a, delays } = setup();
      await connectOk(m, config());
      expect(state(a)).toBe('connected');
      expect(a.shouldReconnect).toBe(false);

      fake.ports[0].drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(state(a)).toBe('reconnecting');
      expect(m.isConnected()).toBe(false);
      expect(delays).toEqual([1000]);
      expect(fake.ports).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2500);
      expect(fake.ports).toHaveLength(2);
      expect(state(a)).toBe('connected');
      expect(m.isConnected()).toBe(true);
      expect(a.reconnectAttempts).toBe(0);
    });

    it('reconnects after an `error` event on an open port, and closes that port first', async () => {
      const { m, a } = setup();
      await connectOk(m, config());

      fake.ports[0].emit('error', new Error('EIO'));
      await vi.advanceTimersByTimeAsync(0);
      expect(state(a)).toBe('reconnecting');
      expect(fake.ports[0].closeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(2500);
      expect(fake.ports).toHaveLength(2);
      expect(state(a)).toBe('connected');
    });

    it('rejects the command in flight and stops the neighbours poll on a lost port', async () => {
      const { m, a } = setup();
      await connectOk(m, config());
      expect(a.repeaterNeighborsTimer).not.toBeNull();

      fake.device.alive = false;
      const inFlight = a.sendRepeaterCommand('ver').catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(10);
      fake.ports[0].drop();
      await vi.advanceTimersByTimeAsync(0);

      expect(await inFlight).toBe('Disconnected');
      expect(a.repeaterNeighborsTimer).toBeNull();
      expect(a.pendingCommands.size).toBe(0);
      expect(m.listenerCount('serial_data')).toBe(0);
      expect(a.serialPort).toBeNull();
    });

    it('a manual disconnect() does not reconnect', async () => {
      const { m, a, delays } = setup();
      await connectOk(m, config());

      await m.disconnect();
      expect(fake.ports[0].closeCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(state(a)).toBe('disconnected');
      expect(delays).toEqual([]);
      expect(fake.ports).toHaveLength(1);
    });

    it('a manual disconnect() cancels a reconnect that is waiting out its backoff', async () => {
      const { m, a } = setup();
      await connectOk(m, config());

      fake.ports[0].drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(state(a)).toBe('reconnecting');
      expect(a.reconnectTimer).not.toBeNull();

      await m.disconnect();
      expect(a.reconnectTimer).toBeNull();
      expect(a.linkRecoveryReconnect).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(state(a)).toBe('disconnected');
      expect(fake.ports).toHaveLength(1);
    });

    it('ignores a late `close` from a port that was already replaced', async () => {
      const { m, a, delays } = setup();
      await connectOk(m, config());
      fake.ports[0].drop();
      await vi.advanceTimersByTimeAsync(2500);
      expect(state(a)).toBe('connected');
      const before = delays.length;

      fake.ports[0].emit('close');
      await vi.advanceTimersByTimeAsync(0);

      expect(state(a)).toBe('connected');
      expect(delays).toHaveLength(before);
    });
  });

  describe('stall probe (opt-in via heartbeatIntervalSeconds)', () => {
    it('sends no probe when the heartbeat is unset', async () => {
      const { m, a } = setup();
      await connectOk(m, config());
      fake.device.alive = false;

      await vi.advanceTimersByTimeAsync(4 * 60_000);

      expect(allWrites()).not.toContain('clock');
      expect(state(a)).toBe('connected');
      expect(a.heartbeatScheduler).toBeNull();
    });

    it('three missed probes close the port, back off, and reconnect once the device answers', async () => {
      const { m, a, delays } = setup();
      await connectOk(m, config({ heartbeatIntervalSeconds: 10 }));
      const failures: number[] = [];
      m.on('heartbeat_failed', (e: { consecutiveFailures: number }) => failures.push(e.consecutiveFailures));

      fake.device.alive = false;
      // Ticks at 10 / 20 / 30 s after connect; each probe waits its 5 s timeout.
      await vi.advanceTimersByTimeAsync(26_000);
      expect(failures).toEqual([1, 2]);
      expect(state(a)).toBe('connected');
      expect(fake.ports[0].closeCalls).toBe(0);

      // The third probe may queue behind the neighbours poll, which also has
      // to wait out its own timeout on a wedged console.
      await advanceUntil(() => failures.length === 3, 20_000);
      expect(failures).toEqual([1, 2, 3]);
      expect(fake.ports[0].writes.filter((w: string) => w === 'clock')).toHaveLength(3);
      expect(fake.ports[0].closeCalls).toBe(1);
      expect(state(a)).toBe('reconnecting');
      expect(m.isConnected()).toBe(false);
      expect(delays).toEqual([1000]);

      // Still wedged: each attempt opens the port, gets nothing back from
      // `get name`, fails, and the backoff keeps doubling.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
      expect(state(a)).toBe('reconnecting');
      expect(m.isConnected()).toBe(false);
      expect(fake.ports.length).toBeGreaterThanOrEqual(3);
      // A failed attempt never leaves its port open.
      expect(fake.ports.slice(0, -1).every((p) => !p.isOpen)).toBe(true);

      fake.device.alive = true;
      await vi.advanceTimersByTimeAsync(70_000);
      expect(state(a)).toBe('connected');
      expect(m.isConnected()).toBe(true);
      expect(a.reconnectAttempts).toBe(0);
      expect(a.heartbeatConsecutiveFailures).toBe(0);
      expect(fake.ports.filter((p) => p.isOpen)).toHaveLength(1);
    });

    it('a healthy device is probed and never reconnects', async () => {
      const { m, a, delays } = setup();
      await connectOk(m, config({ heartbeatIntervalSeconds: 10 }));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(fake.ports[0].writes.filter((w: string) => w === 'clock').length).toBeGreaterThanOrEqual(5);
      expect(a.heartbeatConsecutiveFailures).toBe(0);
      expect(a.heartbeatLastSuccessAt).not.toBeNull();
      expect(delays).toEqual([]);
      expect(fake.ports).toHaveLength(1);
    });

    it('counts any `->` reply as alive, so a firmware without `clock` is not torn down', async () => {
      const { m, a, delays } = setup();
      delete fake.device.replies.clock;
      await connectOk(m, config({ heartbeatIntervalSeconds: 10 }));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(a.heartbeatConsecutiveFailures).toBe(0);
      expect(delays).toEqual([]);
    });

    it('skips the probe when a CLI reply landed within the interval', async () => {
      const { m, a } = setup();
      await connectOk(m, config({ heartbeatIntervalSeconds: 10 }));
      const clocks = () => fake.ports[0].writes.filter((w: string) => w === 'clock').length;

      // Console traffic every 4 s: always a reply newer than one interval.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(4000);
        void a.sendRepeaterCommand('ver');
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(clocks()).toBe(0);
      expect(a.heartbeatConsecutiveFailures).toBe(0);
      expect(state(a)).toBe('connected');

      // The console goes quiet: the probe resumes.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(clocks()).toBeGreaterThanOrEqual(1);
    });

    it('a busy console on a live device does not count as a stall', async () => {
      const { m, a, delays } = setup();
      await connectOk(m, config({ heartbeatIntervalSeconds: 10 }));
      // A slow multi-second command holds the CLI chain across probe ticks.
      fake.device.replies.neighbors = [];
      const failures: number[] = [];
      m.on('heartbeat_failed', (e: { consecutiveFailures: number }) => failures.push(e.consecutiveFailures));

      for (let i = 0; i < 12; i++) {
        void a.sendRepeaterCommand('ver');
        await vi.advanceTimersByTimeAsync(5000);
      }

      expect(failures).toEqual([]);
      expect(delays).toEqual([]);
      expect(state(a)).toBe('connected');
    });
  });

  describe('connect on a console that says nothing', () => {
    it('fails instead of connecting as "Unknown Repeater", and keeps backing off', async () => {
      const { m, a, delays } = setup();
      fake.device.alive = false;

      const p = m.connect(config());
      await vi.advanceTimersByTimeAsync(6000);
      expect(await p).toBe(false);

      expect(m.isConnected()).toBe(false);
      expect(state(a)).toBe('reconnecting');
      expect(a.localNode).toBeNull();
      // Only `get name` went out: the other five reads were skipped.
      expect(fake.ports[0].writes.filter((w: string) => w !== '')).toEqual(['get name']);
      expect(fake.ports[0].isOpen).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
      expect(a.reconnectAttempts).toBeGreaterThanOrEqual(4);
    });

    it('still connects when `get name` answers something unparseable', async () => {
      const { m, a } = setup();
      fake.device.replies['get name'] = ['  -> Unknown command'];

      await connectOk(m, config());

      expect(state(a)).toBe('connected');
      expect(a.localNode.name).toBe('Unknown Repeater');
    });
  });

  describe('no advert on a recovered link', () => {
    beforeEach(() => {
      autoAnnounce = 'true';
    });

    it('a normal start still fires the on-start announce (control)', async () => {
      const { m, announce } = setup();
      await connectOk(m, config());
      await vi.advanceTimersByTimeAsync(3000);

      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith('on_start');
    });

    it('a probe-driven reconnect sends no advert', async () => {
      const { m, a, announce } = setup();
      await connectOk(m, config({ heartbeatIntervalSeconds: 10 }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(announce).toHaveBeenCalledTimes(1);

      fake.device.alive = false;
      // Three missed probes, then failed reconnect attempts against the wedged
      // console: the flag must survive those.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.ports[0].closeCalls).toBe(1);
      expect(m.isConnected()).toBe(false);
      expect(a.linkRecoveryReconnect).toBe(true);
      expect(fake.ports.length).toBeGreaterThanOrEqual(3);
      fake.device.alive = true;
      await vi.advanceTimersByTimeAsync(70_000);
      expect(state(a)).toBe('connected');

      await vi.advanceTimersByTimeAsync(10_000);
      expect(announce).toHaveBeenCalledTimes(1);
      expect(a.linkRecoveryReconnect).toBe(false);
      expect(allWrites().some((w) => w.startsWith('advert'))).toBe(false);
    });

    it('a close-driven reconnect sends no advert', async () => {
      const { m, a, announce } = setup();
      await connectOk(m, config());
      await vi.advanceTimersByTimeAsync(3000);
      expect(announce).toHaveBeenCalledTimes(1);

      for (let flap = 0; flap < 3; flap++) {
        fake.ports[fake.ports.length - 1].drop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state(a)).toBe('connected');
      }

      expect(fake.ports).toHaveLength(4);
      expect(announce).toHaveBeenCalledTimes(1);
      expect(allWrites().some((w) => w.startsWith('advert'))).toBe(false);
    });

    it('a manual disconnect then connect is a real start again', async () => {
      const { m, announce } = setup();
      await connectOk(m, config());
      await vi.advanceTimersByTimeAsync(3000);
      fake.ports[0].drop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(announce).toHaveBeenCalledTimes(1);

      await m.disconnect();
      await connectOk(m, config());
      await vi.advanceTimersByTimeAsync(3000);

      expect(announce).toHaveBeenCalledTimes(2);
    });
  });
});
