/**
 * Source creation rules for `meshcore_mqtt` (#5040 Phase 1).
 *
 * Uses `createRouteTestApp()` per CLAUDE.md — real session + auth middleware
 * against the singleton's in-memory SQLite, so the assertions run through the
 * genuine route rather than a re-implementation of it.
 *
 * Covers the two structural validations and the duplicate-feed guard. The
 * duplicate guard matters more here than the analogous host:port one for
 * `meshtastic_tcp`: two sources reading the same brokerUrl+region would ingest
 * every packet twice, and the per-observer dedup is scoped per source, so
 * nothing downstream would collapse them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    addManager: vi.fn().mockResolvedValue(undefined),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

// The manager must never open a real socket during a route test.
const managerStart = vi.fn().mockResolvedValue(undefined);
vi.mock('../meshcoreMqttManager.js', () => ({
  MeshCoreMqttManager: vi.fn().mockImplementation(() => ({
    start: managerStart,
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('POST /sources — meshcore_mqtt (#5040)', () => {
  let harness: RouteTestHarness;

  // Sources created through the route persist for the life of the harness DB,
  // so each test gets its own broker host — otherwise a later test's FIRST
  // create trips the duplicate guard left behind by an earlier one.
  let feed = 0;
  const body = (over: Record<string, unknown> = {}) => ({
    name: `Region Feed ${feed}`,
    type: 'meshcore_mqtt',
    config: { brokerUrl: `wss://mqtt-${feed}.example:443`, region: 'MCO', ...over },
  });


  beforeEach(async () => {
    vi.clearAllMocks();
    feed += 1;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function adminAgent() {
    return harness.loginAs(harness.admin);
  }

  it('creates a source with a broker URL and region', async () => {
    const agent = await adminAgent();
    const res = await agent.post('/').send(body());
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('meshcore_mqtt');
  });

  it('rejects a missing brokerUrl', async () => {
    const agent = await adminAgent();
    const res = await agent.post('/').send({
      name: 'No Broker',
      type: 'meshcore_mqtt',
      config: { region: 'MCO' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brokerUrl/i);
  });

  it('rejects a missing region — the topic filter is built from it', async () => {
    const agent = await adminAgent();
    const res = await agent.post('/').send({
      name: 'No Region',
      type: 'meshcore_mqtt',
      config: { brokerUrl: 'wss://mqtt.example:443' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/region/i);
  });

  it('refuses a second source on the same broker and region', async () => {
    const agent = await adminAgent();
    expect((await agent.post('/').send(body())).status).toBe(201);

    const dup = await agent.post('/').send(body());
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already reads/i);
  });

  it('treats region as case-insensitive when detecting a duplicate', async () => {
    // The form upper-cases on save, but the API accepts either — a lower-case
    // duplicate must not slip past the guard and double-count the feed.
    const agent = await adminAgent();
    expect((await agent.post('/').send(body())).status).toBe(201);

    const dup = await agent.post('/').send(body({ region: 'mco' }));
    expect(dup.status).toBe(409);
  });

  it('allows the same broker for a DIFFERENT region', async () => {
    const agent = await adminAgent();
    expect((await agent.post('/').send(body())).status).toBe(201);

    const other = await agent.post('/').send(body({ region: 'AMS' }));
    expect(other.status).toBe(201);
  });

  it('allows a different broker for the same region', async () => {
    const agent = await adminAgent();
    expect((await agent.post('/').send(body())).status).toBe(201);

    const other = await agent.post('/').send(body({ brokerUrl: `wss://other-${feed}.example:443` }));
    expect(other.status).toBe(201);
  });
});
