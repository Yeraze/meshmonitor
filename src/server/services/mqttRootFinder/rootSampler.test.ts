import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  RootSampler,
  buildSamplerClientOptions,
  MAX_NODES_PER_ROOT,
  MAX_MESSAGES,
  MAX_PAYLOAD_BYTES,
  MAX_ROOTS,
  type SamplerClient,
} from './rootSampler.js';
import { meshtasticRootAdapter } from './meshtasticRootAdapter.js';
import { createMeshcoreRegionAdapter } from './meshcoreRegionAdapter.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../../protobufLoader.js';

class FakeClient extends EventEmitter implements SamplerClient {
  connected = false;
  canSubscribe = true;
  connectFails = false;
  lastError: string | null = null;
  subscribe = vi.fn(async (_t: string[]) => undefined);
  unsubscribe = vi.fn(async (_t: string[]) => undefined);
  disconnect = vi.fn(async () => {
    this.connected = false;
  });
  publish = vi.fn();
  async connect() {
    this.connected = !this.connectFails;
    if (this.connectFails) this.emit('error', new Error(this.lastError ?? 'ECONNREFUSED'));
  }
  isConnected() {
    return this.connected;
  }
  getLastError() {
    return this.lastError;
  }
  getCapabilities() {
    return { canSubscribe: this.canSubscribe };
  }
  msg(topic: string, payload: Buffer = Buffer.from([1, 2, 3]), retained = false) {
    this.emit('message', { topic, payload, retained });
  }
}

let fake: FakeClient;
function make(over: Partial<ConstructorParameters<typeof RootSampler>[0]> = {}, durationMs = 60_000) {
  return new RootSampler({
    broker: { url: 'mqtt://broker.test:1883', username: 'u', password: 'p' },
    regionRoot: 'msh/US',
    adapter: meshtasticRootAdapter,
    durationMs,
    createClient: () => fake,
    ...over,
  });
}

