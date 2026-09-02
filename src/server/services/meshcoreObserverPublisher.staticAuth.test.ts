/**
 * meshcoreObserverPublisher — static-credential auth mode (issue #4595).
 *
 * Same harness shape as `meshcoreObserverPublisher.test.ts`: mock the 'mqtt'
 * module, drive the REAL `MqttBrokerClient` underneath, and inject only the
 * credential loader / token minter. That way these tests assert the actual
 * CONNECT-packet wiring, not a stand-in for it.
 *
 * What this file locks down:
 *  1. password mode connects with the STORED username/password (not
 *     `v1_{PUBKEY}` + a token) and never mints a token.
 *  2. token mode is untouched by the new branch.
 *  3. Missing / undecryptable credentials fail closed with a useful
 *     `lastError` and no socket.
 *  4. No renewal timer in password mode (nothing expires).
 *  5. The stored password never appears in `getStatus()`.
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
  c.subscribe = vi.fn((_t: string[], _o: SubscribeOpts, cb?: SubscribeCallback) => {
    cb?.(null, [], {});
  }) as FakeMqttClient['subscribe'];
  c.publish = vi.fn((_t: string, _p: Buffer, _o: PublishOpts, cb?: PublishCallback) => {
    cb?.();
  }) as FakeMqttClient['publish'];
  c.end = vi.fn((_f: boolean, _o: EndOpts, cb?: EndCallback) => {
    cb?.();
  }) as FakeMqttClient['end'];
  c.reconnect = vi.fn() as FakeMqttClient['reconnect'];
  return c;
}

vi.mock('mqtt', () => ({ connect: vi.fn(() => makeFakeClient()) }));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { connect } from 'mqtt';
import {
  MeshCoreObserverPublisher,
  RENEWAL_CHECK_MS,
  type MeshCoreObserverPublisherOptions,
} from './meshcoreObserverPublisher.js';
import type { ObserverCredentialLoadResult } from './meshcoreObserverCredentialStore.js';
import type { ObserverToken, ObserverTokenResult } from './meshcoreObserverToken.js';

const mockConnect = connect as MockedFunction<typeof connect>;
const lastFakeClient = (): FakeMqttClient => mockConnect.mock.results.at(-1)!.value as FakeMqttClient;
const lastConnectOptions = () => mockConnect.mock.calls.at(-1)![1]!;

const SOURCE_ID = 'src-observer-static';
const PUBKEY = 'AB'.repeat(32);
const TOKEN_STRING = 'headerpart1234567890abcdef.payloadpart1234567890abcdef.' + 'a'.repeat(128);
const BROKER_USER = 'meshcore';
const BROKER_PASS = 'meshcore';
const BROKER_URL = 'mqtt://meshcoretel.test:1883';
const BROKER_KEY = BROKER_URL.toLowerCase();

/** Legacy single (password-mode) broker, expressed as `NormalizedObserverConfig` (#5014 Phase 1 WP3). */
function makeConfig(
  overrides: Partial<MeshCoreObserverPublisherOptions['config']> = {},
): MeshCoreObserverPublisherOptions['config'] {
  return {
    enabled: true,
    iataCode: 'ALA',
    brokers: [{ key: BROKER_KEY, url: BROKER_URL, authMode: 'password', legacy: true }],
    authMode: 'password',
    brokerUrl: BROKER_URL,
    ...overrides,
  };
}

/** Legacy single token-mode broker config, matching `meshcoreObserverPublisher.test.ts`'s shape. */
function makeTokenConfig(
  overrides: { tokenAudience?: string } = { tokenAudience: 'aud.test' },
): MeshCoreObserverPublisherOptions['config'] {
  const url = 'mqtt://broker.test:1883';
  const key = url.toLowerCase();
  const tokenAudience = overrides.tokenAudience;
  return {
    enabled: true,
    iataCode: 'TEST',
    brokers: tokenAudience
      ? [{ key, url, authMode: 'token', tokenAudience, legacy: true }]
      : [], // token-mode entry with no audience is dropped by normalizeObserverBrokers
    authMode: 'token',
    brokerUrl: url,
    ...(tokenAudience ? { tokenAudience } : {}),
  };
}

