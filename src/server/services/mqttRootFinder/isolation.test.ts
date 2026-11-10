/**
 * Mesh-isolation guard for the MQTT root finder (#6287).
 *
 * The finder must have zero mesh impact: it subscribes only. These tests are
 * the proof. They are NOT optional coverage: a failure here means a change
 * made the finder able to publish, ingest, write, or notify.
 *
 *   (a) MqttBrokerClient.publish is never called, across a full sample, a
 *       cancel and an auth failure;
 *   (b) the sampler's connect options carry no `will`, and the client id is a
 *       fresh `mm-roots-` one;
 *   (c) ingestion, the event bus and database writes see 0 calls;
 *   (d) no file under mqttRootFinder/ imports a forbidden module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- recorders for modules that must never be touched -----------------------
const touched: string[] = [];
const recorder = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then' || prop === Symbol.toPrimitive || prop === '__esModule') return undefined;
        touched.push(`${name}.${String(prop)}`);
        return () => undefined;
      },
    },
  );

vi.mock('../../mqttIngestion.js', () => ({
  ingestServiceEnvelope: vi.fn(() => {
    touched.push('ingestServiceEnvelope');
  }),
}));
vi.mock('../dataEventEmitter.js', () => ({
  dataEventEmitter: recorder('dataEventEmitter'),
  default: recorder('dataEventEmitter'),
}));
vi.mock('../../../services/database.js', () => ({
  default: recorder('databaseService'),
}));

// --- fake mqtt.js ---------------------------------------------------------
const fakes: any[] = [];
function makeFake() {
  const c = new EventEmitter() as any;
  c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
  c.subscribe = vi.fn((topics: string[], _o: unknown, cb?: any) =>
    cb && cb(null, topics.map((t) => ({ topic: t, qos: 0 })), {}),
  );
  c.unsubscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null));
  c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
  c.reconnect = vi.fn();
  fakes.push(c);
  return c;
}
vi.mock('mqtt', () => ({ connect: vi.fn(() => makeFake()) }));
vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { connect } from 'mqtt';
import { MqttBrokerClient } from '../../transports/mqttBrokerClient.js';
import { RootSampler } from './rootSampler.js';
import { meshtasticRootAdapter } from './meshtasticRootAdapter.js';
import { meshcoreRegionAdapter } from './meshcoreRegionAdapter.js';

const connectOpts = () => (connect as any).mock.calls.at(-1)[1];
const tick = () => new Promise((r) => setImmediate(r));

function makeSampler(durationMs = 60_000, protocol: 'meshtastic' | 'meshcore' = 'meshtastic') {
  return new RootSampler({
    broker: { url: 'mqtt://10.1.2.3:1883', username: 'u', password: 'p' },
    regionRoot: protocol === 'meshcore' ? 'meshcore' : 'msh/US',
    adapter: protocol === 'meshcore' ? meshcoreRegionAdapter : meshtasticRootAdapter,
    durationMs,
  });
}

let publishSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  touched.length = 0;
  fakes.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  publishSpy = vi.spyOn(MqttBrokerClient.prototype, 'publish');
});
afterEach(() => {
  publishSpy.mockRestore();
  vi.useRealTimers();
});

/** Bring the fake socket up the way mqtt.js does. */
async function connectUp(s: RootSampler) {
  const started = s.start();
  await tick();
  fakes[0].emit('connect');
  await started;
}

const noMeshSideEffects = () => {
  expect(publishSpy).not.toHaveBeenCalled();
  for (const f of fakes) expect(f.publish).not.toHaveBeenCalled();
  expect(touched).toEqual([]);
};

describe('root finder isolation (a)(c): no publish, no ingest, no writes', () => {
  it('a full sample publishes nothing and touches no ingest, event bus or database', async () => {
    const s = makeSampler(60_000);
    await connectUp(s);
    for (let i = 0; i < 400; i++) fakes[0].emit('message', 'msh/US/2/e/LongFast/!aaaaaaaa', Buffer.from([1, 2]), {});
    fakes[0].emit('message', 'msh/US/WA/2/map/', Buffer.from([0xff]), { retain: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await s.whenDone();
    expect(s.getStatus()).toBe('done');
    noMeshSideEffects();
  });

  it('a full MeshCore region sample publishes nothing and touches no ingest, event bus or database', async () => {
    const s = makeSampler(60_000, 'meshcore');
    await connectUp(s);
    const key = 'AB'.repeat(32);
    const body = Buffer.from(
      JSON.stringify({ status: 'online', timestamp: new Date().toISOString(), origin: 'o', origin_id: key }),
    );
    for (let i = 0; i < 400; i++) fakes[0].emit('message', `meshcore/MCO/${key}/status`, body, { retain: true });
    fakes[0].emit('message', `meshcore/TPA/${key}/status`, body, {});
    await vi.advanceTimersByTimeAsync(60_000);
    await s.whenDone();
    expect(s.getStatus()).toBe('done');
    expect(s.snapshot().heard.find((h) => h.root === 'MCO')).toMatchObject({ nodes: 1, messages: 400 });
    const topics: string[] = fakes[0].subscribe.mock.calls.flatMap((c: unknown[]) => c[0] as string[]);
    expect(topics).toEqual(['meshcore/+/+/status']);
    expect(fakes[0].unsubscribe).not.toHaveBeenCalled();
    noMeshSideEffects();
  });

  it('a cancel publishes nothing', async () => {
    const s = makeSampler();
    await connectUp(s);
    fakes[0].emit('message', 'msh/US/2/e/LongFast/!aaaaaaaa', Buffer.from([1]), {});
    await s.cancel();
    expect(s.getStatus()).toBe('cancelled');
    noMeshSideEffects();
  });

  it('an auth failure publishes nothing and does not retry', async () => {
    const s = makeSampler();
    const started = s.start();
    await tick();
    const err = Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 });
    fakes[0].emit('error', err);
    await started;
    await s.whenDone();
    expect(s.snapshot()).toMatchObject({ status: 'failed', error: 'AUTH_REJECTED' });
    // no reconnect, no new connection
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes).toHaveLength(1);
    expect(fakes[0].reconnect).not.toHaveBeenCalled();
    noMeshSideEffects();
  });

  it('an unreachable broker publishes nothing and does not retry', async () => {
    const s = makeSampler();
    const started = s.start();
    await tick();
    fakes[0].emit('error', new Error('connect ECONNREFUSED 10.1.2.3:1883'));
    await started;
    await s.whenDone();
    expect(s.snapshot().error).toBe('UNREACHABLE');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes[0].reconnect).not.toHaveBeenCalled();
    noMeshSideEffects();
  });

  it('a mid-sample drop ends the sample without a reconnect', async () => {
    const s = makeSampler();
    await connectUp(s);
    fakes[0].emit('close');
    await s.whenDone();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes[0].reconnect).not.toHaveBeenCalled();
    expect(s.snapshot().status).toBe('failed');
    noMeshSideEffects();
  });
});