beforeEach(() => {
  fake = new FakeClient();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('sampler client options', () => {
  it('uses a fresh mm-roots id, no will, one auth try, one eviction, no reconnect', () => {
    const o = buildSamplerClientOptions({ url: 'mqtt://b:1883', username: 'u', password: 'p' });
    expect(o.clientIdPrefix).toBe('mm-roots');
    expect(o).not.toHaveProperty('clientId');
    expect(o).not.toHaveProperty('will');
    expect(o.maxAuthFailures).toBe(1);
    expect(o.maxEvictions).toBe(1);
    expect(o.autoReconnect).toBe(false);
    expect(o.connectTimeoutMs).toBe(10_000);
  });
});

describe('meshtastic adapter filters', () => {
  it('builds exactly the 8 R2 filters and never #', () => {
    const f = meshtasticRootAdapter.filters('msh/US');
    expect(f).toEqual([
      'msh/US/2/map/',
      'msh/US/2/e/+/+',
      'msh/US/+/2/map/',
      'msh/US/+/2/e/+/+',
      'msh/US/+/+/2/map/',
      'msh/US/+/+/2/e/+/+',
      'msh/US/+/+/+/2/map/',
      'msh/US/+/+/+/2/e/+/+',
    ]);
    expect(f.some((t) => t.includes('#'))).toBe(false);
  });
});

describe('RootSampler', () => {
  it('subscribes to the 8 filters once connected', async () => {
    const s = make();
    await s.start();
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribe.mock.calls[0][0]).toHaveLength(8);
    expect(s.getStatus()).toBe('sampling');
    await s.cancel();
  });

  it('counts messages and distinct gateways per root', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa');
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa');
    fake.msg('msh/US/2/e/LongFast/!bbbbbbbb');
    fake.msg('msh/US/WA/2/e/LongFast/!cccccccc');
    fake.msg('msh/US/2/json/LongFast/!aaaaaaaa'); // ignored
    const snap = s.snapshot();
    const us = snap.heard.find((h) => h.root === 'msh/US')!;
    expect(us).toMatchObject({ messages: 3, nodes: 2, retainedOnly: false });
    expect(snap.heard.find((h) => h.root === 'msh/US/WA')).toMatchObject({ messages: 1, nodes: 1 });
    await s.cancel();
  });

  it('flags retained-only roots', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/OR/2/e/LongFast/!aaaaaaaa', Buffer.from([1]), true);
    expect(s.snapshot().heard[0]).toMatchObject({ root: 'msh/US/OR', retainedOnly: true });
    fake.msg('msh/US/OR/2/e/LongFast/!aaaaaaaa', Buffer.from([1]), false);
    expect(s.snapshot().heard[0].retainedOnly).toBe(false);
    await s.cancel();
  });

  it('cuts the region stream after 300 packets and marks a floor', async () => {
    const s = make();
    await s.start();
    for (let i = 0; i < 299; i++) fake.msg(`msh/US/2/e/LongFast/!${String(i).padStart(8, '0')}`);
    expect(fake.unsubscribe).not.toHaveBeenCalled();
    fake.msg('msh/US/2/e/LongFast/!99999999');
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledWith(['msh/US/2/e/+/+']);
    const snap = s.snapshot();
    expect(snap.regionFloor).toBe(true);
    expect(snap.heard.find((h) => h.root === 'msh/US')).toMatchObject({ floor: true });
    // more packets do not unsubscribe again
    fake.msg('msh/US/2/e/LongFast/!99999998');
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    await s.cancel();
  });

  it('marks a flooded sub-root as a floor without unsubscribing', async () => {
    const s = make();
    await s.start();
    for (let i = 0; i < 300; i++) fake.msg('msh/US/TX/2/e/LongFast/!aaaaaaaa');
    expect(fake.unsubscribe).not.toHaveBeenCalled();
    expect(s.snapshot().heard.find((h) => h.root === 'msh/US/TX')?.floor).toBe(true);
    await s.cancel();
  });

  it('drops payloads over 4 KB', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa', Buffer.alloc(MAX_PAYLOAD_BYTES + 1));
    expect(s.snapshot().heard).toHaveLength(0);
    await s.cancel();
  });

  it('caps distinct roots, nodes per root and total messages', async () => {
    const s = make();
    await s.start();
    for (let i = 0; i < MAX_ROOTS + 20; i++) fake.msg(`msh/US/r${i}/2/e/LongFast/!aaaaaaaa`);
    expect(s.snapshot().heard).toHaveLength(MAX_ROOTS);
    for (let i = 0; i < MAX_NODES_PER_ROOT + 20; i++) {
      fake.msg(`msh/US/r0/2/e/LongFast/!${i.toString(16).padStart(8, '0')}`);
    }
    expect(s.snapshot().heard.find((h) => h.root === 'msh/US/r0')!.nodes).toBe(MAX_NODES_PER_ROOT);
    await s.cancel();
  });

  it('stops early after the total message cap', async () => {
    const s = make();
    await s.start();
    for (let i = 0; i <= MAX_MESSAGES + 1; i++) fake.msg('msh/US/TX/2/e/LongFast/!aaaaaaaa');
    await s.whenDone();
    expect(s.getStatus()).toBe('done');
    expect(s.snapshot().heard[0].messages).toBe(MAX_MESSAGES);
  });

  it('ends on its own after the duration and disconnects', async () => {
    const s = make({}, 60_000);
    await s.start();
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa');
    await vi.advanceTimersByTimeAsync(60_000);
    await s.whenDone();
    expect(s.getStatus()).toBe('done');
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(s.snapshot().heard).toHaveLength(1);
    expect(s.snapshot().elapsedMs).toBe(60_000);
  });

  it('clears the timer on cancel and keeps partial results', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa');
    await s.cancel();
    expect(s.getStatus()).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
    expect(s.snapshot().heard).toHaveLength(1);
    // messages after cancel are ignored
    fake.msg('msh/US/2/e/LongFast/!bbbbbbbb');
    expect(s.snapshot().heard[0].messages).toBe(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it('ends with a coarse UNREACHABLE and does not leak the raw error', async () => {
    fake.connectFails = true;
    fake.lastError = 'connect ECONNREFUSED 10.0.0.5:1883';
    const s = make();
    await s.start();
    expect(s.getStatus()).toBe('failed');
    const snap = s.snapshot();
    expect(snap.error).toBe('UNREACHABLE');
    expect(JSON.stringify(snap)).not.toContain('ECONNREFUSED');
    expect(fake.disconnect).toHaveBeenCalled();
  });

  it('maps a connect timeout to TIMEOUT', async () => {
    fake.connectFails = true;
    fake.lastError = 'connack timeout';
    const s = make();
    await s.start();
    expect(s.snapshot().error).toBe('TIMEOUT');
  });

  it('maps a rejected login to AUTH_REJECTED', async () => {
    fake.connectFails = true;
    const s = make();
    const p = s.start();
    fake.emit('permission-denied', { kind: 'auth', message: 'Broker rejected username or password.' });
    await p;
    expect(s.snapshot().error).toBe('AUTH_REJECTED');
    expect(s.snapshot().status).toBe('failed');
  });

  it('maps all-denied subscriptions to SUBSCRIBE_DENIED', async () => {
    fake.canSubscribe = false;
    const s = make();
    await s.start();
    expect(s.snapshot()).toMatchObject({ status: 'failed', error: 'SUBSCRIBE_DENIED' });
  });

  it('ends with EVICTED when the broker drops us mid-sample, keeping what it heard', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa');
    fake.emit('close');
    await s.whenDone();
    expect(s.snapshot()).toMatchObject({ status: 'failed', error: 'EVICTED' });
    expect(s.snapshot().heard).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never publishes', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/2/e/LongFast/!aaaaaaaa');
    await s.cancel();
    expect(fake.publish).not.toHaveBeenCalled();
  });
});

