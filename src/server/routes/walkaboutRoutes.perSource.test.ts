/**
 * Walkabout routes: source isolation (#5891 P1). A session on A is a 404 on
 * every route under B, and deleting a source removes its walkabout rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import walkaboutRoutes from './walkaboutRoutes.js';
import { walkaboutService } from '../services/walkaboutService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: () => ({ sourceType: 'meshtastic_tcp' }),
    removeManager: vi.fn().mockResolvedValue(undefined),
    stopManager: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('walkaboutRoutes per-source isolation', () => {
  let h: RouteTestHarness;
  const base = (src: string) => `/api/sources/${src}/walkabout/sessions`;

  beforeEach(async () => {
    h = await createRouteTestApp({ mount: (app) => app.use('/api/sources/:id/walkabout', walkaboutRoutes) });
    await walkaboutService.init();
  });

  afterEach(async () => {
    for (const s of [h.sourceA, h.sourceB]) {
      await h.db.coverageWalkabout.deleteForSource(s);
      walkaboutService.forgetSource(s);
    }
    await h.cleanup();
  });

  it("A's session 404s under B on every route; B's data is untouched", async () => {
    const admin = await h.loginAs(h.admin);
    const a = (await admin.post(base(h.sourceA)).send({})).body.data.session.id;
    const b = (await admin.post(base(h.sourceB)).send({})).body.data.session.id;
    const sample = { latitude: 40, longitude: -75, accuracyM: 5, deviceFixAt: Date.now(), ageMs: 10 };

    expect((await admin.get(`${base(h.sourceB)}/${a}`)).status).toBe(404);
    expect((await admin.post(`${base(h.sourceB)}/${a}/samples`).send({ samples: [sample] })).status).toBe(404);
    expect((await admin.post(`${base(h.sourceB)}/${a}/stop`).send({})).status).toBe(404);
    expect((await admin.delete(`${base(h.sourceB)}/${a}`)).status).toBe(404);

    // A is still live and intact; B's list holds only B's session.
    const listB = await admin.get(base(h.sourceB));
    expect(listB.body.data.sessions.map((s: { id: string }) => s.id)).toEqual([b]);
    const detailA = await admin.get(`${base(h.sourceA)}/${a}`);
    expect(detailA.body.data.session).toMatchObject({ isLive: true, sampleCount: 0 });
    const liveB = await admin.get(`${base(h.sourceB)}/live`);
    expect(liveB.body.data.session.id).toBe(b);
  });

  it("map routes: B's session is a 404 under A and window reads never include B's rows", async () => {
    const admin = await h.loginAs(h.admin);
    const t = Date.now() - 600_000;
    const repo = h.db.coverageWalkabout;
    await repo.createSession({ id: 'mb', sourceId: h.sourceB, name: null, startedAt: t, startedBy: null });
    await repo.endSession(h.sourceB, 'mb', t + 60_000, 'user');
    await repo.insertSample({
      sessionId: 'mb', sourceId: h.sourceB, latitude: 40, longitude: -105, accuracyM: 5,
      deviceFixAt: t, fixAt: t + 10, receivedAt: t + 10,
    });
    const u = (src: string, p: string) => `/api/sources/${src}/walkabout${p}`;
    const cell = 'x';
    expect((await admin.get(u(h.sourceA, '/cells?sessionId=mb'))).status).toBe(404);
    expect((await admin.get(u(h.sourceA, `/cell-nodes?sessionId=mb&cell=${cell}`))).status).toBe(400);
    expect((await admin.get(u(h.sourceA, '/sessions/mb/track'))).status).toBe(404);
    expect((await admin.get(u(h.sourceA, '/cells?window=24h'))).body.data.cells).toEqual([]);
    expect((await admin.get(u(h.sourceB, '/cells?window=24h'))).body.data.cells).toHaveLength(1);
    expect((await admin.get(u(h.sourceB, '/sessions/mb/track'))).body.data.positions).toEqual([[40, -105]]);
  });

  it('deleting a source removes its walkabout rows (and leaves the other source)', async () => {
    const admin = await h.loginAs(h.admin);
    const a = (await admin.post(base(h.sourceA)).send({})).body.data.session.id;
    const b = (await admin.post(base(h.sourceB)).send({})).body.data.session.id;
    const { default: sourceRoutes } = await import('./sourceRoutes.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { id: h.admin.id, isAdmin: true, isActive: true };
      (req as unknown as { session: unknown }).session = { userId: h.admin.id };
      next();
    });
    app.use('/', sourceRoutes);
    const del = await request(app).delete(`/${h.sourceA}`);
    expect([200, 204]).toContain(del.status);
    expect(await h.db.coverageWalkabout.getSession(h.sourceA, a)).toBeNull();
    expect(await h.db.coverageWalkabout.getSession(h.sourceB, b)).not.toBeNull();
  });
});
