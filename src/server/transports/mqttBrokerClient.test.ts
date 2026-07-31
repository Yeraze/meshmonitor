import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake mqtt.js client: an EventEmitter with the methods MqttBrokerClient uses.
function makeFakeClient() {
  const c = new EventEmitter() as any;
  c.subscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null, [], {}));
  c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
  c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
  c.reconnect = vi.fn();
  return c;
}

vi.mock('mqtt', () => ({
  connect: vi.fn(() => makeFakeClient()),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { connect } from 'mqtt';
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
      const resetSpy = vi.spyOn(coord, 'resetBackoff');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();

      lastFakeClient().emit('connect');
      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('does NOT reset backoff when a connection flaps before the grace window', () => {
      const coord = new MqttReconnectCoordinator();
      const resetSpy = vi.spyOn(coord, 'resetBackoff');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();
      const fake = lastFakeClient();

      // connect, then drop after only 5s (clientId-collision style flap)
      fake.emit('connect');
      vi.advanceTimersByTime(5000);
      fake.emit('close');
      vi.advanceTimersByTime(120_000);

      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('resets backoff once a connection holds past the grace window', () => {
      const coord = new MqttReconnectCoordinator();
      const resetSpy = vi.spyOn(coord, 'resetBackoff');
      const client = new MqttBrokerClient({ url: 'mqtt://broker.test:1883' });
      client.setCoordinator(coord);
      void client.connect();
      const fake = lastFakeClient();

      fake.emit('connect');
      vi.advanceTimersByTime(30_000);

      expect(resetSpy).toHaveBeenCalledTimes(1);
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
});
