/**
 * Walkabout routes (#5891 P1, WP3): permission matrix, ownership, envelopes,
 * body validation. Real harness + real repository (in-memory SQLite).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import walkaboutRoutes from './walkaboutRoutes.js';
import { walkaboutService } from '../services/walkaboutService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const sourceTypes: Record<string, string | null> = {};

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => (sourceTypes[id] ? { sourceType: sourceTypes[id] } : null),
  },
}));

const sample = (over: Record<string, unknown> = {}) => ({
  latitude: 40.1,
  longitude: -75.2,
  accuracyM: 10,
  deviceFixAt: Date.now(),
  ageMs: 100,
  ...over,
});

describe('walkaboutRoutes', () => {
  let h: RouteTestHarness;
  const base = (src: string) => `/api/sources/${src}/walkabout/sessions`;

  beforeEach(async () => {
    sourceTypes['rt-source-a'] = 'meshtastic_tcp';
    sourceTypes['rt-source-b'] = 'meshtastic_tcp';
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

  it('anonymous gets 401 on every route', async () => {
    const agent = await h.loginAs(null);
    const b = base(h.sourceA);
    const id = 'abc';
    for (const res of [
      await agent.get(b),
      await agent.get(`${b}/live`),
      await agent.get(`${b}/${id}`),
      await agent.post(b).send({}),
      await agent.post(`${b}/${id}/samples`).send({ samples: [sample()] }),
      await agent.post(`${b}/${id}/stop`).send({}),
      await agent.delete(`${b}/${id}`),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it('no grant: 403 on read and write', async () => {
    const agent = await h.loginAs(h.limited);
    expect((await agent.get(base(h.sourceA))).status).toBe(403);
    expect((await agent.post(base(h.sourceA)).send({})).status).toBe(403);
  });

  it('read-only on A: lists A, 403 on B, cannot start', async () => {
    await h.grant(h.limited.id, 'nodes', 'read', h.sourceA);
    const agent = await h.loginAs(h.limited);
    const res = await agent.get(base(h.sourceA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { sessions: [] } });
    expect((await agent.get(base(h.sourceB))).status).toBe(403);
    expect((await agent.post(base(h.sourceA)).send({})).status).toBe(403);
  });

  it('write on A only: starts on A, 403 on B', async () => {
    await h.grant(h.limited.id, 'nodes', 'write', h.sourceA);
    const agent = await h.loginAs(h.limited);
    const res = await agent.post(base(h.sourceA)).send({ name: '  Walk  ' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.session).toMatchObject({ sourceId: h.sourceA, name: 'Walk', isLive: true, startedByMe: true });
    expect(res.body.data.session.startedBy).toBeUndefined();
    expect((await agent.post(base(h.sourceB)).send({})).status).toBe(403);
  });

  it('a grant on the other source does not help', async () => {
    await h.grant(h.limited.id, 'nodes', 'write', h.sourceB);
    const agent = await h.loginAs(h.limited);
    expect((await agent.post(base(h.sourceA)).send({})).status).toBe(403);
  });

  it('second start is 409 WALKABOUT_ALREADY_LIVE with sessionId', async () => {
    const agent = await h.loginAs(h.admin);
    const first = await agent.post(base(h.sourceA)).send({});
    const res = await agent.post(base(h.sourceA)).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'WALKABOUT_ALREADY_LIVE', sessionId: first.body.data.session.id });
    expect(typeof res.body.error).toBe('string');
  });

  it('refuses a source without a radio manager (MQTT)', async () => {
    sourceTypes[h.sourceA] = 'mqtt_broker';
    const agent = await h.loginAs(h.admin);
    const res = await agent.post(base(h.sourceA)).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WALKABOUT_SOURCE_UNSUPPORTED');
  });

  it('rejects an over-long or non-text name', async () => {
    const agent = await h.loginAs(h.admin);
    const long = await agent.post(base(h.sourceA)).send({ name: 'x'.repeat(121) });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe('INVALID_WALKABOUT');
    expect((await agent.post(base(h.sourceA)).send({ name: 5 })).body.code).toBe('INVALID_WALKABOUT');
  });

  describe('samples', () => {
    let sessionId: string;
    let starter: Awaited<ReturnType<RouteTestHarness['loginAs']>>;

    beforeEach(async () => {
      await h.grant(h.limited.id, 'nodes', 'write', h.sourceA);
      starter = await h.loginAs(h.limited);
      sessionId = (await starter.post(base(h.sourceA)).send({})).body.data.session.id;
    });

    it('starter posts a sample; counts come back', async () => {
      const res = await starter.post(`${base(h.sourceA)}/${sessionId}/samples`).send({ samples: [sample()] });
      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toBe(1);
      expect(res.body.data.session.sampleCount).toBe(1);
    });

    it('a different write user gets 403 WALKABOUT_NOT_OWNER; admin too', async () => {
      const admin = await h.loginAs(h.admin);
      const res = await admin.post(`${base(h.sourceA)}/${sessionId}/samples`).send({ samples: [sample()] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WALKABOUT_NOT_OWNER');
    });

    it('rejects 0, 5, non-array and bad-field bodies with 400 INVALID_WALKABOUT', async () => {
      const url = `${base(h.sourceA)}/${sessionId}/samples`;
      const bodies = [
        { samples: [] },
        { samples: Array.from({ length: 5 }, (_, i) => sample({ deviceFixAt: i })) },
        { samples: 'x' },
        {},
        { samples: [sample({ latitude: 91 })] },
        { samples: [sample({ longitude: -181 })] },
        { samples: [sample({ accuracyM: 'a' })] },
        { samples: [sample({ accuracyM: -1 })] },
        { samples: [null] },
        { samples: [sample({ ageMs: -1 })] },
        { samples: [sample({ ageMs: 3_600_001 })] },
        { samples: [sample({ deviceFixAt: 0 })] },
        { samples: [sample({ deviceFixAt: Date.now() + 2 * 86_400_000 })] },
        { samples: [sample({ deviceFixAt: Date.now() - 2 * 86_400_000 })] },
        { samples: [sample({ accuracyM: 100_001 })] },
      ];
      for (const b of bodies) {
        const res = await starter.post(url).send(b);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ success: false, code: 'INVALID_WALKABOUT' });
      }
    });

    it('unknown session: 404', async () => {
      const res = await starter.post(`${base(h.sourceA)}/nope/samples`).send({ samples: [sample()] });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('WALKABOUT_NOT_FOUND');
    });

    it('after stop: samples and a second stop are 409 WALKABOUT_NOT_LIVE with endedAt', async () => {
      const stop = await starter.post(`${base(h.sourceA)}/${sessionId}/stop`).send({});
      expect(stop.status).toBe(200);
      expect(stop.body.data.session).toMatchObject({ isLive: false, endReason: 'user' });
      const post = await starter.post(`${base(h.sourceA)}/${sessionId}/samples`).send({ samples: [sample()] });
      expect(post.status).toBe(409);
      expect(post.body).toMatchObject({ code: 'WALKABOUT_NOT_LIVE', endReason: 'user' });
      expect(typeof post.body.endedAt).toBe('number');
      const again = await starter.post(`${base(h.sourceA)}/${sessionId}/stop`).send({});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('WALKABOUT_NOT_LIVE');
    });

    it('a session past its cap reads not-live on post (409) and ends as cap', async () => {
      const row = await h.db.coverageWalkabout.getSession(h.sourceA, sessionId);
      expect(row).not.toBeNull();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(row!.startedAt + 2 * 3_600_000 + 1000);
        const res = await starter.post(`${base(h.sourceA)}/${sessionId}/samples`).send({ samples: [sample()] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('WALKABOUT_NOT_LIVE');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('admin stops and deletes another user\'s session; delete of a missing one is 404', async () => {
    await h.grant(h.limited.id, 'nodes', 'write', h.sourceA);
    const limited = await h.loginAs(h.limited);
    const id = (await limited.post(base(h.sourceA)).send({})).body.data.session.id;
    const admin = await h.loginAs(h.admin);
    const stop = await admin.post(`${base(h.sourceA)}/${id}/stop`).send({});
    expect(stop.status).toBe(200);
    expect(stop.body.data.session.startedByMe).toBe(false);
    const del = await admin.delete(`${base(h.sourceA)}/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true });
    expect((await admin.delete(`${base(h.sourceA)}/${id}`)).status).toBe(404);
  });

  it('GET /sessions/live is not swallowed by /:sessionId; detail has skipped only while live', async () => {
    const admin = await h.loginAs(h.admin);
    const none = await admin.get(`${base(h.sourceA)}/live`);
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual({ session: null, skipped: null });

    const id = (await admin.post(base(h.sourceA)).send({})).body.data.session.id;
    const live = await admin.get(`${base(h.sourceA)}/live`);
    expect(live.body.data.session.id).toBe(id);
    expect(live.body.data.skipped).toMatchObject({ noFix: 0 });

    const detail = await admin.get(`${base(h.sourceA)}/${id}`);
    expect(detail.body.data.session.id).toBe(id);
    expect(detail.body.data.skipped).not.toBeNull();

    await admin.post(`${base(h.sourceA)}/${id}/stop`).send({});
    const ended = await admin.get(`${base(h.sourceA)}/${id}`);
    expect(ended.body.data.skipped).toBeNull();
    expect((await admin.get(`${base(h.sourceA)}/live`)).body.data.session).toBeNull();

    const list = await admin.get(base(h.sourceA));
    expect(list.body.data.sessions).toHaveLength(1);
  });

  it('DELETE of a live session is 409 WALKABOUT_LIVE_SESSION; deletable once stopped or past cap', async () => {
    const admin = await h.loginAs(h.admin);
    const id = (await admin.post(base(h.sourceA)).send({})).body.data.session.id;
    const live = await admin.delete(`${base(h.sourceA)}/${id}`);
    expect(live.status).toBe(409);
    expect(live.body).toMatchObject({ success: false, code: 'WALKABOUT_LIVE_SESSION' });
    expect(await h.db.coverageWalkabout.getSession(h.sourceA, id)).not.toBeNull();

    const row = await h.db.coverageWalkabout.getSession(h.sourceA, id);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(row!.startedAt + 2 * 3_600_000 + 1000);
      expect((await admin.delete(`${base(h.sourceA)}/${id}`)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(await h.db.coverageWalkabout.getSession(h.sourceA, id)).toBeNull();

    const id2 = (await admin.post(base(h.sourceA)).send({})).body.data.session.id;
    await admin.post(`${base(h.sourceA)}/${id2}/stop`).send({});
    expect((await admin.delete(`${base(h.sourceA)}/${id2}`)).status).toBe(200);
  });

  it('GET /sessions/live adopts a DB-open session the live map missed, and closes a past-cap one', async () => {
    const admin = await h.loginAs(h.admin);
    const repo = h.db.coverageWalkabout;
    const now = Date.now();
    await repo.createSession({ id: 'orphan-live', sourceId: h.sourceA, name: null, startedAt: now - 60_000, startedBy: h.admin.id });
    const res = await admin.get(`${base(h.sourceA)}/live`);
    expect(res.body.data.session).toMatchObject({ id: 'orphan-live', isLive: true });
    expect(res.body.data.skipped).toMatchObject({ noFix: 0 }); // in the live map now
    expect(walkaboutService.getSkipped(h.sourceA, 'orphan-live')).not.toBeNull();

    await repo.deleteForSource(h.sourceA);
    walkaboutService.forgetSource(h.sourceA);
    await repo.createSession({ id: 'orphan-old', sourceId: h.sourceA, name: null, startedAt: now - 3 * 3_600_000, startedBy: h.admin.id });
    const old = await admin.get(`${base(h.sourceA)}/live`);
    expect(old.body.data).toEqual({ session: null, skipped: null });
    const row = await repo.getSession(h.sourceA, 'orphan-old');
    expect(row).toMatchObject({ endReason: 'cap', endedAt: now - 3 * 3_600_000 + 2 * 3_600_000 });
  });

  it('GET unknown session: 404 envelope', async () => {
    const admin = await h.loginAs(h.admin);
    const res = await admin.get(`${base(h.sourceA)}/missing`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'WALKABOUT_NOT_FOUND' });
  });
});
