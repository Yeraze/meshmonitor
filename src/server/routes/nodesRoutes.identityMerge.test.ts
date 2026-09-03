/**
 * The node identity MERGE endpoints (issue #5032).
 *
 * Uses the real-middleware harness, so `requirePermission` and `requireAdmin`
 * run against real session and permission rows rather than a lambda that
 * re-implements them. That matters more here than anywhere else in the app:
 * these four routes are the only ones that can rewrite a node's entire
 * history, and the gate is the feature.
 *
 * What is asserted:
 *
 * - the preview writes nothing, and the merge that follows moves exactly what
 *   the preview promised
 * - a merge without `confirm: true` is refused — no accidental single-call merge
 * - a non-admin with full `nodes:write` is still refused
 * - a merge cannot reach a source the caller has no grant on
 * - undo restores the prior state, and cannot be aimed at another source
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodesRoutes from './nodesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

const OLD_NUM = 0x433d1ba4;
const NEW_NUM = 0x11223344;

describe('node identity merge routes', () => {
  let harness: RouteTestHarness;

  async function seedPair(sourceId: string) {
    const now = Math.floor(Date.now() / 1000);
    await harness.db.nodes.upsertNode(
      {
        nodeNum: OLD_NUM,
        nodeId: `!${OLD_NUM.toString(16)}`,
        longName: 'Hilltop',
        shortName: 'HILL',
        lastHeard: now - 2 * 86400,
      },
      sourceId,
    );
    await harness.db.nodes.upsertNode(
      {
        nodeNum: NEW_NUM,
        nodeId: `!${NEW_NUM.toString(16)}`,
        longName: 'Hilltop',
        shortName: 'HILL',
        lastHeard: now - 60,
      },
      sourceId,
    );
    await harness.db.telemetry.insertTelemetry(
      {
        nodeId: `!${OLD_NUM.toString(16)}`,
        nodeNum: OLD_NUM,
        telemetryType: 'batteryLevel',
        timestamp: Date.now(),
        value: 87,
        createdAt: Date.now(),
      } as never,
      sourceId,
    );
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', nodesRoutes) });
    // `permissions` is unique on (user, resource, sourceId), so this is one row,
    // not two. `write` is the grant the merge routes check — the point of the
    // non-admin test below is that holding it is still not enough.
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (const num of [OLD_NUM, NEW_NUM]) {
        await harness.db.nodes.deleteNodeRecord(num, sourceId).catch(() => {});
      }
    }
    await harness.cleanup();
  });

  it('previews without writing, then merges exactly what it promised', async () => {
    await seedPair(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);

    const preview = await agent
      .post('/nodes/identity-changes/merge/preview')
      .send({ sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM });

    expect(preview.status).toBe(200);
    expect(preview.body.data.totalRowsRekeyed).toBeGreaterThan(0);
    expect(preview.body.data.undoable).toBe(true);
    expect(preview.body.data.notRekeyed.length).toBeGreaterThan(0);

    // Nothing moved yet.
    const stillThere = await harness.db.nodes.getNode(OLD_NUM, harness.sourceA);
    expect(stillThere).toBeTruthy();

    const merged = await agent.post('/nodes/identity-changes/merge').send({
      sourceId: harness.sourceA,
      fromNodeNum: OLD_NUM,
      toNodeNum: NEW_NUM,
      confirm: true,
    });

    expect(merged.status).toBe(200);
    expect(merged.body.data.plan.entries).toEqual(preview.body.data.entries);
    expect(await harness.db.nodes.getNode(OLD_NUM, harness.sourceA)).toBeFalsy();
    expect(await harness.db.nodes.getNode(NEW_NUM, harness.sourceA)).toBeTruthy();
  });

  it('refuses a merge that was not explicitly confirmed', async () => {
    await seedPair(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/nodes/identity-changes/merge')
      .send({ sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    // …and the node is untouched, which is the point of the refusal.
    expect(await harness.db.nodes.getNode(OLD_NUM, harness.sourceA)).toBeTruthy();
  });

  it('refuses a non-admin even with full nodes:write on the source', async () => {
    await seedPair(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const preview = await agent
      .post('/nodes/identity-changes/merge/preview')
      .send({ sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM });
    expect(preview.status).toBe(403);

    const merge = await agent.post('/nodes/identity-changes/merge').send({
      sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, confirm: true,
    });
    expect(merge.status).toBe(403);
    expect(await harness.db.nodes.getNode(OLD_NUM, harness.sourceA)).toBeTruthy();
  });

  it('requires a sourceId', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/nodes/identity-changes/merge/preview')
      .send({ fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM });
    expect(res.status).toBe(400);
  });

  it('reports 404 for a node that is not on the given source', async () => {
    await seedPair(harness.sourceB);
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/nodes/identity-changes/merge/preview')
      .send({ sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NODE_NOT_FOUND');
  });

  it('lists merges and undoes one, restoring the retired node', async () => {
    await seedPair(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);

    const merged = await agent.post('/nodes/identity-changes/merge').send({
      sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, confirm: true,
    });
    const mergeId = merged.body.data.mergeId;

    const list = await agent.get(`/nodes/identity-changes/merges?sourceId=${harness.sourceA}`);
    expect(list.status).toBe(200);
    expect(list.body.data.merges[0]).toMatchObject({ id: mergeId, mergedBy: harness.admin.username });

    const undone = await agent
      .post(`/nodes/identity-changes/merges/${mergeId}/undo`)
      .send({ sourceId: harness.sourceA });

    expect(undone.status).toBe(200);
    expect(await harness.db.nodes.getNode(OLD_NUM, harness.sourceA)).toBeTruthy();
  });

  it('refuses to undo a merge that belongs to another source', async () => {
    await seedPair(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    const merged = await agent.post('/nodes/identity-changes/merge').send({
      sourceId: harness.sourceA, fromNodeNum: OLD_NUM, toNodeNum: NEW_NUM, confirm: true,
    });

    const res = await agent
      .post(`/nodes/identity-changes/merges/${merged.body.data.mergeId}/undo`)
      .send({ sourceId: harness.sourceB });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_SOURCE');
    // The refusal is checked before any write, so the merge still stands.
    expect(await harness.db.nodes.getNode(OLD_NUM, harness.sourceA)).toBeFalsy();
  });
});
