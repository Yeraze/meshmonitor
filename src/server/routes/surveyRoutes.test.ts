/**
 * Network survey route (#4726).
 *
 * Real harness (real express-session, real auth middleware, real SQL) so the
 * permission and per-source assertions exercise the actual gate rather than a
 * re-implementation. The survey itself is NOT mocked — it runs against the
 * live :memory: DB, so the isolation assertion proves real scoping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import surveyRoutes from './surveyRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

let harness: RouteTestHarness;

const NODE_A = 0x60000001;
const NODE_B = 0x60000002;

const nowSec = () => Math.floor(Date.now() / 1000);

async function seedNode(nodeNum: number, sourceId: string, extra: Record<string, unknown> = {}) {
  await databaseService.upsertNodeAsync({
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: 'ND',
    hwModel: 1,
    lastHeard: nowSec(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4726 test fixture; DbNode has many optional fields the harness does not need
  } as any, sourceId);
}

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/sources/:id/survey', surveyRoutes),
  });
});

afterEach(async () => {
  await databaseService.purgeAllNodesAsync(harness.sourceA).catch(() => {});
  await databaseService.purgeAllNodesAsync(harness.sourceB).catch(() => {});
  await harness.cleanup();
});

const url = (src: string, qs = '') => `/api/sources/${src}/survey${qs}`;

describe('GET /api/sources/:id/survey', () => {
  it('returns a survey shaped for the view', async () => {
    await seedNode(NODE_A, harness.sourceA, { latitude: 30.1, longitude: -95.2 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sourceId: harness.sourceA,
      windowHours: 24,
      nodes: { total: 1, withPosition: 1 },
    });
    expect(Array.isArray(res.body.data.directNeighbours)).toBe(true);
    expect(Array.isArray(res.body.data.hopDistribution)).toBe(true);
  });

  it('counts only its own source\'s nodes', async () => {
    // Real SQL, not a mock — this is the isolation the survey depends on.
    await seedNode(NODE_A, harness.sourceA);
    await seedNode(NODE_B, harness.sourceB);
    const agent = await harness.loginAs(harness.admin);

    expect((await agent.get(url(harness.sourceA))).body.data.nodes.total).toBe(1);
    expect((await agent.get(url(harness.sourceB))).body.data.nodes.total).toBe(1);
  });

  it('clamps an absurd window instead of rejecting it', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get(url(harness.sourceA, '?hours=99999'))).body.data.windowHours).toBe(720);
    expect((await agent.get(url(harness.sourceA, '?hours=0'))).body.data.windowHours).toBe(1);
    expect((await agent.get(url(harness.sourceA, '?hours=junk'))).body.data.windowHours).toBe(24);
  });

  it('returns an empty-but-valid survey for a source with no data', async () => {
    // A fresh install must not look broken.
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.data.nodes.total).toBe(0);
    expect(res.body.data.maxHops).toBeNull();
  });

  it('refuses a user without nodes:read on this source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
    expect((await agent.get(url(harness.sourceB))).status).toBe(200);
  });
});
