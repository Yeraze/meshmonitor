/**
 * meshcoreObserverPublisher multi-broker tests (#5014 Phase 1 WP3 — spec
 * §6.5, tests 25-39). One MeshCore source publishing the same OTA packet
 * stream to N Analyzer brokers concurrently, with per-broker connection
 * state, counters, credentials and tokens.
 *
 * Same harness shape as the sibling publisher test files: mock the 'mqtt'
 * module, drive the REAL `MqttBrokerClient` underneath (so per-broker CONNECT
 * options — LWT topic, username, password — are asserted for real), and
 * inject only `mintToken` / `loadCredentials` / `createClient`.
 * `mockConnect.mock.results` yields one fake client per broker, in config
 * order.
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
  MAX_AUTH_FAILURES,
  STATUS_REFRESH_MS,
  type MeshCoreObserverPublisherOptions,
} from './meshcoreObserverPublisher.js';
import * as observerPacket from './meshcoreObserverPacket.js';
import { MqttBrokerClient } from '../transports/mqttBrokerClient.js';
import type { ObserverCredentialLoadResult } from './meshcoreObserverCredentialStore.js';
import type { ObserverToken, ObserverTokenResult } from './meshcoreObserverToken.js';
import type { NormalizedObserverBroker } from '../meshcoreConfig.js';

const mockConnect = connect as MockedFunction<typeof connect>;
const fakeClientAt = (i: number): FakeMqttClient => mockConnect.mock.results[i]!.value as FakeMqttClient;
const connectOptionsAt = (i: number) => mockConnect.mock.calls[i]![1]!;

const SOURCE_ID = 'src-observer-multi';
const IATA = 'TEST';

function pubkeyFor(label: string): string {
  return label.repeat(64).slice(0, 64).toUpperCase();
}
const PUBKEY = pubkeyFor('AB');

function makeToken(overrides: Partial<ObserverToken> = {}): ObserverToken {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    token: 'headerpart1234567890abcdef.payloadpart1234567890abcdef.' + 'a'.repeat(128),
    publicKey: PUBKEY,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 86_400,
    ...overrides,
  };
}

function broker(overrides: Partial<NormalizedObserverBroker> & { url: string }): NormalizedObserverBroker {
  return {
    key: overrides.url.toLowerCase(),
    authMode: 'token',
    legacy: false,
    ...overrides,
  };
}

function makeConfig(brokers: NormalizedObserverBroker[]): MeshCoreObserverPublisherOptions['config'] {
  return {
    enabled: true,
    iataCode: IATA,
    brokers,
    authMode: brokers[0]?.authMode ?? 'token',
    brokerUrl: brokers[0]?.url ?? 'mqtt://unused.test:1883',
    ...(brokers[0]?.tokenAudience ? { tokenAudience: brokers[0].tokenAudience } : {}),
  };
}

function makeDevice(publicKey?: string): MeshCoreObserverPublisherOptions['device'] {
  return () => ({ origin: 'MyNode', model: 'ModelX', firmwareVersion: 'v1.16.1', radio: '915,250,7,5', publicKey });
}

/** mintToken mock that resolves 'ok' with a distinct token per audience, keyed by an optional map. */
function makeMintTokenByAudience(
  tokensByAudience: Record<string, ObserverToken>,
): MockedFunction<(sourceId: string, audience: string) => Promise<ObserverTokenResult>> {
  return vi.fn(async (_sourceId: string, audience: string): Promise<ObserverTokenResult> => {
    const token = tokensByAudience[audience];
    return token ? { kind: 'ok', token } : { kind: 'mint_failed', message: 'no token for audience' };
  });
}

