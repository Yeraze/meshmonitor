/**
 * Public-instance mode must never alter auth plumbing (#5156). A 64-hex CSRF
 * token looks like a MeshCore key; truncating it made every login fail 403.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import express from 'express';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { csrfProtection, csrfTokenMiddleware, csrfTokenEndpoint } from './csrf.js';
import { publicInstanceRedaction } from './publicInstanceRedaction.js';
import authRoutes from '../routes/authRoutes.js';
import {
  __setPublicInstanceConfigForTest,
  __resetPublicInstanceConfigForTest,
} from '../services/publicInstanceConfig.js';

const HEX64 = /^[0-9a-f]{64}$/;

describe('public instance mode keeps auth plumbing intact', () => {
  let harness: RouteTestHarness;
  const username = 'pi-login-user';
  const password = 'pi-login-pass-1';

  beforeEach(async () => {
    __setPublicInstanceConfigForTest({ enabled: true });
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use(express.json());
        app.use(csrfTokenMiddleware);
        const api = express.Router();
        // Same order as apiRouter.ts: redaction first, token endpoint, CSRF, then /auth.
        api.use(publicInstanceRedaction());
        api.get('/csrf-token', csrfTokenEndpoint);
        api.use(csrfProtection);
        api.use('/auth', authRoutes);
        app.use('/api', api);
      },
    });
    const existing = await harness.db.auth.getUserByUsername(username);
    if (!existing) {
      await harness.db.auth.createUser({
        username,
        passwordHash: await bcrypt.hash(password, 4),
        authMethod: 'local',
        isAdmin: true,
        isActive: true,
        createdAt: Date.now(),
      });
    }
  });

  afterEach(async () => {
    __resetPublicInstanceConfigForTest();
    await harness.cleanup();
  });

  it('anonymous GET /api/csrf-token returns the full 64-hex token', async () => {
    const res = await request(harness.app).get('/api/csrf-token');
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toMatch(HEX64);
  });

  it('anonymous token fetch, then password login succeeds', async () => {
    const agent = request.agent(harness.app);
    const tokenRes = await agent.get('/api/csrf-token');
    const csrfToken = tokenRes.body.csrfToken as string;
    expect(csrfToken).toMatch(HEX64);

    const login = await agent
      .post('/api/auth/login')
      .set('X-CSRF-Token', csrfToken)
      .send({ username, password });
    expect(login.status).toBe(200);
    expect(login.body.user?.username).toBe(username);
  });
});
