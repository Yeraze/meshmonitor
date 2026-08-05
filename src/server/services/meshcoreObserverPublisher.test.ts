/**
 * meshcoreObserverPublisher tests (#4457 Phase 2, WP4 — spec §7.2).
 *
 * Mocks the 'mqtt' module per §1.10 (same pattern as
 * `transports/mqttBrokerClient.test.ts`) and drives the REAL
 * `MqttBrokerClient` underneath — only `mintToken` is injected. This lets
 * these tests exercise the real connect-options wiring (LWT, keepalive,
 * username/password) exactly as `MqttBrokerClient` builds them.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { EventEmitter } from 'events';

type SubscribeCallback = (
  err: Error | null,
  granted: Array<{ topic: string; qos: number }>,
  packet: unknown,
) => void;
type PublishCallback = (err?: Error) => void;
type EndCallback = () => void;
type PublishOpts = { qos: number; retain: boolean };
type SubscribeOpts = { qos: number };
type EndOpts = Record<string, never>;

interface FakeMqttClient extends EventEmitter {
  subscribe: MockedFunction<(topics: string[], opts: SubscribeOpts, cb?: SubscribeCallback) => void>;
  publish: MockedFunction<(topic: string, payload: Buffer, opts: PublishOpts, cb?: PublishCallback) => void>;
  end: MockedFunction<(force: boolean, opts: EndOpts, cb?: EndCallback) => void>;
  reconnect: MockedFunction<() => void>;
}

// Fake mqtt.js client: an EventEmitter with the methods MqttBrokerClient uses.
function makeFakeClient(): FakeMqttClient {
  const c = new EventEmitter() as FakeMqttClient;
  c.subscribe = vi.fn((_topics: string[], _opts: SubscribeOpts, cb?: SubscribeCallback) => {
    cb?.(null, [], {});
  }) as FakeMqttClient['subscribe'];
  c.publish = vi.fn((_topic: string, _payload: Buffer, _opts: PublishOpts, cb?: PublishCallback) => {
    cb?.();
  }) as FakeMqttClient['publish'];
  c.end = vi.fn((_force: boolean, _opts: EndOpts, cb?: EndCallback) => {
    cb?.();
  }) as FakeMqttClient['end'];
  c.reconnect = vi.fn() as FakeMqttClient['reconnect'];
  return c;
}

vi.mock('mqtt', () => ({
  connect: vi.fn(() => makeFakeClient()),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { connect } from 'mqtt';
import {
  MeshCoreObserverPublisher,
  RENEWAL_CHECK_MS,
  RENEWAL_THRESHOLD_S,
  MAX_AUTH_FAILURES,
  STATUS_REFRESH_MS,
  type MeshCoreObserverPublisherOptions,
} from './meshcoreObserverPublisher.js';
import { buildObserverPacketPayload } from './meshcoreObserverPacket.js';
import type { ObserverToken, ObserverTokenResult } from './meshcoreObserverToken.js';
import type { OtaPacketEvent } from '../meshcoreVirtualNodeServer.js';

const mockConnect = connect as MockedFunction<typeof connect>;
const lastFakeClient = (): FakeMqttClient => mockConnect.mock.results.at(-1)!.value as FakeMqttClient;
const lastConnectOptions = () => mockConnect.mock.calls.at(-1)![1];

const SOURCE_ID = 'src-observer-1';
const PUBKEY = 'AB'.repeat(32); // 64 hex chars
const TOKEN_STRING = 'headerpart1234567890abcdef.payloadpart1234567890abcdef.' + 'a'.repeat(128);

function makeToken(overrides: Partial<ObserverToken> = {}): ObserverToken {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    token: TOKEN_STRING,
    publicKey: PUBKEY,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 86_400,
    ...overrides,
  };
}

function makeConfig(): MeshCoreObserverPublisherOptions['config'] {
  return {
    enabled: true,
    brokerUrl: 'mqtt://broker.test:1883',
    iataCode: 'TEST',
    tokenAudience: 'aud.test',
  };
}

function makeDevice(): MeshCoreObserverPublisherOptions['device'] {
  return () => ({
    origin: 'MyNode',
    model: 'ModelX',
    firmwareVersion: 'v1.16.1',
    radio: '915,250,7,5',
  });
}

function makeMintToken(
  ...results: ObserverTokenResult[]
): MockedFunction<(sourceId: string) => Promise<ObserverTokenResult>> {
  const fn = vi.fn() as MockedFunction<(sourceId: string) => Promise<ObserverTokenResult>>;
  for (const r of results) fn.mockResolvedValueOnce(r);
  return fn;
}

function makeMintTokenAlwaysOk(
  token: ObserverToken = makeToken(),
): MockedFunction<(sourceId: string) => Promise<ObserverTokenResult>> {
  const fn = vi.fn() as MockedFunction<(sourceId: string) => Promise<ObserverTokenResult>>;
  fn.mockResolvedValue({ kind: 'ok', token });
  return fn;
}

function makePublisher(
  mintToken: MockedFunction<(sourceId: string) => Promise<ObserverTokenResult>> = makeMintTokenAlwaysOk(),
  sourceId: string = SOURCE_ID,
  extra: Partial<MeshCoreObserverPublisherOptions> = {},
): { publisher: MeshCoreObserverPublisher; mintToken: typeof mintToken } {
  const publisher = new MeshCoreObserverPublisher({
    sourceId,
    config: makeConfig(),
    device: makeDevice(),
    mintToken,
    ...extra,
  });
  return { publisher, mintToken };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Starts the publisher, flushes to the point the client is created, then fires
 * 'connect'. The trailing flush covers the online-status publish, which is
 * async since #4556 (it awaits the device-stats read before publishing).
 */