describe('meshtastic map reports', () => {
  it('records the reporting node position and the root', async () => {
    await loadProtobufDefinitions();
    const root = getProtobufRoot()!;
    const MapReport = root.lookupType('meshtastic.MapReport');
    const Data = root.lookupType('meshtastic.Data');
    const MeshPacket = root.lookupType('meshtastic.MeshPacket');
    const ServiceEnvelope = root.lookupType('meshtastic.ServiceEnvelope');
    const report = MapReport.encode(
      MapReport.create({ latitudeI: 479000000, longitudeI: -1221000000 }),
    ).finish();
    const data = Data.encode(Data.create({ portnum: 73, payload: report })).finish();
    const pkt = MeshPacket.create({ from: 0x11223344, decoded: Data.decode(data) });
    const env = ServiceEnvelope.encode(
      ServiceEnvelope.create({ packet: pkt, channelId: 'LongFast', gatewayId: '!11223344' }),
    ).finish();

    const s = make();
    await s.start();
    fake.msg('msh/US/WA/2/map/', Buffer.from(env));
    const h = s.snapshot().heard.find((x) => x.root === 'msh/US/WA')!;
    expect(h.nodes).toBe(1);
    expect(h.positions).toHaveLength(1);
    expect(h.positions![0].lat).toBeCloseTo(47.9, 3);
    expect(h.positions![0].lon).toBeCloseTo(-122.1, 3);
    await s.cancel();
  });

  it('still counts an undecodable map report', async () => {
    const s = make();
    await s.start();
    fake.msg('msh/US/WA/2/map/', Buffer.from([0xff, 0xff, 0xff]));
    expect(s.snapshot().heard.find((x) => x.root === 'msh/US/WA')?.messages).toBe(1);
    await s.cancel();
  });
});

describe('meshcore region sampling (#6335)', () => {
  const NOW = Date.parse('2026-11-10T12:00:00Z');
  const key = (n: number) => n.toString(16).toUpperCase().padStart(64, '0');
  const status = (k: string, over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({ status: 'online', timestamp: new Date(NOW).toISOString(), origin: 'o', origin_id: k, ...over }),
    );
  const mc = () =>
    make({ regionRoot: 'meshcore', adapter: createMeshcoreRegionAdapter(() => NOW), broker: { url: 'mqtt://b:1883' } });

  it('subscribes once to the status filter and never unsubscribes', async () => {
    const s = mc();
    await s.start();
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.subscribe.mock.calls[0][0]).toEqual(['meshcore/+/+/status']);
    for (let i = 0; i < 400; i++) fake.msg(`meshcore/MCO/${key(1)}/status`, status(key(1)), true);
    expect(fake.unsubscribe).not.toHaveBeenCalled();
    await s.cancel();
  });

  it('counts active observers and status messages per region, retained included', async () => {
    const s = mc();
    await s.start();
    fake.msg(`meshcore/MCO/${key(1)}/status`, status(key(1)), true);
    fake.msg(`meshcore/MCO/${key(2)}/status`, status(key(2)), true);
    fake.msg(`meshcore/MCO/${key(3)}/status`, status(key(3), { status: 'offline' }), true);
    fake.msg(`meshcore/TPA/${key(4)}/status`, status(key(4), { timestamp: undefined }), true);
    fake.msg(`meshcore/TPA/${key(5)}/status`, status(key(5), { timestamp: undefined }), false);
    fake.msg(`meshcore/TPA/${key(6)}/packets`, status(key(6)), false); // not a status topic
    const heard = s.snapshot().heard;
    expect(heard.find((h) => h.root === 'MCO')).toMatchObject({ nodes: 2, messages: 3, retainedOnly: true });
    expect(heard.find((h) => h.root === 'TPA')).toMatchObject({ nodes: 1, messages: 2, retainedOnly: false });
    await s.cancel();
  });

  it('honours MAX_ROOTS', async () => {
    const s = mc();
    await s.start();
    for (let i = 0; i < MAX_ROOTS + 5; i++) {
      fake.msg(`meshcore/R${i}/${key(i + 1)}/status`, status(key(i + 1)), true);
    }
    expect(s.snapshot().heard).toHaveLength(MAX_ROOTS);
    await s.cancel();
  });

  it('passes rejectUnauthorized: false through only when set', () => {
    expect(buildSamplerClientOptions({ url: 'mqtts://b:8883', rejectUnauthorized: false }).rejectUnauthorized).toBe(false);
    expect(buildSamplerClientOptions({ url: 'mqtts://b:8883' })).not.toHaveProperty('rejectUnauthorized');
  });
});
