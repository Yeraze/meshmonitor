/**
 * Per-gateway publisher pool — stop one gateway after repeated rejected logins.
 *
 * Each gateway logs in with its own Client ID, and a broker can refuse one of
 * them (CONNACK 4/5) while it accepts the rest. Before this, the refused
 * gateway retried every ~60 s for ever, and mqtt.js queued every packet for it
 * without bound. Now five rejections in a row stop that gateway only; its
 * packets are dropped and counted, and the others keep publishing.
 *
 * These run the REAL `MqttBrokerClient` and `MqttReconnectCoordinator` against
 * a fake `mqtt.js`, so the fake plays the broker and the real backoff timers
 * are what is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('mqtt', () => ({
  connect: vi.fn((_url: string, opts: { clientId: string }) => {
    const c = new EventEmitter() as any;
    c.clientId = opts.clientId;
    c.subscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null, [], {}));
    c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
    c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
    c.reconnect = vi.fn();
    return c;
  }),
}));

import { connect } from 'mqtt';
import { logger } from '../utils/logger.js';
import { MqttReconnectCoordinator } from './transports/mqttBrokerClient.js';
import {
  MqttBridgePublisherPool,
  GATEWAY_AUTH_STOPPED_MESSAGE,
} from './mqttBridgePublisherPool.js';

const MAX = 5;
const BAD = 0x0000bad1;
const GOOD = 0x0000900d;
const BAD_ID = '!0000bad1';
const GOOD_ID = '!0000900d';
const USERNAME = 'pool-user-name';
const PASSWORD = 'pool-pass-word';
const BROKER_TEXT = 'Connection refused: Not authorized';

const sockets = (): any[] => (connect as any).mock.results.map((r: any) => r.value);
const socketsFor = (clientId: string) => sockets().filter((s) => s.clientId === clientId);
const lastSocketFor = (clientId: string) => socketsFor(clientId).at(-1);
/** Logins a gateway has tried: one per socket plus that socket's reconnects. */
const attemptsFor = (clientId: string) =>
  socketsFor(clientId).reduce((n, s) => n + 1 + s.reconnect.mock.calls.length, 0);

function reject(sock: any) {
  sock.emit('error', Object.assign(new Error(BROKER_TEXT), { code: 5 }));
  sock.emit('close');
}
function accept(sock: any) {
  sock.emit('connect');
}

/** Reject the current attempt, then let the shared backoff fire the next one. */
async function rejectUntilStopped(clientId: string) {
  for (let i = 0; i < MAX; i++) {
    reject(lastSocketFor(clientId));
    await vi.advanceTimersByTimeAsync(70_000); // past the 60 s cap plus jitter
  }
}

const payload = Buffer.from('packet');

