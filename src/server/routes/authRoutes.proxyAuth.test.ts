/** Regression: status must resolve proxy identity before reading the session. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import authRoutes from './authRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { resetEnvironmentConfig } from '../config/environment.js';

describe('GET /auth/status — proxy authentication', () => {
  let harness: RouteTestHarness;
  let email: string;

  beforeEach(async () => {
    vi.stubEnv('PROXY_AUTH_ENABLED', 'true');
    vi.stubEnv('TRUST_PROXY', 'loopback');
    vi.stubEnv('PROXY_AUTH_AUTO_PROVISION', 'true');
    vi.stubEnv('PROXY_AUTH_ADMIN_GROUPS', 'admins');
    vi.stubEnv('PROXY_AUTH_ADMIN_EMAILS', '');
    vi.stubEnv('PROXY_AUTH_NORMAL_USER_GROUPS', 'members');
    resetEnvironmentConfig();
    harness = await createRouteTestApp({
      // Match server.ts: /auth is mounted without router-level optionalAuth.
      // Enabling the harness middleware would mask the regression.
      useOptionalAuth: false,
      mount: app => app.use('/api/auth', authRoutes),
    });
    email = `proxy-${harness.limited.username}@example.com`;
  });

  afterEach(async () => {
    await harness?.cleanup();
    vi.unstubAllEnvs();
    resetEnvironmentConfig();
  });

  it.each(['oauth2-proxy', 'Cloudflare Access'])('authenticates the first %s request, provisions the admin, and persists the session', async proxy => {
    const agent = request.agent(harness.app);
    const initial = agent.get('/api/auth/status');
    if (proxy === 'Cloudflare Access') {
      // The trusted reverse proxy validates this JWT; MeshMonitor extracts claims.
      const claims = Buffer.from(JSON.stringify({ email, groups: ['admins'] })).toString('base64url');
      initial.set('Cf-Access-Jwt-Assertion', `e30.${claims}.test-signature`);
    } else {
      initial.set('X-Auth-Request-Email', email).set('X-Auth-Request-Groups', 'admins');
    }
    const first = await initial;
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      authenticated: true,
      user: { email, authProvider: 'proxy', isAdmin: true },
    });
    expect(first.body.user).not.toHaveProperty('passwordHash');
    const again = await agent.get('/api/auth/status');
    expect(again.body.authenticated).toBe(true);
    expect(again.body.user.id).toBe(first.body.user.id);
  });

  it('rotates an existing session when binding a different proxy identity', async () => {
    // Obtain the existing session cookie explicitly, without relying on agent internals.
    const planted = await request(harness.app).post('/__test__/login').send({ userId: harness.limited.id });
    const oldCookie = planted.headers['set-cookie'][0].split(';')[0];
    const bound = await request(harness.app).get('/api/auth/status')
      .set('Cookie', oldCookie)
      .set('X-Auth-Request-Email', email)
      .set('X-Auth-Request-Groups', 'members');
    expect(bound.body.authenticated).toBe(true);
    expect(bound.body.user.id).not.toBe(harness.limited.id);
    expect(bound.headers['set-cookie'][0].split(';')[0]).not.toBe(oldCookie);
    const stale = await request(harness.app).get('/api/auth/status').set('Cookie', oldCookie);
    expect(stale.body.authenticated).toBe(false);
  });

  it('re-evaluates administrator groups on an existing proxy session', async () => {
    const agent = request.agent(harness.app);
    await agent.get('/api/auth/status').set('X-Auth-Request-Email', email)
      .set('X-Auth-Request-Groups', 'admins');
    const demoted = await agent.get('/api/auth/status').set('X-Auth-Request-Email', email)
      .set('X-Auth-Request-Groups', 'members');
    expect(demoted.status).toBe(200);
    expect(demoted.body.user.isAdmin).toBe(false);
  });

  it('authenticates an existing proxy account when auto-provisioning is disabled', async () => {
    vi.stubEnv('PROXY_AUTH_AUTO_PROVISION', 'false');
    resetEnvironmentConfig();
    await harness.db.auth.updateUser(harness.limited.id, { authMethod: 'proxy', email });
    const result = await request(harness.app).get('/api/auth/status')
      .set('X-Auth-Request-Email', email).set('X-Auth-Request-Groups', 'members');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      authenticated: true,
      user: { id: harness.limited.id, email, authProvider: 'proxy' },
    });
  });

  it('leaves an unknown proxy identity unauthenticated when auto-provisioning is disabled', async () => {
    vi.stubEnv('PROXY_AUTH_AUTO_PROVISION', 'false');
    resetEnvironmentConfig();
    const result = await request(harness.app).get('/api/auth/status')
      .set('X-Auth-Request-Email', email).set('X-Auth-Request-Groups', 'members');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ authenticated: false, user: null });
    expect(await harness.db.findUserByEmailAsync(email)).toBeNull();

    // An unknown proxy user still falls back to an existing local session.
    const agent = await harness.loginAs(harness.limited);
    const fallback = await agent.get('/api/auth/status')
      .set('X-Auth-Request-Email', email).set('X-Auth-Request-Groups', 'members');
    expect(fallback.status).toBe(200);
    expect(fallback.body).toMatchObject({
      authenticated: true,
      user: { id: harness.limited.id, authProvider: 'local' },
    });
    expect(await harness.db.findUserByEmailAsync(email)).toBeNull();
  });

  it('denies a disallowed proxy group even when a valid local session exists', async () => {
    const agent = await harness.loginAs(harness.admin);
    const denied = await agent.get('/api/auth/status').set('X-Auth-Request-Email', email)
      .set('X-Auth-Request-Groups', 'outsiders');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN_PROXY_GROUP');
    expect(await harness.db.findUserByEmailAsync(email)).toBeNull();
  });

  it.each(['local', 'oidc'] as const)('preserves an existing %s session without proxy headers', async authMethod => {
    await harness.db.auth.updateUser(harness.limited.id, { authMethod });
    const agent = await harness.loginAs(harness.limited);
    const result = await agent.get('/api/auth/status');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ authenticated: true, user: { id: harness.limited.id, authProvider: authMethod } });
  });

  it('preserves anonymous permissions without reporting anonymous as signed in', async () => {
    const result = await request(harness.app).get('/api/auth/status');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ authenticated: false, user: null });
    expect(result.body.permissions).toEqual(await harness.db.getUserPermissionSetsBySourceAsync(harness.anonymous.id));
  });

  it('ignores proxy headers when proxy authentication is disabled', async () => {
    vi.stubEnv('PROXY_AUTH_ENABLED', 'false');
    resetEnvironmentConfig();
    const result = await request(harness.app).get('/api/auth/status')
      .set('X-Auth-Request-Email', email).set('X-Auth-Request-Groups', 'admins');
    expect(result.body).toMatchObject({ authenticated: false, user: null });
    expect(await harness.db.findUserByEmailAsync(email)).toBeNull();
  });

  it('does not apply proxy authentication to logout', async () => {
    const result = await request(harness.app).post('/api/auth/logout')
      .set('X-Auth-Request-Email', email).set('X-Auth-Request-Groups', 'admins');
    expect(result.status).toBe(200);
    expect(await harness.db.findUserByEmailAsync(email)).toBeNull();
  });
});
