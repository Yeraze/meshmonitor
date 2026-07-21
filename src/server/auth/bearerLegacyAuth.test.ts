/**
 * Bearer API tokens on legacy /api endpoints (#4259).
 *
 * Legacy `/api/*` routes are gated by `requireAuth` / `requirePermission`,
 * which historically read only the session cookie (then fell through to the
 * `anonymous` user) — so a valid `Authorization: Bearer` token was silently
 * ignored outside `/api/v1/*` and permission-gated writes returned a confusing
 * 403. These tests drive real tokens (minted via the harness's `tokenFor`,
 * validated through real bcrypt) against routes mounted with each middleware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { requireAuth, requirePermission } from './authMiddleware.js';

let harness: RouteTestHarness;

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => {
      // requirePermission-gated write, scoped to the :id source param.
      app.post(
        '/rt/sources/:id/ignore',
        requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
        (req, res) => res.json({ ok: true, userId: req.user?.id }),
      );
      // requireAuth-gated route (session-or-token, no anonymous fallback).
      app.get('/rt/whoami', requireAuth(), (req, res) =>
        res.json({ userId: req.user?.id, username: req.user?.username }),
      );
    },
  });
});

afterEach(() => harness.cleanup());

describe('Bearer tokens on requirePermission-gated legacy routes (#4259)', () => {
  it('allows a token whose user has the required per-source permission', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const token = await harness.tokenFor(harness.limited);

    const res = await request(harness.app)
      .post(`/rt/sources/${harness.sourceA}/ignore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isIgnored: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, userId: harness.limited.id });
  });

  it('rejects a token whose user lacks the permission on that source (403, not silent-anon)', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB); // wrong source
    const token = await harness.tokenFor(harness.limited);

    const res = await request(harness.app)
      .post(`/rt/sources/${harness.sourceA}/ignore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isIgnored: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('honors an admin token (bypasses the permission check)', async () => {
    const token = await harness.tokenFor(harness.admin);
    const res = await request(harness.app)
      .post(`/rt/sources/${harness.sourceA}/ignore`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isIgnored: true });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(harness.admin.id);
  });

  it('an invalid/garbage Bearer token falls through to anonymous (unchanged behavior)', async () => {
    // anonymous has no nodes:write grant → 403 via the anonymous path, NOT a
    // token-rejection 401. Proves a bad token does not harden anon-readable
    // endpoints into hard failures.
    const res = await request(harness.app)
      .post(`/rt/sources/${harness.sourceA}/ignore`)
      .set('Authorization', 'Bearer mm_v1_deadbeefdeadbeef')
      .send({ isIgnored: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('still works with a session cookie (no regression)', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .post(`/rt/sources/${harness.sourceA}/ignore`)
      .send({ isIgnored: true });
    expect(res.status).toBe(200);
  });
});

describe('Bearer tokens on requireAuth-gated legacy routes (#4259)', () => {
  it('accepts a valid token in place of a session', async () => {
    const token = await harness.tokenFor(harness.limited);
    const res = await request(harness.app)
      .get('/rt/whoami')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: harness.limited.id, username: harness.limited.username });
  });

  it('rejects with 401 when neither session nor token is present', async () => {
    const res = await request(harness.app).get('/rt/whoami');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('rejects an invalid token with 401 (no anonymous fallback on requireAuth)', async () => {
    const res = await request(harness.app)
      .get('/rt/whoami')
      .set('Authorization', 'Bearer mm_v1_notarealtoken00');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
