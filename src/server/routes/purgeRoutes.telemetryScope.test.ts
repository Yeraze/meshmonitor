/**
 * POST /api/purge/telemetry: source scoping (#6258 WP3).
 *
 * The MeshCore Settings "Purge telemetry" button sends `{ sourceId }`. This
 * file runs the real route and the real database, so it proves that only that
 * source's rows go, and that a non-admin cannot call it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import purgeRoutes from './purgeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const NODE = 0x0a0b0c0d;
const NODE_ID = '!0a0b0c0d';

describe('POST /api/purge/telemetry: source scope (#6258)', () => {
  let harness: RouteTestHarness;

  const countFor = async (sourceId: string) =>
    harness.db.telemetry.getTelemetryCount(sourceId);

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

  it('with a sourceId removes only that source\'s telemetry', async () => {
    expect(await countFor(harness.sourceA)).toBe(1);
    expect(await countFor(harness.sourceB)).toBe(1);

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/telemetry').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(200);

    expect(await countFor(harness.sourceA)).toBe(0);
    expect(await countFor(harness.sourceB)).toBe(1);
  });

  it('without a sourceId removes telemetry for every source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/telemetry').send({});
    expect(res.status).toBe(200);
    expect(await countFor(harness.sourceA)).toBe(0);
    expect(await countFor(harness.sourceB)).toBe(0);
  });

  it('rejects a non-admin with 403 and keeps the rows', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/purge/telemetry').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(403);
    expect(await countFor(harness.sourceA)).toBe(1);
  });
});