async function startAndConnect(publisher: MeshCoreObserverPublisher): Promise<FakeMqttClient> {
  const startPromise = publisher.start();
  await flushMicrotasks(3);
  const client = lastFakeClient();
  client.emit('connect');
  await startPromise;
  await flushMicrotasks();
  return client;
}

describe('MeshCoreObserverPublisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect wiring', () => {
    it('wires username, password, keepalive, and a retained offline LWT', async () => {
      const { publisher } = makePublisher();
      await startAndConnect(publisher);

      const opts = lastConnectOptions();
      expect(opts.username).toBe(`v1_${PUBKEY}`);
      expect(opts.password).toBe(TOKEN_STRING);
      expect(opts.keepalive).toBe(60);
      expect(opts.will).toBeDefined();
      expect(opts.will!.topic).toBe(`meshcore/test/${PUBKEY}/status`);
      expect(opts.will!.retain).toBe(true);

      const lwt = JSON.parse((opts.will!.payload as Buffer).toString());
      expect(lwt.status).toBe('offline');
      expect(lwt.origin_id).toBe(PUBKEY);
    });
  });

  it('publishes a single retained online status immediately on connect', async () => {
    const { publisher } = makePublisher();
    const client = await startAndConnect(publisher);

    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, payload, opts] = client.publish.mock.calls[0]!;
    expect(topic).toBe(`meshcore/test/${PUBKEY}/status`);
    expect(opts.retain).toBe(true);
    const body = JSON.parse(payload.toString());
    expect(body.status).toBe('online');
    expect(body.origin_id).toBe(PUBKEY);
  });

  it('NEVER subscribes to anything, even after packets flow (headline invariant)', async () => {
    const { publisher } = makePublisher();
    const client = await startAndConnect(publisher);

    for (let i = 0; i < 10; i++) {
      publisher.handleOtaPacket({ snr: 5, rssi: -70, raw_hex: '0900aa' });
    }

    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it('publishes each OTA packet as the exact contract payload, with origin_id matching the topic pubkey', async () => {
    const { publisher } = makePublisher();
    const client = await startAndConnect(publisher);
    client.publish.mockClear();

    const event: OtaPacketEvent = { snr: 6.25, rssi: -42, raw_hex: '0900aa' };
    publisher.handleOtaPacket(event);
    await flushMicrotasks();

    expect(client.publish).toHaveBeenCalledTimes(1);
    const [topic, payload, opts] = client.publish.mock.calls[0]!;
    expect(topic).toBe(`meshcore/test/${PUBKEY}/packets`);
    expect(opts.retain).toBe(false);

    const expected = buildObserverPacketPayload(event, { origin: 'MyNode', originId: PUBKEY });
    const actual = JSON.parse(payload.toString());
    expect(actual).toEqual(expected);
    expect(actual.origin_id).toBe(PUBKEY);
  });

  it('drops packets and counts them when the socket is down (never queues via mqtt.js)', async () => {
    const { publisher } = makePublisher();
    const startPromise = publisher.start();
    await flushMicrotasks(3);
    const client = lastFakeClient();
    // Deliberately do NOT emit 'connect' — the socket stays down.

    for (let i = 0; i < 5; i++) {
      publisher.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    }

    expect(client.publish).not.toHaveBeenCalled();
    expect(publisher.getStatus().dropped).toBe(5);

    // Tidy up the pending start() so nothing lingers.
    client.emit('error', new Error('unreachable'));
    await startPromise;
  });

  it('tracks publishes, lastPublishAt, and lastError', async () => {
    const { publisher } = makePublisher();
    const client = await startAndConnect(publisher);
    client.publish.mockClear();

    publisher.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    await flushMicrotasks();
    expect(publisher.getStatus().publishes).toBe(1);
    expect(publisher.getStatus().lastPublishAt).not.toBeNull();

    client.publish.mockImplementationOnce((_t, _p, _o, cb) => cb?.(new Error('publish failed')));
    publisher.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900bb' });
    await flushMicrotasks();
    expect(publisher.getStatus().lastError).toContain('publish failed');
  });

  describe('mint failures at start() — no connect attempt, no retry loop', () => {
    it.each([
      ['no_key', { kind: 'no_key' } as const, 'No observer signing key stored for this source.'],
      [
        'key_rotated',
        { kind: 'key_rotated' } as const,
        'Stored observer signing key cannot be decrypted (SESSION_SECRET changed). Re-import the key.',
      ],
      [
        'mint_failed',
        { kind: 'mint_failed', message: 'wasm boom' } as const,
        'Failed to mint observer auth token.',
      ],
    ])('resolves without connecting on %s', async (_label, result, expectedError) => {
      const mintToken = makeMintToken(result as ObserverTokenResult);
      const { publisher } = makePublisher(mintToken);

      await publisher.start();

      expect(mockConnect).not.toHaveBeenCalled();
      const status = publisher.getStatus();
      expect(status.keyStored).toBe(false);
      expect(status.lastError).toBe(expectedError);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('hard-stops after MAX_AUTH_FAILURES consecutive auth rejections, without re-minting', async () => {
    const mintToken = makeMintTokenAlwaysOk();
    const { publisher } = makePublisher(mintToken);
    const client = await startAndConnect(publisher);

    for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
      const err = Object.assign(new Error('bad creds'), { code: 4 });
      client.emit('error', err);
    }
    await flushMicrotasks();

    expect(publisher.isRunning()).toBe(false);
    expect(publisher.getStatus().lastError).toContain('Broker rejected the observer auth token');
    expect(mintToken).toHaveBeenCalledTimes(1); // proves no per-attempt re-minting
    expect(client.end).toHaveBeenCalled();
    // Both timers go, not just renewal — a leaked status-refresh interval
    // would keep ticking against a publisher that is meant to stay stopped
    // until an operator-driven config change (#4556).
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews on a timer tick: mints again, tears down the old client, connects a new one, republishes online', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokenA = makeToken({ expiresAt: nowSeconds + 120 }); // comfortably inside the renewal window at tick 1
    const tokenBString = TOKEN_STRING.replace(/^header/, 'renewd');
    const tokenB = makeToken({ token: tokenBString, expiresAt: nowSeconds + 86_400 + 120 });
    const mintToken = makeMintToken({ kind: 'ok', token: tokenA }, { kind: 'ok', token: tokenB });
    const { publisher } = makePublisher(mintToken);
    const oldClient = await startAndConnect(publisher);

    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(oldClient.end).toHaveBeenCalled();

    const newClient = lastFakeClient();
    expect(newClient).not.toBe(oldClient);
    const opts = lastConnectOptions();
    expect(opts.password).toBe(tokenBString);

    newClient.publish.mockClear();
    newClient.emit('connect');
    await flushMicrotasks();
    expect(newClient.publish).toHaveBeenCalledTimes(1); // fresh online status on the new client
  });

  describe('renewal window boundary (§3.2/§6 — closes the reference\'s ~55min expiry hole)', () => {
    it('renews on tick 1 when expiry falls inside the widened window (outside the naive 300s threshold)', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Outside the naive 300s threshold measured at mint time...
      const expiresAt = nowSeconds + RENEWAL_CHECK_MS / 1000 + RENEWAL_THRESHOLD_S + 60;
      expect(expiresAt - nowSeconds).toBeGreaterThan(RENEWAL_THRESHOLD_S);
      // ...but inside one check interval of expiry, so the reference's
      // threshold-only rule would miss it at tick 1 and fire ~55min late at
      // tick 2 (after the token has already expired).

      const tokenA = makeToken({ expiresAt });
      const tokenB = makeToken({ expiresAt: expiresAt + 86_400 });
      const mintToken = makeMintToken({ kind: 'ok', token: tokenA }, { kind: 'ok', token: tokenB });
      const { publisher } = makePublisher(mintToken);
      await startAndConnect(publisher);

      vi.advanceTimersByTime(RENEWAL_CHECK_MS);
      await flushMicrotasks();

      expect(mintToken).toHaveBeenCalledTimes(2);
    });

    it('does NOT renew on tick 1 when expiry is comfortably outside the widened window', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Remaining life at tick 1 = (2*interval + threshold + 60) - interval
      // = interval + threshold + 60 — 60s more than the widened window,
      // unambiguously outside it.
      const expiresAt = nowSeconds + 2 * (RENEWAL_CHECK_MS / 1000) + RENEWAL_THRESHOLD_S + 60;
      const tokenA = makeToken({ expiresAt });
      const mintToken = makeMintTokenAlwaysOk(tokenA);
      const { publisher } = makePublisher(mintToken);
      await startAndConnect(publisher);

      vi.advanceTimersByTime(RENEWAL_CHECK_MS);
      await flushMicrotasks();

      expect(mintToken).toHaveBeenCalledTimes(1); // only the initial mint — no renewal yet
    });
  });

  it('leaves the existing connection untouched on a renewal mint failure, and retries next tick', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + 120;
    const tokenA = makeToken({ expiresAt });
    const mintToken = makeMintToken(
      { kind: 'ok', token: tokenA },
      { kind: 'mint_failed', message: 'wasm boom' },
      { kind: 'ok', token: makeToken({ expiresAt: expiresAt + 86_400 }) },
    );
    const { publisher } = makePublisher(mintToken);
    const client = await startAndConnect(publisher);

    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(client.end).not.toHaveBeenCalled();
    expect(publisher.getStatus().lastError).toBe('Failed to mint observer auth token.');

    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();
    expect(mintToken).toHaveBeenCalledTimes(3);
  });

  describe('stop()', () => {
    it('publishes an explicit offline status before disconnecting (flushed), and is idempotent', async () => {
      const { publisher } = makePublisher();
      const client = await startAndConnect(publisher);
      client.publish.mockClear();

      await publisher.stop();

      expect(client.publish).toHaveBeenCalledTimes(1);
      const [topic, payload, opts] = client.publish.mock.calls[0]!;
      expect(topic).toBe(`meshcore/test/${PUBKEY}/status`);
      expect(JSON.parse(payload.toString()).status).toBe('offline');
      expect(opts.retain).toBe(true);
      expect(client.end).toHaveBeenCalledTimes(1);
      // flush:true — disconnect() must end non-forcefully so the offline
      // publish above actually reaches the wire instead of being discarded
      // by an immediate forced close (spec §2.4 / E2E criterion 8).
      expect(client.end.mock.calls[0]![0]).toBe(false);

      const publishOrder = client.publish.mock.invocationCallOrder[0]!;
      const endOrder = client.end.mock.invocationCallOrder[0]!;
      expect(publishOrder).toBeLessThan(endOrder);
      expect(vi.getTimerCount()).toBe(0);

      await publisher.stop();
      expect(client.publish).toHaveBeenCalledTimes(1);
      expect(client.end).toHaveBeenCalledTimes(1);
    });

    it('is safe to call before start() — no client, no publish, no throw', async () => {
      const { publisher } = makePublisher();
      await expect(publisher.stop()).resolves.toBeUndefined();
      expect(publisher.isRunning()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('device stats in the status payload (#4556)', () => {
    const lastStatusBody = (client: FakeMqttClient) => {
      const statusCalls = client.publish.mock.calls.filter((c) => c[0].endsWith('/status'));
      return JSON.parse(statusCalls.at(-1)![1].toString());
    };

    it('carries battery/uptime/noise-floor from the stats seam on the online status', async () => {
      const stats = vi.fn().mockResolvedValue({ batteryMv: 4021, uptimeSecs: 3600, noiseFloor: -95 });
      const { publisher } = makePublisher(undefined, SOURCE_ID, { stats });
      const client = await startAndConnect(publisher);

      const body = lastStatusBody(client);
      expect(body.status).toBe('online');
      expect(body.stats).toEqual({ battery_mv: 4021, uptime_secs: 3600, noise_floor: -95 });
      expect(stats).toHaveBeenCalledTimes(1);
    });

    it('publishes no `stats` key when the source supplies no stats seam', async () => {
      const { publisher } = makePublisher();
      const client = await startAndConnect(publisher);
      expect(lastStatusBody(client)).not.toHaveProperty('stats');
    });

    it('still publishes the status when the stats read rejects', async () => {
      const stats = vi.fn().mockRejectedValue(new Error('device did not answer'));
      const { publisher } = makePublisher(undefined, SOURCE_ID, { stats });
      const client = await startAndConnect(publisher);

      const body = lastStatusBody(client);
      expect(body.status).toBe('online');
      expect(body).not.toHaveProperty('stats');
    });

    it('never reads stats on the packet path — only on status publishes', async () => {
      const stats = vi.fn().mockResolvedValue({ batteryMv: 4021 });
      const { publisher } = makePublisher(undefined, SOURCE_ID, { stats });
      await startAndConnect(publisher);
      stats.mockClear();

      for (let i = 0; i < 20; i++) {
        publisher.handleOtaPacket({ snr: 5, rssi: -70, raw_hex: '0900aa' });
      }
      await flushMicrotasks();

      expect(stats).not.toHaveBeenCalled();
    });

    it('republishes the retained online status with fresh stats every STATUS_REFRESH_MS', async () => {
      const stats = vi
        .fn()
        .mockResolvedValueOnce({ batteryMv: 4021, uptimeSecs: 60 })
        .mockResolvedValueOnce({ batteryMv: 3990, uptimeSecs: 360 });
      const { publisher } = makePublisher(undefined, SOURCE_ID, { stats });
      const client = await startAndConnect(publisher);
      expect(lastStatusBody(client).stats).toEqual({ battery_mv: 4021, uptime_secs: 60 });

      await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
      await flushMicrotasks();

      expect(stats).toHaveBeenCalledTimes(2);
      const body = lastStatusBody(client);
      expect(body.status).toBe('online');
      expect(body.stats).toEqual({ battery_mv: 3990, uptime_secs: 360 });
      const statusCalls = client.publish.mock.calls.filter((c) => c[0].endsWith('/status'));
      expect(statusCalls.at(-1)![2].retain).toBe(true);
    });

    it('skips the refresh while the socket is down (never queues in mqtt.js)', async () => {
      const stats = vi.fn().mockResolvedValue({ batteryMv: 4021 });
      const { publisher } = makePublisher(undefined, SOURCE_ID, { stats });
      const client = await startAndConnect(publisher);
      client.publish.mockClear();
      stats.mockClear();

      client.emit('close');
      await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
      await flushMicrotasks();

      expect(stats).not.toHaveBeenCalled();
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('stop() clears the refresh timer along with the renewal timer', async () => {
      const stats = vi.fn().mockResolvedValue({ batteryMv: 4021 });
      const { publisher } = makePublisher(undefined, SOURCE_ID, { stats });
      await startAndConnect(publisher);

      await publisher.stop();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('redacts token-shaped substrings from lastError', async () => {
    const { publisher } = makePublisher();
    const client = await startAndConnect(publisher);

    const embeddedToken = 'headerpart1234567890abcdef.payloadpart1234567890abcdef.' + 'b'.repeat(128);
    client.emit('error', new Error(`token rejected: ${embeddedToken}`));

    const lastError = publisher.getStatus().lastError;
    expect(lastError).not.toBeNull();
    expect(lastError).not.toContain(embeddedToken);
    expect(lastError).toContain('[REDACTED]');
  });
});
