import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake mqtt.js client: an EventEmitter with the methods MqttBrokerClient uses.
//
// `reconnect()` mirrors mqtt.js's real `_reconnect()`: on an already-connected
// client it tears the socket down (emitting 'close') before opening a new one.
// That teardown is what made the pre-#5079 coordinator self-sustaining, so the
// fake has to reproduce it for the regression tests to mean anything.
function makeFakeClient() {
  const c = new EventEmitter() as any;
  c.isUp = false;
  c.reconnectAt = [] as number[];
  c.subscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null, [], {}));
  c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
  c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
  c.reconnect = vi.fn(() => {
    c.reconnectAt.push(Date.now());
    if (c.isUp) {
      c.isUp = false;
      c.emit('close');
    }
  });
  return c;
}

/** Simulate a CONNACK on the fake socket. */
function up(fake: any) {
  fake.isUp = true;
  fake.emit('connect');
}

/** Simulate the broker (or the network) dropping the socket. */
function down(fake: any) {
  fake.isUp = false;
  fake.emit('close');
}

const infoLines = (log: any) =>
  log.info.mock.calls.map((c: unknown[]) => String(c[0]));
const warnLines = (log: any) =>
  log.warn.mock.calls.map((c: unknown[]) => String(c[0]));

vi.mock('mqtt', () => ({
  connect: vi.fn(() => makeFakeClient()),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { connect } from 'mqtt';
import { logger } from '../../utils/logger.js';
import { MqttBrokerClient, MqttReconnectCoordinator } from './mqttBrokerClient.js';

const lastFakeClient = () => (connect as any).mock.results.at(-1).value;
const lastConnectOptions = () => (connect as any).mock.calls.at(-1)[1];

describe('MqttBrokerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a caching DNS lookup function to mqtt.connect', () => {
    const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
    void client.connect();
    expect(typeof lastConnectOptions().lookup).toBe('function');
    // and it disables mqtt.js auto-reconnect (we drive reconnects ourselves)
    expect(lastConnectOptions().reconnectPeriod).toBe(0);
  });

  describe('stability-gated backoff reset', () => {
    it('does NOT reset coordinator backoff immediately on connect', () => {
      const coord = new MqttReconnectCoordinator();
      const resetSpy = vi.spyOn(coord, 'noteStableConnection');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();

      lastFakeClient().emit('connect');
      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('does NOT reset backoff when a connection flaps before the grace window', () => {
      const coord = new MqttReconnectCoordinator();
      const resetSpy = vi.spyOn(coord, 'noteStableConnection');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();
      const fake = lastFakeClient();

      // connect, then drop after only 5s (clientId-collision style flap)
      up(fake);
      vi.advanceTimersByTime(5000);
      down(fake);
      vi.advanceTimersByTime(300_000);

      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('resets backoff once a connection holds past the grace window', () => {
      const coord = new MqttReconnectCoordinator();
      const resetSpy = vi.spyOn(coord, 'noteStableConnection');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();
      const fake = lastFakeClient();

      up(fake);
      vi.advanceTimersByTime(120_000);

      expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    it('the grace window is longer than the max backoff, so a single retry cycle cannot look "stable"', () => {
      // #5079: STABLE_RESET_MS was 30s against a 60s backoff cap, so once the
      // backoff climbed past 30s every retry trivially cleared the window and
      // knocked the throttle back to 1s — a permanent sawtooth.
      const coord = new MqttReconnectCoordinator();
      const resetSpy = vi.spyOn(coord, 'noteStableConnection');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();
      const fake = lastFakeClient();

      up(fake);
      vi.advanceTimersByTime(61_000); // longer than BACKOFF_MAX_MS
      expect(resetSpy).not.toHaveBeenCalled();
    });
  });

  describe('will + keepalive options (§3.4)', () => {
    it('forwards `will` verbatim to mqtt.connect', () => {
      const will = {
        topic: 'meshcore/test/ABCDEF/status',
        payload: Buffer.from('{"status":"offline"}'),
        qos: 0 as const,
        retain: true,
      };
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883', will });
      void client.connect();
      expect(lastConnectOptions().will).toBe(will);
    });

    it('omits `will` from connect options entirely when not supplied', () => {
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      void client.connect();
      expect('will' in lastConnectOptions()).toBe(false);
    });

    it('defaults keepalive to 15 when not supplied', () => {
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      void client.connect();
      expect(lastConnectOptions().keepalive).toBe(15);
    });

    it('honours a keepalive override', () => {
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883', keepalive: 60 });
      void client.connect();
      expect(lastConnectOptions().keepalive).toBe(60);
    });
  });

  describe('disconnect() — flush option (graceful-stop offline-status fix)', () => {
    it('defaults to an immediate forced end (existing behavior pinned)', async () => {
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      void client.connect();
      const fake = lastFakeClient();
      fake.emit('connect');

      await client.disconnect();

      expect(fake.end).toHaveBeenCalledTimes(1);
      expect(fake.end.mock.calls[0][0]).toBe(true);
    });

    it('disconnect({ flush: true }) ends non-forcefully so queued outgoing packets can flush', async () => {
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      void client.connect();
      const fake = lastFakeClient();
      fake.emit('connect');

      await client.disconnect({ flush: true });

      expect(fake.end).toHaveBeenCalledTimes(1);
      expect(fake.end.mock.calls[0][0]).toBe(false);
    });

    it('flush disconnect still resolves via the ~2s fallback if the graceful end callback never fires', async () => {
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      void client.connect();
      const fake = lastFakeClient();
      fake.emit('connect');

      // Simulate a wedged/unreachable socket: a non-forced end() never
      // invokes its callback (mqtt.js waiting on an ack that will never
      // come), but a forced end() (the fallback) does.
      fake.end.mockImplementation((force: boolean, _opts: unknown, cb?: () => void) => {
        if (force) cb?.();
      });

      let resolved = false;
      const disconnectPromise = client.disconnect({ flush: true }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      expect(resolved).toBe(false); // graceful end() callback never fired — not resolved yet

      vi.advanceTimersByTime(2000);
      await disconnectPromise;

      expect(resolved).toBe(true);
      expect(fake.end).toHaveBeenCalledTimes(2); // graceful attempt + forced fallback
      expect(fake.end.mock.calls[0][0]).toBe(false);
      expect(fake.end.mock.calls[1][0]).toBe(true);
    });
  });

  describe('MqttReconnectCoordinator backoff growth', () => {
    it('grows the shared reconnect delay geometrically while flapping (1s → 2s → 4s)', () => {
      const coord = new MqttReconnectCoordinator();
      const a = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      a.setCoordinator(coord);
      void a.connect();
      const fake = lastFakeClient();

      const delays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
        if (ms !== undefined && ms >= 500) delays.push(ms);
        return realSetTimeout(fn, ms);
      }) as any);

      // Three close events without a stable connect in between → backoff doubles.
      for (let i = 0; i < 3; i++) {
        fake.emit('close');
        vi.advanceTimersByTime(70_000); // drain the scheduled reconnect timer
      }
      spy.mockRestore();

      // Reconnect delays should be non-decreasing and span more than the 1s min.
      expect(delays.length).toBeGreaterThanOrEqual(3);
      expect(delays.at(-1)!).toBeGreaterThan(delays[0]!);
    });
  });

  // ---------------------------------------------------------------------
  // #5079 — MQTT connection storm.
  //
  // Symptom: hundreds of "📡 MQTT client connected" lines and dozens of
  // short-lived sockets to the upstream broker with climbing source ports.
  //
  // Two defects combined:
  //  1. MqttReconnectCoordinator reconnected EVERY registered client on each
  //     tick. mqtt.js's _reconnect() on a live client ends the socket and
  //     opens a new one, so one flapping pool member churned every sibling —
  //     and each forced teardown emitted 'close', which re-armed the tick.
  //     The coordinator therefore kept itself running forever after one drop.
  //  2. STABLE_RESET_MS (30s) was half BACKOFF_MAX_MS (60s), so the backoff
  //     reset to 1s the moment it grew past the grace window.
  // ---------------------------------------------------------------------
  describe('#5079 connection storm', () => {
    const URL = 'mqtt://broker.test:1883';

    function makePair() {
      const coord = new MqttReconnectCoordinator();
      const a = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      a.setCoordinator(coord);
      void a.connect();
      const fakeA = lastFakeClient();
      const b = new MqttBrokerClient({ url: URL, clientId: '!bbbbbbbb' });
      b.setCoordinator(coord);
      void b.connect();
      const fakeB = lastFakeClient();
      return { coord, a, b, fakeA, fakeB };
    }

    it('never reconnects a healthy sibling when one pool member drops', () => {
      const { fakeA, fakeB } = makePair();
      up(fakeA);
      up(fakeB);

      down(fakeB);
      vi.advanceTimersByTime(10_000); // well past the 1s first backoff

      expect(fakeB.reconnect).toHaveBeenCalledTimes(1);
      // A never dropped — churning its socket is the amplifier from #5079.
      expect(fakeA.reconnect).not.toHaveBeenCalled();
    });

    it('quiesces once the dropped client recovers (no self-sustaining loop)', () => {
      const { coord, fakeA, fakeB } = makePair();
      up(fakeA);
      up(fakeB);

      down(fakeB);
      vi.advanceTimersByTime(3000); // tick fires, B reconnects
      up(fakeB); // B comes back

      vi.advanceTimersByTime(600_000); // ten minutes of nothing happening

      expect(fakeB.reconnect).toHaveBeenCalledTimes(1);
      expect(fakeA.reconnect).not.toHaveBeenCalled();
      expect(coord.getPendingCount()).toBe(0);
    });

    it('grows the shared backoff monotonically to the 60s cap under a sustained flap', () => {
      const coord = new MqttReconnectCoordinator();
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      client.setCoordinator(coord);
      void client.connect();
      const fake = lastFakeClient();

      const delays: number[] = [];
      // Sessions of 31s: longer than the OLD 30s grace window (so the buggy
      // build reset to 1s every round) but far shorter than a genuinely
      // stable connection.
      for (let i = 0; i < 10; i++) {
        up(fake);
        vi.advanceTimersByTime(31_000);
        const closedAt = Date.now();
        down(fake);
        vi.advanceTimersByTime(90_000); // let the shared tick fire
        delays.push(fake.reconnectAt.at(-1)! - closedAt);
      }

      // First retry is prompt...
      expect(delays[0]!).toBeLessThan(1300);
      // ...then each retry is meaningfully slower than the last until the cap.
      for (let i = 1; i < 6; i++) {
        expect(delays[i]!).toBeGreaterThan(delays[i - 1]! * 1.5);
      }
      // ...and it settles at the 60s ceiling instead of snapping back to 1s.
      expect(delays.at(-1)!).toBeGreaterThan(50_000);
      expect(delays.at(-1)!).toBeLessThan(70_000);
      expect(Math.max(...delays)).toBeLessThanOrEqual(70_000);
    });

    it('logs "connected" once per state change, not once per socket', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();

      for (let i = 0; i < 12; i++) {
        up(fake);
        vi.advanceTimersByTime(800);
        down(fake);
        vi.advanceTimersByTime(200);
      }

      const connectedLines = infoLines(logger).filter((l: string) =>
        l.includes('MQTT client connected to'),
      );
      expect(connectedLines).toHaveLength(1);
    });

    it('still surfaces the storm, as a rate-limited flap summary', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();

      // ~5 minutes of flapping at ~1s per cycle.
      for (let i = 0; i < 300; i++) {
        up(fake);
        vi.advanceTimersByTime(500);
        down(fake);
        vi.advanceTimersByTime(500);
      }

      const summaries = warnLines(logger).filter((l: string) => l.includes('is flapping'));
      // A silent storm is worse than a loud one — but it must be bounded.
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.length).toBeLessThanOrEqual(6); // ≤1 per 60s window
      expect(summaries[0]).toMatch(/connects in the last/);
      expect(summaries[0]).toMatch(/Last drop:/);
    });

    it('records why the connection dropped, not just that it reconnected', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();

      up(fake);
      vi.advanceTimersByTime(700);
      down(fake);

      const reason = client.getLastCloseReason();
      expect(reason).toMatch(/700ms after CONNACK/);
      expect(reason).toMatch(/duplicate Client ID/);
      expect(warnLines(logger).some((l: string) => l.includes('dropped:'))).toBe(true);
    });

    it('attributes the drop to a client-side error when one just fired', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      client.on('error', () => {}); // EventEmitter throws on an unhandled 'error'
      void client.connect();
      const fake = lastFakeClient();

      up(fake);
      vi.advanceTimersByTime(500);
      fake.emit('error', new Error('ECONNRESET'));
      down(fake);

      expect(client.getLastCloseReason()).toMatch(/error: ECONNRESET/);
    });

    it('reports a pre-CONNACK failure distinctly from a broker eviction', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();

      down(fake); // never connected

      expect(client.getLastCloseReason()).toMatch(/before CONNACK/);
    });

    it('names the duplicate-Client-ID cause once after a run of instant evictions', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();

      for (let i = 0; i < 8; i++) {
        up(fake);
        vi.advanceTimersByTime(400);
        down(fake);
        vi.advanceTimersByTime(600);
      }

      const hints = warnLines(logger).filter((l: string) =>
        l.includes('duplicate Client ID signature'),
      );
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain('!aaaaaaaa');
    });

    it('reuses one mqtt.js client across every reconnect (no leaked instances)', () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();

      for (let i = 0; i < 20; i++) {
        up(fake);
        vi.advanceTimersByTime(1000);
        down(fake);
        vi.advanceTimersByTime(90_000);
      }

      // One mqtt.connect() for the lifetime of the wrapper; reconnects reuse it.
      expect((connect as any).mock.calls).toHaveLength(1);
      expect(lastFakeClient()).toBe(fake);
    });

    it('a healthy client does not reset the shared backoff while a sibling is still down', () => {
      const { coord, fakeA, fakeB } = makePair();
      up(fakeA);
      up(fakeB);

      // B goes down and stays down; the tick can never bring it back.
      fakeB.reconnect.mockImplementation(() => {
        fakeB.reconnectAt.push(Date.now());
        fakeB.emit('close');
      });
      down(fakeB);

      // A stays up right through its stability window.
      vi.advanceTimersByTime(200_000);

      expect(coord.getBackoffMs()).toBeGreaterThan(1000);
    });

    it('disconnect() does not arm a reconnect for a client being torn down', async () => {
      const client = new MqttBrokerClient({ url: URL, clientId: '!aaaaaaaa' });
      void client.connect();
      const fake = lastFakeClient();
      up(fake);

      fake.end.mockImplementation((_f: boolean, _o: unknown, cb?: () => void) => {
        fake.emit('close'); // mqtt.js emits close as part of end()
        cb?.();
      });
      await client.disconnect();

      vi.advanceTimersByTime(300_000);
      expect(fake.reconnect).not.toHaveBeenCalled();
    });
  });
});