function loaderByBrokerKey(
  credsByKey: Record<string, { username: string; password: string }>,
): MockedFunction<(sourceId: string, brokerKey: string, legacy: boolean) => Promise<ObserverCredentialLoadResult>> {
  return vi.fn(async (_sourceId: string, brokerKey: string, _legacy: boolean): Promise<ObserverCredentialLoadResult> => {
    const cred = credsByKey[brokerKey];
    return cred ? { kind: 'ok', ...cred } : { kind: 'none' };
  });
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Starts the publisher, flushes until every expected client is created, then connects all of them. */
async function startAndConnectAll(
  publisher: MeshCoreObserverPublisher,
  expectedClientCount: number,
): Promise<FakeMqttClient[]> {
  const startPromise = publisher.start();
  await flushMicrotasks();
  const clients: FakeMqttClient[] = [];
  for (let i = 0; i < expectedClientCount; i++) clients.push(fakeClientAt(i));
  for (const c of clients) c.emit('connect');
  await startPromise;
  await flushMicrotasks();
  return clients;
}

describe('MeshCoreObserverPublisher — multi-broker (#5014 Phase 1 WP3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test 25: concurrent publish to 2 token-mode brokers with different audiences', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA'), token: 'tokA.payload.' + 'a'.repeat(128) });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB'), token: 'tokB.payload.' + 'b'.repeat(128) });
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });

    const [clientA, clientB] = await startAndConnectAll(publisher, 2);
    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(mintToken).toHaveBeenCalledWith(SOURCE_ID, 'aud-a');
    expect(mintToken).toHaveBeenCalledWith(SOURCE_ID, 'aud-b');

    clientA!.publish.mockClear();
    clientB!.publish.mockClear();

    publisher.handleOtaPacket({ snr: 5, rssi: -70, raw_hex: '0900aa' });
    await flushMicrotasks();

    // Each broker uses ITS OWN topic (derived from its own token's public key).
    expect(clientA!.publish).toHaveBeenCalledTimes(1);
    expect(clientB!.publish).toHaveBeenCalledTimes(1);
    const [topicA, payloadA] = clientA!.publish.mock.calls[0]!;
    const [topicB, payloadB] = clientB!.publish.mock.calls[0]!;
    expect(topicA).toBe(`meshcore/test/${tokenA.publicKey}/packets`);
    expect(topicB).toBe(`meshcore/test/${tokenB.publicKey}/packets`);
    // Different origin ids -> different payloads (this is NOT the "shared
    // audience" case), but each is internally well-formed.
    expect(JSON.parse(payloadA.toString()).origin_id).toBe(tokenA.publicKey);
    expect(JSON.parse(payloadB.toString()).origin_id).toBe(tokenB.publicKey);
  });

  it('test 26: payload is built exactly once per distinct originId, even across 3 same-origin brokers', async () => {
    const spy = vi.spyOn(observerPacket, 'buildObserverPacketPayload');
    const brokers = [
      broker({ url: 'wss://mqtt-1.test:443', tokenAudience: 'shared-aud' }),
      broker({ url: 'wss://mqtt-2.test:443', tokenAudience: 'shared-aud' }),
      broker({ url: 'wss://mqtt-3.test:443', tokenAudience: 'shared-aud' }),
    ];
    const token = makeToken();
    const mintToken = makeMintTokenByAudience({ 'shared-aud': token });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(brokers),
      device: makeDevice(),
      mintToken,
    });
    await startAndConnectAll(publisher, 3);
    spy.mockClear();

    publisher.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    await flushMicrotasks();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('test 27: mintToken receives each broker\'s own audience; CONNECT password is that broker\'s token', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA'), token: 'tokA.payload.' + 'a'.repeat(128) });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB'), token: 'tokB.payload.' + 'b'.repeat(128) });
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    await startAndConnectAll(publisher, 2);

    expect(connectOptionsAt(0).password).toBe(tokenA.token);
    expect(connectOptionsAt(0).username).toBe(`v1_${tokenA.publicKey}`);
    expect(connectOptionsAt(1).password).toBe(tokenB.token);
    expect(connectOptionsAt(1).username).toBe(`v1_${tokenB.publicKey}`);
  });

  it('test 28: two brokers sharing an audience dedupe minting — one mint call, same token on both sockets', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'shared-aud' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'shared-aud' });
    const token = makeToken();
    const mintToken = makeMintTokenByAudience({ 'shared-aud': token });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    await startAndConnectAll(publisher, 2);

    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(connectOptionsAt(0).password).toBe(token.token);
    expect(connectOptionsAt(1).password).toBe(token.token);
  });

  it('test 29: drop-when-disconnected is per broker; aggregate publishes is the sum', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA') });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB') });
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    const [clientA, clientB] = await startAndConnectAll(publisher, 2);
    clientA!.publish.mockClear();
    clientB!.publish.mockClear();

    // Disconnect B only.
    clientB!.emit('close');
    await flushMicrotasks();

    publisher.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    await flushMicrotasks();

    const status = publisher.getStatus();
    expect(status.brokers[0]!.publishes).toBe(1);
    expect(status.brokers[0]!.dropped).toBe(0);
    expect(status.brokers[1]!.publishes).toBe(0);
    expect(status.brokers[1]!.dropped).toBe(1);
    expect(status.publishes).toBe(1);
    expect(status.dropped).toBe(1);
  });

  it('test 30: per-broker lastError isolation', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA') });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB') });
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    const [, clientB] = await startAndConnectAll(publisher, 2);

    clientB!.emit('error', new Error('broker B exploded'));
    await flushMicrotasks();

    const status = publisher.getStatus();
    expect(status.brokers[1]!.lastError).toContain('broker B exploded');
    expect(status.brokers[0]!.lastError).toBeNull();
    expect(status.lastError).toContain('broker B exploded');
  });

  it('test 31: token-shaped substrings are redacted per broker', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const mintToken = makeMintTokenByAudience({ 'aud-a': makeToken() });
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA]),
      device: makeDevice(),
      mintToken,
    });
    const [client] = await startAndConnectAll(publisher, 1);

    const embeddedToken = 'headerpart1234567890abcdef.payloadpart1234567890abcdef.' + 'c'.repeat(128);
    client!.emit('error', new Error(`token rejected: ${embeddedToken}`));

    const lastError = publisher.getStatus().brokers[0]!.lastError;
    expect(lastError).not.toContain(embeddedToken);
    expect(lastError).toContain('[REDACTED]');
  });

  it('test 32: auth hard-stop is per broker — B disconnects, A keeps publishing, isRunning() stays true', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA') });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB') });
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    const [clientA, clientB] = await startAndConnectAll(publisher, 2);

    for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
      clientB!.emit('error', Object.assign(new Error('bad creds'), { code: 4 }));
    }
    await flushMicrotasks();

    expect(publisher.isRunning()).toBe(true);
    const status = publisher.getStatus();
    expect(status.brokers[1]!.connected).toBe(false);
    expect(status.brokers[0]!.connected).toBe(true);

    clientA!.publish.mockClear();
    publisher.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    await flushMicrotasks();
    expect(clientA!.publish).toHaveBeenCalledTimes(1);
  });

  it('test 32b: when the LAST live connection hard-stops, timers clear and isRunning() goes false', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const tokenA = makeToken();
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA });
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA]),
      device: makeDevice(),
      mintToken,
    });
    const [client] = await startAndConnectAll(publisher, 1);

    for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
      client!.emit('error', Object.assign(new Error('bad creds'), { code: 4 }));
    }
    await flushMicrotasks();

    expect(publisher.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('test 33: renewal rebuilds only the affected audience', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA'), expiresAt: nowSeconds + 120 }); // near expiry
    const tokenB = makeToken({ publicKey: pubkeyFor('BB'), expiresAt: nowSeconds + 86_400 + 120 }); // fresh
    const renewedA = makeToken({
      publicKey: pubkeyFor('AA'),
      token: 'renewedA.payload.' + 'a'.repeat(128),
      expiresAt: nowSeconds + 86_400 + 120,
    });

    let mintCallsForA = 0;
    const mintToken = vi.fn(async (_sourceId: string, audience: string): Promise<ObserverTokenResult> => {
      if (audience === 'aud-a') {
        mintCallsForA++;
        return { kind: 'ok', token: mintCallsForA === 1 ? tokenA : renewedA };
      }
      return { kind: 'ok', token: tokenB };
    });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    await startAndConnectAll(publisher, 2);
    const connectCountBefore = mockConnect.mock.calls.length;

    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();

    expect(mintCallsForA).toBe(2); // initial + renewal
    // Exactly one NEW socket (A's rebuild) — B untouched.
    expect(mockConnect.mock.calls.length).toBe(connectCountBefore + 1);
    const newestOpts = connectOptionsAt(mockConnect.mock.calls.length - 1);
    expect(newestOpts.password).toBe(renewedA.token);
  });

  it('test 33b: a hard-stopped connection is excluded from renewal and never resurrected (review fix)', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    // Both tokens are near expiry, so BOTH audiences would normally be due
    // for renewal on the next tick.
    const tokenA = makeToken({ publicKey: pubkeyFor('AA'), expiresAt: nowSeconds + 120 });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB'), expiresAt: nowSeconds + 120 });
    const renewedA = makeToken({
      publicKey: pubkeyFor('AA'),
      token: 'renewedA.payload.' + 'a'.repeat(128),
      expiresAt: nowSeconds + 86_400 + 120,
    });

    let mintCallsForA = 0;
    let mintCallsForB = 0;
    const mintToken = vi.fn(async (_sourceId: string, audience: string): Promise<ObserverTokenResult> => {
      if (audience === 'aud-a') {
        mintCallsForA++;
        return { kind: 'ok', token: mintCallsForA === 1 ? tokenA : renewedA };
      }
      mintCallsForB++;
      return { kind: 'ok', token: tokenB };
    });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    const [, clientB] = await startAndConnectAll(publisher, 2);
    expect(mintCallsForA).toBe(1);
    expect(mintCallsForB).toBe(1);
    const connectCountBeforeHardStop = mockConnect.mock.calls.length;

    // Drive B to hard-stop via MAX_AUTH_FAILURES permission-denied events —
    // same mechanism as test 32.
    for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
      clientB!.emit('error', Object.assign(new Error('bad creds'), { code: 4 }));
    }
    await flushMicrotasks();
    expect(publisher.getStatus().brokers[1]!.connected).toBe(false);
    // Hard-stopping disconnects the existing socket; it does not open a new one.
    expect(mockConnect.mock.calls.length).toBe(connectCountBeforeHardStop);

    // Advance past the renewal window. Both audiences are "due", but B's
    // connection is hard-stopped.
    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();

    // A renews normally...
    expect(mintCallsForA).toBe(2);
    // ...but B's audience is never even re-minted (no live connection to use it).
    expect(mintCallsForB).toBe(1);
    // Exactly one NEW socket total — A's rebuild. B's socket count is unchanged.
    expect(mockConnect.mock.calls.length).toBe(connectCountBeforeHardStop + 1);
    // Bring A's rebuilt socket up so its `connected` status reflects reality.
    fakeClientAt(connectCountBeforeHardStop).emit('connect');
    await flushMicrotasks();

    const status = publisher.getStatus();
    expect(status.brokers[1]!.connected).toBe(false);
    expect(status.brokers[0]!.connected).toBe(true);
    // B stays down permanently — isRunning() reflects A only.
    expect(publisher.isRunning()).toBe(true);

    // A's token is now fresh (just renewed to a 24h expiry), so a further
    // tick renews nothing at all — confirming B's exclusion isn't a one-tick
    // fluke and no connect is attempted for either broker.
    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();
    expect(mockConnect.mock.calls.length).toBe(connectCountBeforeHardStop + 1);
    expect(mintCallsForB).toBe(1);
    expect(publisher.getStatus().brokers[1]!.connected).toBe(false);
  });

  it('test 34: a failed renewal mint does not tear down the working socket', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const tokenA = makeToken({ expiresAt: nowSeconds + 120 });
    let calls = 0;
    const mintToken = vi.fn(async (): Promise<ObserverTokenResult> => {
      calls++;
      return calls === 1 ? { kind: 'ok', token: tokenA } : { kind: 'mint_failed', message: 'renewal boom' };
    });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA]),
      device: makeDevice(),
      mintToken,
    });
    const [client] = await startAndConnectAll(publisher, 1);
    const connectCountBefore = mockConnect.mock.calls.length;

    vi.advanceTimersByTime(RENEWAL_CHECK_MS);
    await flushMicrotasks();

    expect(calls).toBe(2);
    expect(mockConnect.mock.calls.length).toBe(connectCountBefore); // no rebuild
    expect(client!.end).not.toHaveBeenCalled();
    expect(publisher.getStatus().brokers[0]!.lastError).toBe('Failed to mint observer auth token.');
  });

  it('test 35: status refresh reads stats exactly once per tick across 3 brokers, and publishes to all 3', async () => {
    const brokers = [
      broker({ url: 'wss://mqtt-1.test:443', tokenAudience: 'aud-1' }),
      broker({ url: 'wss://mqtt-2.test:443', tokenAudience: 'aud-2' }),
      broker({ url: 'wss://mqtt-3.test:443', tokenAudience: 'aud-3' }),
    ];
    const tokens = {
      'aud-1': makeToken({ publicKey: pubkeyFor('11') }),
      'aud-2': makeToken({ publicKey: pubkeyFor('22') }),
      'aud-3': makeToken({ publicKey: pubkeyFor('33') }),
    };
    const mintToken = makeMintTokenByAudience(tokens);
    const stats = vi.fn().mockResolvedValue({ batteryMv: 4021 });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(brokers),
      device: makeDevice(),
      mintToken,
      stats,
    });
    const clients = await startAndConnectAll(publisher, 3);
    stats.mockClear();
    for (const c of clients) c.publish.mockClear();

    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS);
    await flushMicrotasks();

    expect(stats).toHaveBeenCalledTimes(1);
    for (const c of clients) {
      const statusCalls = c.publish.mock.calls.filter((call) => call[0].endsWith('/status'));
      expect(statusCalls).toHaveLength(1);
      expect(JSON.parse(statusCalls[0]![1]!.toString()).stats).toEqual({ battery_mv: 4021 });
    }
  });

  it('test 36: password-mode per-broker credentials — each socket gets its own username/password', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', authMode: 'password', legacy: false });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', authMode: 'password', legacy: true });
    const loadCredentials = loaderByBrokerKey({
      'wss://mqtt-a.test:443': { username: 'user-a', password: 'pass-a' },
      'wss://mqtt-b.test:443': { username: 'user-b', password: 'pass-b' },
    });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(PUBKEY),
      mintToken: vi.fn(),
      loadCredentials,
    });
    await startAndConnectAll(publisher, 2);

    expect(loadCredentials).toHaveBeenCalledWith(SOURCE_ID, 'wss://mqtt-a.test:443', false);
    expect(loadCredentials).toHaveBeenCalledWith(SOURCE_ID, 'wss://mqtt-b.test:443', true);
    expect(connectOptionsAt(0).username).toBe('user-a');
    expect(connectOptionsAt(0).password).toBe('pass-a');
    expect(connectOptionsAt(1).username).toBe('user-b');
    expect(connectOptionsAt(1).password).toBe('pass-b');
  });

  it('test 37: mixed modes on one source — password broker has null tokenExpiresAt', async () => {
    const tokenBroker = broker({ url: 'wss://mqtt-tok.test:443', tokenAudience: 'aud-tok' });
    const passwordBroker = broker({ url: 'wss://mqtt-pass.test:443', authMode: 'password', legacy: false });
    const token = makeToken();
    const mintToken = makeMintTokenByAudience({ 'aud-tok': token });
    const loadCredentials = loaderByBrokerKey({
      'wss://mqtt-pass.test:443': { username: 'user', password: 'pass' },
    });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([tokenBroker, passwordBroker]),
      device: makeDevice(PUBKEY),
      mintToken,
      loadCredentials,
    });
    await startAndConnectAll(publisher, 2);

    const status = publisher.getStatus();
    expect(status.brokers[0]!.authMode).toBe('token');
    expect(status.brokers[0]!.tokenExpiresAt).toBeGreaterThan(0);
    expect(status.brokers[1]!.authMode).toBe('password');
    expect(status.brokers[1]!.tokenExpiresAt).toBeNull();
  });

  describe('test 38: start() never throws', () => {
    it('when every mint fails', async () => {
      const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
      const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
      const mintToken = vi.fn(async (): Promise<ObserverTokenResult> => ({ kind: 'mint_failed', message: 'boom' }));
      const publisher = new MeshCoreObserverPublisher({
        sourceId: SOURCE_ID,
        config: makeConfig([brokerA, brokerB]),
        device: makeDevice(),
        mintToken,
      });

      await expect(publisher.start()).resolves.toBeUndefined();
      expect(publisher.isRunning()).toBe(false);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('when every credential is missing', async () => {
      const brokerA = broker({ url: 'wss://mqtt-a.test:443', authMode: 'password' });
      const brokerB = broker({ url: 'wss://mqtt-b.test:443', authMode: 'password' });
      const loadCredentials = loaderByBrokerKey({});
      const publisher = new MeshCoreObserverPublisher({
        sourceId: SOURCE_ID,
        config: makeConfig([brokerA, brokerB]),
        device: makeDevice(PUBKEY),
        mintToken: vi.fn(),
        loadCredentials,
      });

      await expect(publisher.start()).resolves.toBeUndefined();
      expect(publisher.isRunning()).toBe(false);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('when createClient throws for one broker — the others still come up', async () => {
      const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
      const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
      const tokenA = makeToken({ publicKey: pubkeyFor('AA') });
      const tokenB = makeToken({ publicKey: pubkeyFor('BB') });
      const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

      let call = 0;
      const createClient = vi.fn((opts) => {
        call++;
        if (call === 1) throw new Error('createClient boom');
        // Fall through to a REAL MqttBrokerClient around the mocked 'mqtt'
        // module for the surviving broker.
        return new MqttBrokerClient(opts);
      });

      const publisher = new MeshCoreObserverPublisher({
        sourceId: SOURCE_ID,
        config: makeConfig([brokerA, brokerB]),
        device: makeDevice(),
        mintToken,
        createClient,
      });

      const startPromise = publisher.start();
      await flushMicrotasks();
      // Only brokerB's createClient call actually built a socket — brokerA's
      // threw before ever reaching `mqtt.connect`.
      expect(mockConnect).toHaveBeenCalledTimes(1);
      fakeClientAt(0).emit('connect');
      await expect(startPromise).resolves.toBeUndefined();
      await flushMicrotasks();

      expect(publisher.isRunning()).toBe(true);
      const status = publisher.getStatus();
      expect(status.brokers[0]!.keyStored).toBe(false);
      expect(status.brokers[0]!.lastError).toContain('createClient boom');
      expect(status.brokers[1]!.connected).toBe(true);
    });
  });

  it('test 39: stop() publishes offline + disconnects on every broker, and is idempotent', async () => {
    const brokerA = broker({ url: 'wss://mqtt-a.test:443', tokenAudience: 'aud-a' });
    const brokerB = broker({ url: 'wss://mqtt-b.test:443', tokenAudience: 'aud-b' });
    const tokenA = makeToken({ publicKey: pubkeyFor('AA') });
    const tokenB = makeToken({ publicKey: pubkeyFor('BB') });
    const mintToken = makeMintTokenByAudience({ 'aud-a': tokenA, 'aud-b': tokenB });

    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig([brokerA, brokerB]),
      device: makeDevice(),
      mintToken,
    });
    const [clientA, clientB] = await startAndConnectAll(publisher, 2);
    clientA!.publish.mockClear();
    clientB!.publish.mockClear();

    await publisher.stop();

    for (const c of [clientA!, clientB!]) {
      expect(c.publish).toHaveBeenCalledTimes(1);
      expect(JSON.parse(c.publish.mock.calls[0]![1]!.toString()).status).toBe('offline');
      expect(c.end).toHaveBeenCalledTimes(1);
    }
    expect(vi.getTimerCount()).toBe(0);

    // Idempotent: no additional publishes/disconnects.
    await publisher.stop();
    expect(clientA!.publish).toHaveBeenCalledTimes(1);
    expect(clientB!.publish).toHaveBeenCalledTimes(1);
  });
});
