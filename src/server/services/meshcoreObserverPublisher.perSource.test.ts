/**
 * meshcoreObserverPublisher per-source isolation tests (#4457 Phase 2, WP4 —
 * spec §7.4). Two publishers, two distinct sources: distinct topics,
 * distinct clients, independent counters, and `mintToken` invoked with the
 * correct `sourceId` for each. This is the multi-source architecture's
 * mandatory isolation guarantee (see CLAUDE.md "Adding a Per-Source
 * Feature") applied to the observer publisher.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { EventEmitter } from 'events';

type PublishCallback = (err?: Error) => void;
type PublishOpts = { qos: number; retain: boolean };

interface FakeMqttClient extends EventEmitter {
  subscribe: MockedFunction<(topics: string[], opts: { qos: number }, cb?: () => void) => void>;
  publish: MockedFunction<(topic: string, payload: Buffer, opts: PublishOpts, cb?: PublishCallback) => void>;
  end: MockedFunction<(force: boolean, opts: Record<string, never>, cb?: () => void) => void>;
  reconnect: MockedFunction<() => void>;
}

function makeFakeClient(): FakeMqttClient {
  const c = new EventEmitter() as FakeMqttClient;
  c.subscribe = vi.fn((_topics: string[], _opts: { qos: number }, cb?: () => void) => {
    cb?.();
  }) as FakeMqttClient['subscribe'];
  c.publish = vi.fn((_topic: string, _payload: Buffer, _opts: PublishOpts, cb?: PublishCallback) => {
    cb?.();
  }) as FakeMqttClient['publish'];
  c.end = vi.fn((_force: boolean, _opts: Record<string, never>, cb?: () => void) => {
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
  type MeshCoreObserverPublisherOptions,
} from './meshcoreObserverPublisher.js';
import type { ObserverToken, ObserverTokenResult } from './meshcoreObserverToken.js';

const mockConnect = connect as MockedFunction<typeof connect>;
const lastFakeClient = (): FakeMqttClient => mockConnect.mock.results.at(-1)!.value as FakeMqttClient;
const lastConnectOptions = () => mockConnect.mock.calls.at(-1)![1];

interface SourceFixture {
  sourceId: string;
  pubkey: string;
  tokenString: string;
  iataCode: string;
  origin: string;
}

const SOURCE_A: SourceFixture = {
  sourceId: 'src-observer-A',
  pubkey: 'AA'.repeat(32),
  tokenString: 'headerA.payloadA.' + 'a'.repeat(128),
  iataCode: 'JFK',
  origin: 'NodeA',
};

const SOURCE_B: SourceFixture = {
  sourceId: 'src-observer-B',
  pubkey: 'BB'.repeat(32),
  tokenString: 'headerB.payloadB.' + 'b'.repeat(128),
  iataCode: 'LHR',
  origin: 'NodeB',
};

function makeToken(fixture: SourceFixture): ObserverToken {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    token: fixture.tokenString,
    publicKey: fixture.pubkey,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 86_400,
  };
}

function makeMintToken(
  fixture: SourceFixture,
): MockedFunction<(sourceId: string, audience: string) => Promise<ObserverTokenResult>> {
  const fn = vi.fn() as MockedFunction<(sourceId: string, audience: string) => Promise<ObserverTokenResult>>;
  fn.mockResolvedValue({ kind: 'ok', token: makeToken(fixture) });
  return fn;
}

function makePublisher(
  fixture: SourceFixture,
  mintToken: MockedFunction<(sourceId: string, audience: string) => Promise<ObserverTokenResult>>,
): MeshCoreObserverPublisher {
  const url = 'mqtt://broker.test:1883';
  const config: MeshCoreObserverPublisherOptions['config'] = {
    enabled: true,
    iataCode: fixture.iataCode,
    brokers: [{ key: url.toLowerCase(), url, authMode: 'token', tokenAudience: 'aud.test', legacy: true }],
    authMode: 'token',
    brokerUrl: url,
    tokenAudience: 'aud.test',
  };
  return new MeshCoreObserverPublisher({
    sourceId: fixture.sourceId,
    config,
    device: () => ({ origin: fixture.origin }),
    mintToken,
  });
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
  return client;
}

describe('MeshCoreObserverPublisher — per-source isolation (#4457 §7.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives each source distinct topics and a distinct client', async () => {
    const mintA = makeMintToken(SOURCE_A);
    const mintB = makeMintToken(SOURCE_B);
    const pubA = makePublisher(SOURCE_A, mintA);
    await startAndConnect(pubA);
    const optsA = lastConnectOptions();

    const pubB = makePublisher(SOURCE_B, mintB);
    await startAndConnect(pubB);
    const optsB = lastConnectOptions();

    expect(optsA.will!.topic).toBe(`meshcore/JFK/${SOURCE_A.pubkey}/status`);
    expect(optsB.will!.topic).toBe(`meshcore/LHR/${SOURCE_B.pubkey}/status`);
    expect(optsA.username).toBe(`v1_${SOURCE_A.pubkey}`);
    expect(optsB.username).toBe(`v1_${SOURCE_B.pubkey}`);
    expect(optsA.password).not.toBe(optsB.password);
  });

  it('calls mintToken with the correct sourceId for each publisher', async () => {
    const mintA = makeMintToken(SOURCE_A);
    const mintB = makeMintToken(SOURCE_B);
    const pubA = makePublisher(SOURCE_A, mintA);
    const pubB = makePublisher(SOURCE_B, mintB);

    await startAndConnect(pubA);
    await startAndConnect(pubB);

    expect(mintA).toHaveBeenCalledWith(SOURCE_A.sourceId, 'aud.test');
    expect(mintB).toHaveBeenCalledWith(SOURCE_B.sourceId, 'aud.test');
    expect(mintA).not.toHaveBeenCalledWith(SOURCE_B.sourceId, 'aud.test');
    expect(mintB).not.toHaveBeenCalledWith(SOURCE_A.sourceId, 'aud.test');
  });

  it('never cross-delivers a packet handed to A onto B\'s client, and keeps counters independent', async () => {
    const mintA = makeMintToken(SOURCE_A);
    const mintB = makeMintToken(SOURCE_B);
    const pubA = makePublisher(SOURCE_A, mintA);
    const clientA = await startAndConnect(pubA);
    const pubB = makePublisher(SOURCE_B, mintB);
    const clientB = await startAndConnect(pubB);

    clientA.publish.mockClear();
    clientB.publish.mockClear();

    // Three packets to A only.
    pubA.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    pubA.handleOtaPacket({ snr: 2, rssi: -2, raw_hex: '0900bb' });
    pubA.handleOtaPacket({ snr: 3, rssi: -3, raw_hex: '0900cc' });
    await flushMicrotasks();

    expect(clientA.publish).toHaveBeenCalledTimes(3);
    expect(clientB.publish).not.toHaveBeenCalled();
    for (const call of clientA.publish.mock.calls) {
      expect(call[0]).toBe(`meshcore/JFK/${SOURCE_A.pubkey}/packets`);
    }

    // One packet to B only.
    pubB.handleOtaPacket({ snr: 9, rssi: -9, raw_hex: '0900dd' });
    await flushMicrotasks();

    expect(clientB.publish).toHaveBeenCalledTimes(1);
    expect(clientB.publish.mock.calls[0]![0]).toBe(`meshcore/LHR/${SOURCE_B.pubkey}/packets`);
    // A's count is unaffected by B's activity.
    expect(clientA.publish).toHaveBeenCalledTimes(3);

    expect(pubA.getStatus().publishes).toBe(3);
    expect(pubB.getStatus().publishes).toBe(1);
    expect(pubA.getStatus().dropped).toBe(0);
    expect(pubB.getStatus().dropped).toBe(0);
  });

  it('drops for one source independently of the other being connected', async () => {
    const mintA = makeMintToken(SOURCE_A);
    const mintB = makeMintToken(SOURCE_B);
    const pubA = makePublisher(SOURCE_A, mintA);
    await startAndConnect(pubA);

    // B started but never connected — its socket stays down.
    const pubB = makePublisher(SOURCE_B, mintB);
    const startPromiseB = pubB.start();
    await flushMicrotasks(30);
    const clientB = lastFakeClient();

    pubB.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900aa' });
    pubB.handleOtaPacket({ snr: 1, rssi: -1, raw_hex: '0900bb' });

    expect(pubB.getStatus().dropped).toBe(2);
    expect(pubA.getStatus().dropped).toBe(0);

    clientB.emit('error', new Error('unreachable'));
    await startPromiseB;
  });
});
