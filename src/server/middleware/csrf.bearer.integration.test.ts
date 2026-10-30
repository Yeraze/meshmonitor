/**
 * End-to-end regression for the CSRF Bearer-bypass (#6050).
 *
 * Uses the real route harness: real express-session (so a real session cookie),
 * the real DatabaseService singleton, and a real `mm_v1_…` API token minted via
 * `tokenFor()` so `validateApiTokenAsync` runs exactly as in production.
 *
 * The bug: `csrfProtection` skipped CSRF whenever ANY `Authorization: Bearer`
 * header was present. A request authenticated by a session cookie (which IS
 * CSRF-able) could add `Authorization: Bearer <anything>` to skip CSRF on every
 * state-mutating route. The fix validates the token and only skips CSRF when a
 * valid, active API token is confirmed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { csrfProtection, csrfTokenMiddleware, csrfTokenEndpoint } from './csrf.js';

describe('CSRF Bearer-bypass regression (#6050)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: app => {
        // Mirror production: a token endpoint + csrfProtection on the mutation.
        app.use(csrfTokenMiddleware);
        app.get('/csrf-token', csrfTokenEndpoint);
        app.post('/mutate', csrfProtection, (_req, res) => res.json({ success: true }));
      },
    });
  });

  afterEach(() => harness.cleanup());

  it('rejects a session-cookie request with a bogus Bearer header and no CSRF token', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/mutate')
      .set('Authorization', 'Bearer bypass') // any value — must NOT exempt
      .send({ anything: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_TOKEN_REQUIRED');
  });

  it('still allows a legitimate session-cookie request that carries a valid CSRF token (even with a bogus Bearer header)', async () => {
    const agent = await harness.loginAs(harness.admin);

    const tokenRes = await agent.get('/csrf-token');
    const csrfToken = tokenRes.body.csrfToken as string;
    expect(csrfToken).toBeTruthy();

    const res = await agent
      .post('/mutate')
      .set('Authorization', 'Bearer bypass')
      .set('X-CSRF-Token', csrfToken)
      .send({ anything: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows a genuine API-token request (valid Bearer, no session, no CSRF token)', async () => {
    const token = await harness.tokenFor(harness.admin);

    // Fresh client with no cookie jar — purely token-authenticated.
    const res = await request(harness.app)
      .post('/mutate')
      .set('Authorization', `Bearer ${token}`)
      .send({ anything: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects a bogus Bearer request that has no valid CSRF token or session token', async () => {
    const res = await request(harness.app)
      .post('/mutate')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ anything: true });

    expect(res.status).toBe(403);
  });
});
