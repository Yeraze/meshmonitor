/**
 * Debounced broker-link alerts (#6307 S7). Runs the REAL server-event service
 * (its first-connect and "restored only after a notified loss" state) with
 * only the broadcast edge stubbed, and a plain EventEmitter as the client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const broadcast = vi.fn().mockResolvedValue(undefined);
vi.mock('./notificationService.js', () => ({
  notificationService: { broadcastToPreferenceUsers: (...a: unknown[]) => broadcast(...a) },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { attachBrokerLinkNotifier, BROKER_LINK_GRACE_MS } from './brokerLinkNotifier.js';

let n = 0;
const GRACE = BROKER_LINK_GRACE_MS;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const bodies = () => broadcast.mock.calls.map((c) => (c[1] as { body: string }).body);

function setup() {
  n += 1;
  const client = new EventEmitter();
  const link = attachBrokerLinkNotifier(client, { sourceId: `bl-${n}`, sourceName: 'Region Feed' });
  return { client, link };
}

describe('attachBrokerLinkNotifier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    broadcast.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('uses a 120 s grace, longer than the 60 s reconnect backoff cap', () => {
    expect(GRACE).toBe(120_000);
  });

  it('the first connect is silent', async () => {
    const { client } = setup();
    client.emit('connect');
    await tick(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a close and reconnect inside the grace is silent', async () => {
    const { client } = setup();
    client.emit('connect');
    client.emit('close');
    await tick(GRACE - 1000);
    client.emit('connect');
    await tick(GRACE * 2);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('ten flaps inside the grace give zero alerts', async () => {
    const { client } = setup();
    client.emit('connect');
    for (let i = 0; i < 10; i++) {
      client.emit('close');
      client.emit('offline');
      await tick(10_000);
      client.emit('connect');
    }
    await tick(GRACE * 2);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('an outage longer than the grace gives one "lost", then one "restored"', async () => {
    const { client } = setup();
    client.emit('connect');
    client.emit('close');
    client.emit('offline'); // a second signal for the same outage
    await tick(GRACE + 1);
    expect(bodies()).toEqual(['Lost connection to the MQTT broker']);
    client.emit('connect');
    await tick(0);
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1]).toMatch(/^Connection to the MQTT broker restored/);
  });

  it('auth-stopped gives one immediate "lost" and nothing more', async () => {
    const { client } = setup();
    client.emit('connect');
    client.emit('close');
    client.emit('auth-stopped', { failures: 5 });
    await tick(0);
    expect(bodies()).toEqual(['Lost connection to the MQTT broker']);
    await tick(GRACE * 2);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('eviction-stopped gives one immediate "lost"', async () => {
    const { client } = setup();
    client.emit('connect');
    client.emit('eviction-stopped', { evictions: 3, windowMs: 60_000 });
    await tick(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('dispose() clears the timer and detaches, silently', async () => {
    const { client, link } = setup();
    client.emit('connect');
    client.emit('close');
    link.dispose();
    await tick(GRACE * 2);
    expect(broadcast).not.toHaveBeenCalled();
    for (const ev of ['connect', 'close', 'offline', 'auth-stopped', 'eviction-stopped']) {
      expect(client.listenerCount(ev)).toBe(0);
    }
    client.emit('auth-stopped', {});
    await tick(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('payloads name the source and never a broker URL', async () => {
    const { client } = setup();
    client.emit('connect');
    client.emit('auth-stopped', {});
    await tick(0);
    client.emit('connect');
    await tick(0);
    const text = JSON.stringify(broadcast.mock.calls);
    expect(text).toContain('Region Feed');
    expect(text).not.toMatch(/wss?:\/\/|mqtts?:\/\/|\.example/);
    expect(text).not.toMatch(/radio/);
  });
});