describe('root finder isolation (b): connect options', () => {
  it('has no will, a fresh mm-roots client id, and mqtt.js auto-reconnect off', async () => {
    const s = makeSampler();
    await connectUp(s);
    const o = connectOpts();
    expect(o).not.toHaveProperty('will');
    expect(o.clientId).toMatch(/^mm-roots-[a-z0-9]+$/);
    expect(o.clean).toBe(true);
    expect(o.reconnectPeriod).toBe(0);
    expect(o.connectTimeout).toBe(10_000);
    await s.cancel();
  });

  it('two samples never share a client id', async () => {
    const a = makeSampler();
    await connectUp(a);
    const idA = connectOpts().clientId;
    await a.cancel();
    const b = makeSampler();
    const started = b.start();
    await tick();
    fakes[1].emit('connect');
    await started;
    expect(connectOpts().clientId).not.toBe(idA);
    await b.cancel();
  });

  it('subscribes to the 8 filters and never to #', async () => {
    const s = makeSampler();
    await connectUp(s);
    const topics: string[] = fakes[0].subscribe.mock.calls.flatMap((c: unknown[]) => c[0] as string[]);
    expect(topics).toHaveLength(8);
    expect(topics.some((t) => t.includes('#'))).toBe(false);
    await s.cancel();
  });
});

describe('root finder isolation (d): import boundary', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['source manager registry', /sourceManagerRegistry/],
    ['Meshtastic manager', /meshtasticManager/],
    ['MeshCore manager', /meshcoreManager/],
    ['MeshCore MQTT ingest manager', /meshcoreMqttManager/],
    ['MeshCore observer publisher', /meshcoreObserverPublisher/],
    ['MQTT broker manager', /mqttBrokerManager/],
    ['MQTT bridge manager / publisher pool', /mqttBridge(Manager|PublisherPool)/],
    ['MQTT ingestion', /mqttIngestion/],
    ['event bus', /dataEventEmitter/],
    ['database service', /services\/database(\.js)?['"]/],
    ['db repositories', /db\/repositories/],
    ['notification services', /(apprise|notification|pushNotification)/i],
    ['automation engine', /automation/i],
    ['MQTT broker (embedded)', /transports\/mqttBroker\.js/],
  ];

  // The offline geocoder (#6336) feeds the finder, so it is held to the same rules.
  const geoDir = path.join(dir, '../offlineGeocoder');
  const sources = (d: string, prefix: string) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => ({ file: prefix + f, full: path.join(d, f) }));
  const all = [...sources(dir, ''), ...sources(geoDir, 'offlineGeocoder/')];
  const files = all.map((f) => f.file);

  it('finds the finder and geocoder sources', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'rootSampler.ts',
        'rootFinderService.ts',
        'ladder.ts',
        'meshcoreRegionAdapter.ts',
        'offlineGeocoder/reverseGeocode.ts',
        'offlineGeocoder/pip.ts',
        'offlineGeocoder/codec.ts',
      ]),
    );
  });

  it('the geocoder does no network or file I/O', () => {
    for (const { file, full } of all.filter((f) => f.file.startsWith('offlineGeocoder/'))) {
      const src = readFileSync(full, 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(/^(fs|net|http|https|dns|tls|child_process|mqtt)$|^node:/.test(spec), `${file} imports ${spec}`).toBe(false);
      }
    }
  });

  for (const { file, full } of all) {
    it(`${file} imports no forbidden module`, () => {
      const src = readFileSync(full, 'utf8');
      const imports = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const dynamic = [...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      for (const spec of [...imports, ...dynamic]) {
        for (const [label, re] of FORBIDDEN) {
          expect(re.test(`'${spec}'`), `${file} imports ${spec} (${label})`).toBe(false);
        }
      }
    });

    it(`${file} has no publish call`, () => {
      const src = readFileSync(full, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(/\.publish\s*\(/.test(code)).toBe(false);
    });
  }
});
