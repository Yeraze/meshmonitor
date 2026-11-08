/**
 * POST /api/purge/{telemetry,nodes}: per-source scope (#6258 D7).
 *
 * A source's Settings page sends its own `sourceId` with "Purge telemetry" and
 * "Erase nodes". This runs the real routes on the real database and proves
 * only that source's rows go, and that a non-admin gets 403.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import purgeRoutes from './purgeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// The nodes route asks the source's manager to resync; a real one would dial a radio.
const mockManager = { refreshNodeDatabase: vi.fn().mockResolvedValue(undefined) };
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(() => mockManager),
  resolveOwnMeshtasticManager: vi.fn(() => mockManager),
}));

const NODE = 0x0a0b0c0e;
const NODE_ID = '!0a0b0c0e';

describe('purge routes: source scope (#6258 D7)', () => {
  let harness: RouteTestHarness;

  const telemetryCount = (sid: string) => harness.db.telemetry.getTelemetryCount(sid);
  const nodeCount = (sid: string) => harness.db.nodes.getNodeCount(sid);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/purge', purgeRoutes) });
    for (const sid of [harness.sourceA, harness.sourceB]) {
      await harness.db.nodes.upsertNode({ nodeNum: NODE, nodeId: NODE_ID } as any, sid);
      await harness.db.telemetry.insertTelemetry({
        nodeId: NODE_ID,
        nodeNum: NODE,
        telemetryType: 'batteryLevel',
        timestamp: Date.now(),
        value: 80,
        createdAt: Date.now(),
      } as any, sid);
    }
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('telemetry purge with a sourceId removes only that source\'s rows', async () => {
    const bBefore = await telemetryCount(harness.sourceB);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/telemetry').send({ olderThanHours: 0, sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(bBefore).toBeGreaterThan(0);
    expect(await telemetryCount(harness.sourceA)).toBe(0);
    expect(await telemetryCount(harness.sourceB)).toBe(bBefore);
  });

  it('node purge with a sourceId removes only that source\'s nodes', async () => {
    const bBefore = await nodeCount(harness.sourceB);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/nodes').send({ olderThanHours: 0, sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(await nodeCount(harness.sourceA)).toBe(0);
    expect(bBefore).toBeGreaterThan(0);
    expect(await nodeCount(harness.sourceB)).toBe(bBefore);
  });

  it.each(['telemetry', 'nodes'])('rejects a non-admin on /%s with 403 and keeps the rows', async (path) => {
    const telemetryBefore = await telemetryCount(harness.sourceA);
    const nodesBefore = await nodeCount(harness.sourceA);
    expect(telemetryBefore).toBeGreaterThan(0);
    expect(nodesBefore).toBeGreaterThan(0);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(`/purge/${path}`).send({ sourceId: harness.sourceA });
    expect(res.status).toBe(403);
    expect(await telemetryCount(harness.sourceA)).toBe(telemetryBefore);
    expect(await nodeCount(harness.sourceA)).toBe(nodesBefore);
  });
});