describe('MqttBridgePublisherPool — auth stop per gateway', () => {
  let pool: MqttBridgePublisherPool;
  let coordinator: MqttReconnectCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    coordinator = new MqttReconnectCoordinator();
    pool = new MqttBridgePublisherPool({
      url: 'mqtts://pool-broker.example:8883',
      username: USERNAME,
      password: PASSWORD,
      poolLabel: 'bridge-under-test',
      reconnectCoordinator: coordinator,
      maxAuthFailures: MAX,
    });
  });

  afterEach(async () => {
    await pool.close();
    coordinator.dispose();
    vi.useRealTimers();
  });

  /** One accepted gateway and one the broker refuses, driven to the stop. */
  async function oneGoodOneStopped() {
    void pool.prepare(GOOD);
    void pool.prepare(BAD);
    accept(lastSocketFor(GOOD_ID));
    await rejectUntilStopped(BAD_ID);
  }

  it('stops the refused gateway after 5 rejections and makes no 6th attempt', async () => {
    await oneGoodOneStopped();

    expect(pool.getAuthStoppedGateways()).toEqual([BAD_ID]);
    expect(attemptsFor(BAD_ID)).toBe(MAX);

    // Hours later: still five. Nothing is retrying.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(attemptsFor(BAD_ID)).toBe(MAX);
    // The rejected client was closed, which is what frees mqtt.js's queue.
    expect(lastSocketFor(BAD_ID).end).toHaveBeenCalledWith(true, {}, expect.any(Function));
  });

  it('leaves the other gateways connected and publishing', async () => {
    await oneGoodOneStopped();

    const status = pool.getStatus();
    expect(status[GOOD_ID]).toMatchObject({ connected: true, authStopped: false });
    expect(lastSocketFor(GOOD_ID).end).not.toHaveBeenCalled();
    expect(attemptsFor(GOOD_ID)).toBe(1);

    await expect(pool.publish(GOOD, 'msh/t', payload)).resolves.toBe('published');
    expect(lastSocketFor(GOOD_ID).publish).toHaveBeenCalledTimes(1);
    expect(pool.getStatus()[GOOD_ID].publishes).toBe(1);
  });

  it('drops publishes for the stopped gateway: nothing reaches mqtt.js, nothing throws', async () => {
    await oneGoodOneStopped();
    const stoppedSocket = lastSocketFor(BAD_ID);
    const socketCount = sockets().length;

    for (let i = 0; i < 500; i++) {
      await expect(pool.publish(BAD, 'msh/t', payload)).resolves.toBe('dropped');
    }

    // Nothing was handed to mqtt.js, so its offline queue cannot have grown,
    // and no new client (= five more logins) was built for the gateway.
    expect(stoppedSocket.publish).not.toHaveBeenCalled();
    expect(sockets().length).toBe(socketCount);
    expect(attemptsFor(BAD_ID)).toBe(MAX);

    expect(pool.getAuthStoppedDrops()).toBe(500);
    expect(pool.getStatus()[BAD_ID]).toMatchObject({
      authStopped: true,
      connected: false,
      publishes: 0,
      droppedPublishes: 500,
    });
  });

  it('logs the drop once, not once per packet', async () => {
    await oneGoodOneStopped();
    (logger.warn as any).mockClear();

    for (let i = 0; i < 50; i++) await pool.publish(BAD, 'msh/t', payload);

    const dropLines = (logger.warn as any).mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('dropping its uplink packets'),
    );
    expect(dropLines).toHaveLength(1);
  });

  it('throws away packets queued while the logins were still failing', async () => {
    void pool.prepare(BAD);
    const sock = lastSocketFor(BAD_ID);
    // Queued by mqtt.js while the client is still trying to log in.
    await pool.publish(BAD, 'msh/t', payload);
    expect(sock.publish).toHaveBeenCalledTimes(1);

    await rejectUntilStopped(BAD_ID);
    expect(sock.end).toHaveBeenCalledWith(true, {}, expect.any(Function));

    // The restart builds a new client; the old queue is not carried over.
    expect(pool.restartAuthStopped()).toBe(1);
    accept(lastSocketFor(BAD_ID));
    expect(lastSocketFor(BAD_ID)).not.toBe(sock);
    expect(lastSocketFor(BAD_ID).publish).not.toHaveBeenCalled();
  });

  it('a successful login resets the count', async () => {
    void pool.prepare(BAD);
    for (let i = 0; i < MAX - 1; i++) {
      reject(lastSocketFor(BAD_ID));
      await vi.advanceTimersByTimeAsync(70_000);
    }
    accept(lastSocketFor(BAD_ID));
    lastSocketFor(BAD_ID).emit('close');
    await vi.advanceTimersByTimeAsync(70_000);

    // Four more rejections after the success: still under the limit.
    for (let i = 0; i < MAX - 1; i++) {
      reject(lastSocketFor(BAD_ID));
      await vi.advanceTimersByTimeAsync(70_000);
    }
    expect(pool.getAuthStoppedGateways()).toEqual([]);

    reject(lastSocketFor(BAD_ID));
    expect(pool.getAuthStoppedGateways()).toEqual([BAD_ID]);
  });

  it('other errors never stop a gateway; it keeps retrying on the backoff', async () => {
    void pool.prepare(BAD);
    for (let i = 0; i < 12; i++) {
      const sock = lastSocketFor(BAD_ID);
      sock.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      sock.emit('close');
      await vi.advanceTimersByTimeAsync(70_000);
    }
    expect(pool.getAuthStoppedGateways()).toEqual([]);
    expect(attemptsFor(BAD_ID)).toBe(13);
    // The shared backoff is still at its cap; a stop is not what slowed it.
    expect(coordinator.getBackoffMs()).toBe(60_000);
  });

  it('a stopped gateway leaves the shared reconnect timer free for the others', async () => {
    await oneGoodOneStopped();
    expect(coordinator.getPendingCount()).toBe(0);

    // The healthy gateway drops and comes back on the shared backoff.
    const good = lastSocketFor(GOOD_ID);
    good.emit('close');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(good.reconnect).toHaveBeenCalledTimes(1);
    expect(attemptsFor(BAD_ID)).toBe(MAX);
  });

  it('restart gives the stopped gateway 5 fresh attempts and leaves the rest alone', async () => {
    await oneGoodOneStopped();
    const goodSocket = lastSocketFor(GOOD_ID);

    expect(pool.restartAuthStopped()).toBe(1);
    expect(pool.getAuthStoppedGateways()).toEqual([]);
    expect(socketsFor(BAD_ID)).toHaveLength(2);
    expect(socketsFor(GOOD_ID)).toHaveLength(1);
    expect(goodSocket.end).not.toHaveBeenCalled();

    // Still refused: five more, then silence again.
    await rejectUntilStopped(BAD_ID);
    expect(pool.getAuthStoppedGateways()).toEqual([BAD_ID]);
    expect(attemptsFor(BAD_ID)).toBe(MAX * 2);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(attemptsFor(BAD_ID)).toBe(MAX * 2);
  });

  it('restart with nothing stopped does nothing', async () => {
    void pool.prepare(GOOD);
    accept(lastSocketFor(GOOD_ID));
    const before = sockets().length;

    expect(pool.restartAuthStopped()).toBe(0);
    expect(sockets().length).toBe(before);
  });

  it('status for a stopped gateway carries fixed text, not the broker reply or credentials', async () => {
    await oneGoodOneStopped();

    const entry = pool.getStatus()[BAD_ID];
    expect(entry.lastError).toBe(GATEWAY_AUTH_STOPPED_MESSAGE);
    const text = JSON.stringify(pool.getStatus());
    expect(text).not.toContain(BROKER_TEXT);
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('pool-broker.example');
  });

  it('without maxAuthFailures a gateway retries for ever, as before', async () => {
    const legacy = new MqttBridgePublisherPool({
      url: 'mqtts://pool-broker.example:8883',
      poolLabel: 'legacy',
    });
    void legacy.prepare(BAD);
    for (let i = 0; i < 8; i++) {
      reject(lastSocketFor(BAD_ID));
      await vi.advanceTimersByTimeAsync(70_000);
    }
    expect(legacy.getAuthStoppedGateways()).toEqual([]);
    expect(attemptsFor(BAD_ID)).toBe(9);
    await legacy.close();
  });
});
