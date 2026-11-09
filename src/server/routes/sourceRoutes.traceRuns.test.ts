/**
 * Deleting a source purges its MeshCore trace attempt log (#6276), like the
 * per-hop SNR history (#5722).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    removeManager: vi.fn(),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const SRC = 'rt-trace-runs-del';
const OTHER = 'rt-trace-runs-keep';

describe('DELETE /:id purges meshcore_trace_runs', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    for (const id of [SRC, OTHER]) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type: 'meshcore', config: {}, enabled: false });
      await harness.db.meshcoreTraceRuns.insertPending({
        sourceId: id, traceTag: 1, authCode: 0, targetPublicKey: null, pathHex: '11', hashBytes: 1,
        autoReturn: false, origin: 'manual', sentAt: Date.now(),
      });
      await harness.db.meshcoreTraceRuns.complete(id, 1, 0, 'timeout', Date.now());
    }
  });

  afterEach(async () => {
    await harness.db.meshcoreTraceRuns.deleteBySourceId(OTHER);
    await harness.db.sources.deleteSource(OTHER).catch(() => {});
    await harness.db.sources.deleteSource(SRC).catch(() => {});
    await harness.cleanup();
  });

  it('removes the deleted source rows and keeps other sources', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.delete(`/${SRC}`);
    expect(res.status).toBe(200);
    expect((await harness.db.meshcoreTraceRuns.getForExplorer(SRC, 0, 10)).runs).toEqual([]);
    expect((await harness.db.meshcoreTraceRuns.getForExplorer(OTHER, 0, 10)).runs).toHaveLength(1);
  });
});