// No default: an explicit `undefined` must mean "the node hasn't reported a
// public key", not "fall back to PUBKEY".
function makeDevice(publicKey: string | undefined): MeshCoreObserverPublisherOptions['device'] {
  return () => ({
    origin: 'MyNode',
    model: 'ModelX',
    firmwareVersion: 'v1.16.1',
    radio: '915,250,7,5',
    publicKey,
  });
}

function makeToken(): ObserverToken {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return { token: TOKEN_STRING, publicKey: PUBKEY, issuedAt: nowSeconds, expiresAt: nowSeconds + 86_400 };
}

function loader(
  result: ObserverCredentialLoadResult,
): MockedFunction<(sourceId: string, brokerKey: string, legacy: boolean) => Promise<ObserverCredentialLoadResult>> {
  const fn = vi.fn() as MockedFunction<
    (sourceId: string, brokerKey: string, legacy: boolean) => Promise<ObserverCredentialLoadResult>
  >;
  fn.mockResolvedValue(result);
  return fn;
}

function minter(): MockedFunction<(sourceId: string, audience: string) => Promise<ObserverTokenResult>> {
  const fn = vi.fn() as MockedFunction<(sourceId: string, audience: string) => Promise<ObserverTokenResult>>;
  fn.mockResolvedValue({ kind: 'ok', token: makeToken() });
  return fn;
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function startAndConnect(publisher: MeshCoreObserverPublisher): Promise<FakeMqttClient> {
  const startPromise = publisher.start();
  await flushMicrotasks(30);
  const client = lastFakeClient();
  client.emit('connect');
  await startPromise;
  await flushMicrotasks();
  return client;
}

describe('MeshCoreObserverPublisher — static credentials (#4595)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects with the configured username/password and never mints a token', async () => {
    const mintToken = minter();
    const loadCredentials = loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS });
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken,
      loadCredentials,
    });

    await startAndConnect(publisher);

    const opts = lastConnectOptions();
    expect(opts.username).toBe(BROKER_USER);
    expect(opts.password).toBe(BROKER_PASS);
    expect(opts.username).not.toMatch(/^v1_/);
    expect(mintToken).not.toHaveBeenCalled();
    expect(loadCredentials).toHaveBeenCalledWith(SOURCE_ID, BROKER_KEY, true);

    const status = publisher.getStatus();
    expect(status).toMatchObject({
      authMode: 'password',
      configured: true,
      keyStored: true,
      connected: true,
      // Nothing expires in this mode.
      tokenExpiresAt: null,
      lastError: null,
    });
  });

  it('derives the topic public key from the node itself, not from a signing key', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS }),
    });

    const client = await startAndConnect(publisher);

    // Retained LWT + online status both go to the node-keyed status topic.
    expect(lastConnectOptions().will!.topic).toBe(`meshcore/ALA/${PUBKEY}/status`);
    const statusPublish = client.publish.mock.calls.find((c) => c[0].endsWith('/status'));
    expect(statusPublish).toBeDefined();
    expect(JSON.parse(statusPublish![1]!.toString()).origin_id).toBe(PUBKEY);
  });

  it('is "configured" without a tokenAudience — a static broker has no audience', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig({ tokenAudience: undefined }),
      device: makeDevice(PUBKEY),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS }),
    });
    await startAndConnect(publisher);
    expect(publisher.getStatus().configured).toBe(true);
  });

  it('arms NO renewal timer — static credentials never expire', async () => {
    const mintToken = minter();
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken,
      loadCredentials: loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS }),
    });
    await startAndConnect(publisher);

    const connectsBefore = mockConnect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RENEWAL_CHECK_MS * 3);
    await flushMicrotasks();

    expect(mintToken).not.toHaveBeenCalled();
    // No renewal means no client rebuild.
    expect(mockConnect.mock.calls.length).toBe(connectsBefore);
  });

  it('fails closed with no socket when no credentials are stored', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'none' }),
    });

    await publisher.start();
    await flushMicrotasks();

    expect(mockConnect).not.toHaveBeenCalled();
    expect(publisher.isRunning()).toBe(false);
    const status = publisher.getStatus();
    expect(status.keyStored).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.lastError).toMatch(/No broker username\/password stored/);
  });

  it('fails closed when the stored password can no longer be decrypted', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'key_rotated', storedKid: 'deadbeef' }),
    });

    await publisher.start();
    await flushMicrotasks();

    expect(mockConnect).not.toHaveBeenCalled();
    expect(publisher.getStatus().lastError).toMatch(/SESSION_SECRET changed/);
    // The internal kid must never leak into a user-visible string.
    expect(publisher.getStatus().lastError).not.toContain('deadbeef');
  });

  it('fails closed when the node has not reported its public key yet', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(undefined),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS }),
    });

    await publisher.start();
    await flushMicrotasks();

    expect(mockConnect).not.toHaveBeenCalled();
    expect(publisher.getStatus().lastError).toMatch(/public key/i);
  });

  it('never exposes the stored password through getStatus()', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'ok', username: 'observer-user', password: 'hunter2-very-secret' }),
    });
    const client = await startAndConnect(publisher);

    // Force an auth rejection so `lastError` is populated from that path too.
    client.emit('error', Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 }));
    await flushMicrotasks();

    expect(JSON.stringify(publisher.getStatus())).not.toContain('hunter2-very-secret');
  });

  it('reports a static-flavoured message when the broker rejects the credentials', async () => {
    const publisher = new MeshCoreObserverPublisher({
      sourceId: SOURCE_ID,
      config: makeConfig(),
      device: makeDevice(PUBKEY),
      mintToken: minter(),
      loadCredentials: loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS }),
    });
    const client = await startAndConnect(publisher);

    // MqttBrokerClient turns a CONNACK code 4/5 into `permission-denied`.
    client.emit('error', Object.assign(new Error('bad creds'), { code: 4 }));
    await flushMicrotasks();

    expect(publisher.getStatus().lastError).toBe('Broker rejected the observer username/password.');
  });

  describe('token mode is unchanged', () => {
    it('still connects as v1_{PUBKEY} with the minted token and never loads credentials', async () => {
      const mintToken = minter();
      const loadCredentials = loader({ kind: 'ok', username: BROKER_USER, password: BROKER_PASS });
      const publisher = new MeshCoreObserverPublisher({
        sourceId: SOURCE_ID,
        config: makeTokenConfig(),
        device: makeDevice(PUBKEY),
        mintToken,
        loadCredentials,
      });

      await startAndConnect(publisher);

      const opts = lastConnectOptions();
      expect(opts.username).toBe(`v1_${PUBKEY}`);
      expect(opts.password).toBe(TOKEN_STRING);
      expect(loadCredentials).not.toHaveBeenCalled();
      expect(mintToken).toHaveBeenCalledWith(SOURCE_ID, 'aud.test');

      const status = publisher.getStatus();
      expect(status.authMode).toBe('token');
      expect(status.tokenExpiresAt).toBeGreaterThan(0);
    });

    it('an explicit authMode:token behaves identically to an absent one', async () => {
      const publisher = new MeshCoreObserverPublisher({
        sourceId: SOURCE_ID,
        config: makeTokenConfig(),
        device: makeDevice(PUBKEY),
        mintToken: minter(),
        loadCredentials: loader({ kind: 'none' }),
      });

      await startAndConnect(publisher);
      expect(lastConnectOptions().username).toBe(`v1_${PUBKEY}`);
      expect(publisher.getStatus().authMode).toBe('token');
    });

    it('still requires a tokenAudience to count as configured', async () => {
      // No audience -> normalizeObserverBrokers drops the (only) broker
      // entirely, leaving `brokers: []` — exactly what a hand-built
      // NormalizedObserverConfig looks like for "nothing usable configured"
      // (§2.3 rule 6 / §5.1's `configured: ANY broker configured`).
      const publisher = new MeshCoreObserverPublisher({
        sourceId: SOURCE_ID,
        config: makeTokenConfig({ tokenAudience: undefined }),
        device: makeDevice(PUBKEY),
        mintToken: minter(),
        loadCredentials: loader({ kind: 'none' }),
      });
      expect(publisher.getStatus().configured).toBe(false);
    });
  });
});
