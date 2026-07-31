/**
 * GET /:id/status — Analyzer Observer sub-object visibility (#4457 Phase 2,
 * WP5, spec §4.1 / D-10).
 *
 * The observer status can carry `lastError`, which may embed the broker
 * hostname, so it is stripped for anonymous / non-`nodes:read` callers at
 * the existing `!canReadNodes` early return. This is the ONE change to that
 * route — the wire shape is otherwise untouched (spec §1.11: this route
 * stays a bare `res.json(...)`, never the ok()/fail() envelope).
 *
 * Uses the real createRouteTestApp harness (real session + auth middleware +
 * real permission SQL) per CLAUDE.md's Route Test Harness guidance. Only
 * `sourceManagerRegistry` is mocked, with a fake MeshCore manager whose
 * getStatus() includes/omits the `observer` key — exactly what the real
 * MeshCoreManager.getStatus() conditional spread produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: mockSourceRegistry,
}));

const SOURCE_ID = 'obs-status-source';
const NO_OBSERVER_SOURCE_ID = 'obs-status-source-none';

const FULL_OBSERVER_STATUS = {
  configured: true,
  keyStored: true,
  connected: true,
  publishes: 42,
  dropped: 1,
  lastPublishAt: 1700000000000,
  lastError: 'Broker rejected the observer auth token (mqtt://internal-broker.example:8883)',
  tokenExpiresAt: 1700086400,
};

function fakeMeshCoreManager(observer: typeof FULL_OBSERVER_STATUS | undefined) {
  return {
    sourceType: 'meshcore' as const,
    getStatus: (name?: string) => ({
      sourceId: SOURCE_ID,
      sourceName: name ?? 'Observer Status Source',
      sourceType: 'meshcore' as const,
      connected: true,
      ...(observer ? { observer } : {}),
    }),
    getLocalNode: () => null,
    getAllNodes: () => [],
  };
}

describe('GET /:id/status — Analyzer Observer visibility (#4457 Phase 2)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: SOURCE_ID,
      name: 'Observer Status Source',
      type: 'meshcore',
      config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion' },
      enabled: true,
    });

    await harness.db.sources.deleteSource(NO_OBSERVER_SOURCE_ID).catch(() => {});
    await harness.db.sources.createSource({
      id: NO_OBSERVER_SOURCE_ID,
      name: 'No Observer Source',
      type: 'meshcore',
      config: { transport: 'usb', port: '/dev/ttyACM1', deviceType: 'companion' },
      enabled: true,
    });

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.getManager.mockImplementation((id: string) => {
      if (id === SOURCE_ID) return fakeMeshCoreManager(FULL_OBSERVER_STATUS);
      if (id === NO_OBSERVER_SOURCE_ID) return fakeMeshCoreManager(undefined);
      return undefined;
    });
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.db.sources.deleteSource(NO_OBSERVER_SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  it('strips the observer key for an anonymous caller', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/${SOURCE_ID}/status`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('observer');
    // Every other field still round-trips.
    expect(res.body.sourceId).toBe(SOURCE_ID);
    expect(res.body.connected).toBe(true);
  });

  it('strips the observer key for a user without nodes:read on this source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${SOURCE_ID}/status`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('observer');
  });

  it('includes the full observer shape for a user granted nodes:read on this source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', SOURCE_ID);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${SOURCE_ID}/status`);
    expect(res.status).toBe(200);
    expect(res.body.observer).toEqual(FULL_OBSERVER_STATUS);
  });

  it('includes the observer sub-object for the admin', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${SOURCE_ID}/status`);
    expect(res.status).toBe(200);
    expect(res.body.observer).toEqual(FULL_OBSERVER_STATUS);
  });

  it('never leaks a raw broker hostname to an unauthorized caller via lastError', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${SOURCE_ID}/status`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('internal-broker.example');
  });

  describe('a source with no observer configured', () => {
    it('has no observer key for the admin (no `undefined` leak)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/${NO_OBSERVER_SOURCE_ID}/status`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('observer');
    });

    it('has no observer key for a user granted nodes:read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', NO_OBSERVER_SOURCE_ID);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${NO_OBSERVER_SOURCE_ID}/status`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('observer');
    });

    it('has no observer key for an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get(`/${NO_OBSERVER_SOURCE_ID}/status`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('observer');
    });
  });
});
