/**
 * MQTT root finder routes (#6287). Real session, auth and permission
 * middleware via the route harness; the sampler is a stub, so no test ever
 * opens a connection to a broker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { createMqttRootFinderRouter } from './mqttRootFinderRoutes.js';
import { mqttRootFinderLimiter } from '../middleware/rateLimiters.js';
import { RootFinderService } from '../services/mqttRootFinder/rootFinderService.js';
import type { RootSamplerOptions, SamplerSnapshot, SamplerStatus } from '../services/mqttRootFinder/rootSampler.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
    getPrimaryMeshtasticSourceId: vi.fn().mockReturnValue(undefined),
  },
}));

class StubSampler {
  status: SamplerStatus = 'sampling';
  heard: SamplerSnapshot['heard'] = [];
  endedAt: number | null = null;
  constructor(public readonly opts: RootSamplerOptions) {
    stubs.push(this);
  }
  async start() {}
  getStatus() {
    return this.status;
  }
  snapshot(): SamplerSnapshot {
    return {
      status: this.status,
      elapsedMs: 5000,
      durationMs: 60_000,
      regionFloor: false,
      heard: this.heard,
    };
  }
  getEndedAt() {
    return this.endedAt;
  }
  end(status: SamplerStatus) {
    this.status = status;
    this.endedAt = now;
  }
  async cancel() {
    this.end('cancelled');
  }
}
let stubs: StubSampler[] = [];
let now = 1_000_000;

let harness: RouteTestHarness;
let service: RootFinderService;

const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();

async function mount(startLimiter: any = passthrough) {
  service = new RootFinderService({
    now: () => now,
    createSampler: (o) => new StubSampler(o) as any,
  });
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/mqtt/root-finder', createMqttRootFinderRouter({ service, startLimiter })),
  });
}

const bridgeBody = (over: Record<string, unknown> = {}) => ({
  context: 'bridge',
  broker: { url: 'mqtt://10.1.2.3:1883' },
  regionRoot: 'msh/US',
  ...over,
});

beforeEach(() => {
  stubs = [];
  now = 1_000_000;
});
afterEach(async () => {
  await harness.db.sources.deleteSource('rt-bridge').catch(() => undefined);
  await harness.cleanup();
});

describe('POST /samples permissions', () => {
  beforeEach(async () => {
    await mount();
  });

  it('401 without a session', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    expect(res.status).toBe(401);
  });

  it('403 for a viewer with no grants', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    expect(res.status).toBe(403);
    expect(stubs).toHaveLength(0);
  });

  it('bridge needs sources:write', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sampleId).toBeTruthy();
  });

  it('device needs configuration:write on THAT source', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const body = { context: 'device', broker: { address: '10.1.2.3', tlsEnabled: false }, regionRoot: 'msh/US' };

    const wrong = await agent.post('/api/mqtt/root-finder/samples').send({ ...body, sourceId: harness.sourceB });
    expect(wrong.status).toBe(403);
    const none = await agent.post('/api/mqtt/root-finder/samples').send(body);
    expect(none.status).toBe(400); // no primary source to fall back to
    const right = await agent.post('/api/mqtt/root-finder/samples').send({ ...body, sourceId: harness.sourceA });
    expect(right.status).toBe(202);
  });

  it('remote_device needs configuration:write on that source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send({
      context: 'remote_device',
      sourceId: harness.sourceA,
      nodeNum: 123,
      broker: { address: '10.1.2.3', tlsEnabled: false },
      regionRoot: 'msh/US',
    });
    expect(res.status).toBe(403);
  });

  it('preset needs admin', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const limited = await harness.loginAs(harness.limited);
    const body = { context: 'preset', broker: { url: 'mqtt://10.1.2.3:1883' }, regionRoot: 'msh/US' };
    expect((await limited.post('/api/mqtt/root-finder/samples').send(body)).status).toBe(403);
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.post('/api/mqtt/root-finder/samples').send(body)).status).toBe(202);
  });
});

describe('POST /samples validation and SSRF', () => {
  beforeEach(async () => {
    await mount();
    await harness.grant(harness.limited.id, 'sources', 'write');
  });

  it('rejects an invalid or wrong-depth root', async () => {
    const agent = await harness.loginAs(harness.limited);
    for (const regionRoot of ['msh', 'msh/US/a/b', 'msh/+', 'msh//US', 'msh/US/2', '']) {
      const res = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ regionRoot }));
      expect(res.status, regionRoot).toBe(400);
      expect(res.body.code).toBe('INVALID_ROOT');
    }
  });

  it('blocks metadata, link-local and loopback targets for a non-admin', async () => {
    const agent = await harness.loginAs(harness.limited);
    for (const url of ['mqtt://169.254.169.254:1883', 'mqtt://127.0.0.1:1883', 'mqtt://localhost:1883']) {
      const res = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ broker: { url } }));
      expect(res.status, url).toBe(400);
      expect(res.body.code).toBe('ROOT_FINDER_TARGET_BLOCKED');
    }
    expect(stubs).toHaveLength(0);
  });

  it('lets an admin reach loopback but never the metadata address', async () => {
    const admin = await harness.loginAs(harness.admin);
    const lo = await admin.post('/api/mqtt/root-finder/samples').send(bridgeBody({ broker: { url: 'mqtt://127.0.0.1:1883' } }));
    expect(lo.status).toBe(202);
    const meta = await admin
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ broker: { url: 'mqtt://169.254.169.254:1883' } }));
    expect(meta.status).toBe(400);
    expect(meta.body.code).toBe('ROOT_FINDER_TARGET_BLOCKED');
  });

  it('rejects other schemes', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ broker: { url: 'ftp://10.1.2.3' } }));
    expect(res.status).toBe(400);
  });

  it('drops credentials embedded in the URL', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ broker: { url: 'mqtt://bob:secret@10.1.2.3:1883' }, username: 'typed', password: 'typedpw' }));
    expect(stubs[0].opts.broker.url).toBe('mqtt://10.1.2.3:1883');
    expect(stubs[0].opts.broker.username).toBe('typed');
  });

  it('device: an empty address means the firmware default server', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    // Resolves to a public name; the SSRF check does a real DNS lookup, so it
    // is only asserted when the lookup succeeds. A failed lookup is a block.
    const res = await agent.post('/api/mqtt/root-finder/samples').send({
      context: 'device',
      sourceId: harness.sourceA,
      broker: { address: '', tlsEnabled: false },
      regionRoot: 'msh/US',
    });
    if (res.status === 202) expect(stubs[0].opts.broker.url).toBe('mqtt://mqtt.meshtastic.org:1883');
    else expect(res.body.code).toBe('ROOT_FINDER_TARGET_BLOCKED');
  });
});

describe('stored and preset credentials', () => {
  beforeEach(async () => {
    await mount();
    await harness.grant(harness.limited.id, 'sources', 'write');
    await harness.db.sources.createSource({
      id: 'rt-bridge',
      name: 'Bridge',
      type: 'mqtt_bridge',
      enabled: false,
      config: {
        upstream: { url: 'mqtt://10.1.2.3:1883', username: 'stored-user', password: 'stored-pw' },
        subscriptions: ['msh/US/#'],
        downlinkFilters: { geo: { minLat: 40, maxLat: 42, minLng: -90, maxLng: -88 } },
      },
    } as any);
  });

  it('uses the stored login only while the endpoint is unchanged', async () => {
    const agent = await harness.loginAs(harness.limited);
    const same = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ sourceId: 'rt-bridge' }));
    expect(same.status).toBe(202);
    expect(stubs[0].opts.broker).toMatchObject({ username: 'stored-user', password: 'stored-pw' });

    stubs[0].end('done');
    now += 10 * 60_000; // clear the per-user cooldown
    const other = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ sourceId: 'rt-bridge', broker: { url: 'mqtt://10.9.9.9:1883' } }));
    expect(other.status).toBe(202);
    expect(stubs[1].opts.broker.password).toBeUndefined();
    expect(stubs[1].opts.broker.username).toBeUndefined();
  });

  it('applies the endpoint rule to admins too', async () => {
    const admin = await harness.loginAs(harness.admin);
    await admin
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ sourceId: 'rt-bridge', broker: { url: 'mqtt://10.9.9.9:1883' } }));
    expect(stubs[0].opts.broker.password).toBeUndefined();
  });

  it('typed credentials win over stored ones', async () => {
    const agent = await harness.loginAs(harness.limited);
    await agent
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ sourceId: 'rt-bridge', username: 'me', password: 'mine' }));
    expect(stubs[0].opts.broker).toMatchObject({ username: 'me', password: 'mine' });
  });

  it('reads the bridge bbox centre for ranking but never returns it', async () => {
    const agent = await harness.loginAs(harness.limited);
    const start = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ sourceId: 'rt-bridge' }));
    stubs[0].heard = [
      { root: 'msh/US/IL', nodes: 2, messages: 3, retainedOnly: false, positions: [{ lat: 41.1, lon: -89.1 }] },
    ];
    const res = await agent.get(`/api/mqtt/root-finder/samples/${start.body.data.sampleId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hasLocation).toBe(true);
    expect(res.body.data.heard[0].nearestKm).toBeTypeOf('number');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('41.1');
    expect(text).not.toContain('-89.1');
    expect(text).not.toContain('stored-pw');
    expect(text).not.toContain('positions');
  });

  it('a preset login is filled only for the preset endpoint', async () => {
    const preset = await harness.db.mqttBrokerPresets.createAsync({
      name: `rf-${Math.random()}`,
      host: '10.1.2.3',
      port: 1883,
      tls: false,
      username: 'preset-user',
      password: 'preset-pw',
      rootTopic: null,
    });
    const agent = await harness.loginAs(harness.limited);
    const good = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ brokerPresetId: preset.id }));
    expect(good.status).toBe(202);
    expect(stubs[0].opts.broker).toMatchObject({ username: 'preset-user', password: 'preset-pw' });

    stubs[0].end('done');
    now += 10 * 60_000;
    const bad = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ brokerPresetId: preset.id, broker: { url: 'mqtt://10.9.9.9:1883' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BROKER_PRESET_ENDPOINT_MISMATCH');
    expect(stubs).toHaveLength(1);
    await harness.db.mqttBrokerPresets.deleteAsync(preset.id);
  });
});

describe('caps, ownership and responses', () => {
  beforeEach(async () => {
    await mount();
    await harness.grant(harness.limited.id, 'sources', 'write');
  });

  it('429 with retryAfterSeconds while the user has a sample running', async () => {
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody())).status).toBe(202);
    const second = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ broker: { url: 'mqtt://10.5.5.5:1883' } }));
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('ROOT_FINDER_BUSY');
    expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('enforces the 2 minute cooldown after a sample ends', async () => {
    const agent = await harness.loginAs(harness.limited);
    const first = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    await agent.delete(`/api/mqtt/root-finder/samples/${first.body.data.sampleId}`);
    const again = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    expect(again.status).toBe(429);
    now += 121_000;
    const later = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    expect(later.status).toBe(202);
  });

  it('allows 1 per broker endpoint and 2 instance-wide', async () => {
    const other = await harness.db.auth.createUser({
      username: `rf-other-${Math.random()}`,
      passwordHash: null,
      authMethod: 'local',
      isAdmin: false,
      isActive: true,
      createdAt: Date.now(),
    });
    const third = await harness.db.auth.createUser({
      username: `rf-third-${Math.random()}`,
      passwordHash: null,
      authMethod: 'local',
      isAdmin: false,
      isActive: true,
      createdAt: Date.now(),
    });
    for (const id of [other, third]) await harness.grant(id, 'sources', 'write');
    const a = await harness.loginAs(harness.limited);
    const b = await harness.loginAs(other);
    const c = await harness.loginAs(third);

    expect((await a.post('/api/mqtt/root-finder/samples').send(bridgeBody())).status).toBe(202);
    // same endpoint, different user
    expect((await b.post('/api/mqtt/root-finder/samples').send(bridgeBody())).status).toBe(429);
    expect(
      (await b.post('/api/mqtt/root-finder/samples').send(bridgeBody({ broker: { url: 'mqtt://10.7.7.7:1883' } }))).status,
    ).toBe(202);
    // two running: a third user is refused anywhere
    const full = await c.post('/api/mqtt/root-finder/samples').send(bridgeBody({ broker: { url: 'mqtt://10.8.8.8:1883' } }));
    expect(full.status).toBe(429);
    await harness.db.auth.deletePermissionsForUser(other);
    await harness.db.auth.deletePermissionsForUser(third);
  });

  it("another user's sample id is a 404", async () => {
    const other = await harness.db.auth.createUser({
      username: `rf-peek-${Math.random()}`,
      passwordHash: null,
      authMethod: 'local',
      isAdmin: false,
      isActive: true,
      createdAt: Date.now(),
    });
    const owner = await harness.loginAs(harness.limited);
    const start = await owner.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    const id = start.body.data.sampleId;
    const peek = await harness.loginAs(other);
    expect((await peek.get(`/api/mqtt/root-finder/samples/${id}`)).status).toBe(404);
    expect((await peek.delete(`/api/mqtt/root-finder/samples/${id}`)).status).toBe(404);
    expect((await owner.get(`/api/mqtt/root-finder/samples/${id}`)).status).toBe(200);
  });

  it('DELETE cancels and the partial result stays readable', async () => {
    const agent = await harness.loginAs(harness.limited);
    const start = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    const id = start.body.data.sampleId;
    stubs[0].heard = [{ root: 'msh/US/WA', nodes: 1, messages: 4, retainedOnly: false }];
    const del = await agent.delete(`/api/mqtt/root-finder/samples/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true });
    const get = await agent.get(`/api/mqtt/root-finder/samples/${id}`);
    expect(get.body.data.status).toBe('cancelled');
    expect(get.body.data.heard[0].root).toBe('msh/US/WA');
  });

  it('never returns a password, login or raw error text', async () => {
    const agent = await harness.loginAs(harness.limited);
    const start = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(bridgeBody({ username: 'someuser', password: 'hunter2' }));
    stubs[0].end('failed');
    const get = await agent.get(`/api/mqtt/root-finder/samples/${start.body.data.sampleId}`);
    const text = JSON.stringify([start.body, get.body]);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('someuser');
  });

  it('drops a finished sample after 5 minutes', async () => {
    const agent = await harness.loginAs(harness.limited);
    const start = await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody());
    stubs[0].end('done');
    now += 4 * 60_000;
    expect((await agent.get(`/api/mqtt/root-finder/samples/${start.body.data.sampleId}`)).status).toBe(200);
    now += 2 * 60_000;
    expect((await agent.get(`/api/mqtt/root-finder/samples/${start.body.data.sampleId}`)).status).toBe(404);
  });
});

describe('start limiter', () => {
  it('stops the sixth start in ten minutes, even from a private IP', async () => {
    await mount(mqttRootFinderLimiter);
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    let last = 0;
    let lastBody: any;
    for (let i = 0; i < 6; i++) {
      // Invalid body: reaches the handler (limiter counts) but never a sampler.
      const res = await agent.post('/api/mqtt/root-finder/samples').send({ context: 'nope' });
      last = res.status;
      lastBody = res.body;
    }
    expect(last).toBe(429);
    expect(lastBody.code).toBe('ROOT_FINDER_BUSY');
  });
});

describe('MeshCore region finder (#6335)', () => {
  const mcBody = (over: Record<string, unknown> = {}) => ({
    context: 'meshcore_mqtt',
    broker: { url: 'mqtt://10.1.2.3:1883' },
    ...over,
  });

  beforeEach(async () => {
    await mount();
    await harness.db.sources.createSource({
      id: 'rt-mc',
      name: 'MC ingest',
      type: 'meshcore_mqtt',
      enabled: false,
      config: { brokerUrl: 'mqtt://10.1.2.3:1883', region: 'MCO', username: 'mc-user', password: 'mc-pw' },
    } as any);
  });
  afterEach(async () => {
    await harness.db.sources.deleteSource('rt-mc').catch(() => undefined);
  });

  it('403 for a viewer, 202 with sources:write, and samples the meshcore tree', async () => {
    const viewer = await harness.loginAs(harness.limited);
    expect((await viewer.post('/api/mqtt/root-finder/samples').send(mcBody())).status).toBe(403);
    expect(stubs).toHaveLength(0);

    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(mcBody({ regionRoot: 'msh/US' }));
    expect(res.status).toBe(202);
    // regionRoot is ignored: MeshCore always walks `meshcore/`.
    expect(stubs[0].opts.regionRoot).toBe('meshcore');
    expect(stubs[0].opts.adapter.filters('meshcore')).toEqual(['meshcore/+/+/status']);
    expect(stubs[0].opts.broker.rejectUnauthorized).toBeUndefined();
  });

  it('returns activity-ranked regions with no ladder, community or location', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const start = await agent.post('/api/mqtt/root-finder/samples').send(mcBody());
    stubs[0].heard = [
      { root: 'TPA', nodes: 1, messages: 5, retainedOnly: true },
      { root: 'MCO', nodes: 3, messages: 4, retainedOnly: true },
    ];
    const res = await agent.get(`/api/mqtt/root-finder/samples/${start.body.data.sampleId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ protocol: 'meshcore', hasLocation: false, ladder: [], community: [] });
    expect(res.body.data.heard.map((h: { root: string }) => h.root)).toEqual(['MCO', 'TPA']);
  });

  it('honours the TLS-verify checkbox only for meshcore_mqtt', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    await agent.post('/api/mqtt/root-finder/samples').send(mcBody({ rejectUnauthorized: false }));
    expect(stubs[0].opts.broker.rejectUnauthorized).toBe(false);

    stubs[0].end('done');
    now += 10 * 60_000;
    await agent.post('/api/mqtt/root-finder/samples').send(bridgeBody({ rejectUnauthorized: false }));
    expect(stubs[1].opts.broker.rejectUnauthorized).toBeUndefined();
  });

  it('reuses the stored login on the same brokerUrl and drops it on another host', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const same = await agent.post('/api/mqtt/root-finder/samples').send(mcBody({ sourceId: 'rt-mc' }));
    expect(same.status).toBe(202);
    expect(stubs[0].opts.broker).toMatchObject({ username: 'mc-user', password: 'mc-pw' });
    expect(JSON.stringify(same.body)).not.toContain('mc-pw');

    stubs[0].end('done');
    now += 10 * 60_000;
    const other = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(mcBody({ sourceId: 'rt-mc', broker: { url: 'mqtt://10.9.9.9:1883' } }));
    expect(other.status).toBe(202);
    expect(stubs[1].opts.broker.password).toBeUndefined();
    expect(stubs[1].opts.broker.username).toBeUndefined();
  });

  it('404 for a sourceId that is not a meshcore_mqtt source', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(mcBody({ sourceId: harness.sourceA }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
    expect(stubs).toHaveLength(0);
  });

  it('requires a broker URL and blocks unsafe targets', async () => {
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const noUrl = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(mcBody({ broker: { address: '10.1.2.3', tlsEnabled: false } }));
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.code).toBe('INVALID_BROKER');
    const blocked = await agent
      .post('/api/mqtt/root-finder/samples')
      .send(mcBody({ broker: { url: 'mqtt://169.254.169.254:1883' } }));
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('ROOT_FINDER_TARGET_BLOCKED');
    expect(stubs).toHaveLength(0);
  });

  it('shares the per-endpoint cap with Meshtastic samples', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.post('/api/mqtt/root-finder/samples').send(bridgeBody())).status).toBe(202);
    await harness.grant(harness.limited.id, 'sources', 'write');
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/api/mqtt/root-finder/samples').send(mcBody());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('ROOT_FINDER_BUSY');
  });
});
