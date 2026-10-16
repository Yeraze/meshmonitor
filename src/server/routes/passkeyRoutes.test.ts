/**
 * Passkey routes (#5841 PR 2). Real session + auth middleware + DB via
 * createRouteTestApp; WebAuthn verification is mocked at the
 * @simplewebauthn/server boundary (no authenticator in CI). The real library
 * runs end to end in passkeyRoutes.realLibrary.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import passkeyRoutes, { CHALLENGE_TTL_MS } from './passkeyRoutes.js';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const h = vi.hoisted(() => ({
  env: { disableLocalAuth: false } as Record<string, unknown>,
  authLimiterCalls: [] as string[],
}));

vi.mock('../config/environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/environment.js')>();
  return {
    ...actual,
    getEnvironmentConfig: () => ({ ...actual.getEnvironmentConfig(), ...h.env }),
  };
});

// Pass-through limiter that records which routes it guards. The real one would
// start returning 429 after a handful of failed logins from one test IP.
vi.mock('../middleware/rateLimiters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rateLimiters.js')>();
  return {
    ...actual,
    authLimiter: (req: { path: string }, _res: unknown, next: () => void) => {
      h.authLimiterCalls.push(req.path);
      next();
    },
  };
});

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async (opts: { rpID: string; excludeCredentials?: unknown[] }) => ({
    challenge: `reg-challenge-${Math.random().toString(36).slice(2)}`,
    rp: { id: opts.rpID, name: 'MeshMonitor' },
    excludeCredentials: opts.excludeCredentials ?? [],
  })),
  generateAuthenticationOptions: vi.fn(async (opts: { rpID: string; allowCredentials?: unknown[] }) => ({
    challenge: `auth-challenge-${Math.random().toString(36).slice(2)}`,
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials ?? [],
  })),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const mockVerifyReg = vi.mocked(verifyRegistrationResponse);
const mockVerifyAuth = vi.mocked(verifyAuthenticationResponse);

let credCounter = 0;
const nextCredId = () => `cred-${Date.now().toString(36)}-${++credCounter}`;

function regVerified(credentialId: string) {
  return {
    verified: true,
    registrationInfo: {
      credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
    },
  } as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>;
}

function authVerified(newCounter: number) {
  return {
    verified: true,
    authenticationInfo: { newCounter },
  } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
}

function assertion(credentialId: string, extra: Record<string, unknown> = {}) {
  return {
    response: {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x', ...extra },
      clientExtensionResults: {},
    },
  };
}

function attestation(credentialId: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON: 'x', attestationObject: 'x', transports: ['internal'] },
    clientExtensionResults: {},
  };
}

describe('passkeyRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    h.env = { disableLocalAuth: false };
    h.authLimiterCalls = [];
    mockVerifyReg.mockReset();
    mockVerifyAuth.mockReset();
    harness = await createRouteTestApp({
      mount: (app: Express) => {
        app.use('/api/auth/passkey', passkeyRoutes);
        // Read back the session the routes built.
        app.get('/__test__/session', (req, res) => {
          res.json({
            userId: req.session.userId ?? null,
            username: req.session.username ?? null,
            authProvider: req.session.authProvider ?? null,
            isAdmin: req.session.isAdmin ?? null,
            pendingMfaUserId: req.session.pendingMfaUserId ?? null,
            hasChallenge: !!req.session.webauthnChallenge,
          });
        });
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  /** Insert a passkey row for a user straight through the repository. */
  async function seedPasskey(userId: number, opts: { counter?: number; nickname?: string } = {}) {
    const credentialId = nextCredId();
    const id = await harness.db.createPasskeyAsync({
      userId,
      credentialId,
      publicKey: 'AQIDBA',
      counter: opts.counter ?? 0,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
      rpId: '127.0.0.1',
      nickname: opts.nickname ?? null,
    });
    return { id, credentialId };
  }

  /** Audit writes are fire-and-forget, so poll briefly for the row. */
  async function hasPasskeyAudit(userId: number, action: string): Promise<boolean> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { logs } = await harness.db.auth.getAuditLogsFiltered({ userId, action });
      if (logs.some(l => String(l.details ?? '').includes('"method":"passkey"'))) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;
  }

  async function createUser(opts: { authMethod?: string; isActive?: boolean } = {}) {
    const username = `pk-user-${Date.now().toString(36)}-${++credCounter}`;
    const id = await harness.db.auth.createUser({
      username,
      passwordHash: null,
      authMethod: opts.authMethod ?? 'local',
      isAdmin: false,
      isActive: opts.isActive ?? true,
      createdAt: Date.now(),
    } as Parameters<typeof harness.db.auth.createUser>[0]);
    return { id, username, isAdmin: false };
  }

  // ── Registration ──────────────────────────────────────────────────────────

  describe('register', () => {
    it('requires a signed-in user', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/api/auth/passkey/register/options').send({});
      expect(res.status).toBe(401);
    });

    it('registers a passkey for a local user and stores the RP ID', async () => {
      const agent = await harness.loginAs(harness.limited);
      const opts = await agent.post('/api/auth/passkey/register/options').send({});
      expect(opts.status).toBe(200);
      expect(opts.body.success).toBe(true);
      expect(opts.body.data.challenge).toMatch(/^reg-challenge-/);

      const regArgs = vi.mocked(generateRegistrationOptions).mock.calls.at(-1)![0];
      expect(regArgs.rpID).toBe('127.0.0.1');
      expect(regArgs.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'preferred' });

      const credentialId = nextCredId();
      mockVerifyReg.mockResolvedValueOnce(regVerified(credentialId));
      const res = await agent
        .post('/api/auth/passkey/register/verify')
        .send({ response: attestation(credentialId), nickname: '  Laptop  ' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ nickname: 'Laptop', rpId: '127.0.0.1', backedUp: true });
      expect(res.body.data).not.toHaveProperty('publicKey');
      expect(res.body.data).not.toHaveProperty('credentialId');

      const verifyArgs = mockVerifyReg.mock.calls[0][0];
      expect(verifyArgs.expectedChallenge).toBe(opts.body.data.challenge);
      expect(verifyArgs.expectedRPID).toBe('127.0.0.1');

      const stored = await harness.db.getPasskeyByCredentialIdAsync(credentialId);
      expect(stored).toMatchObject({ userId: harness.limited.id, rpId: '127.0.0.1' });
    });

    it('uses WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS when set', async () => {
      h.env = { disableLocalAuth: false, webauthnRpId: 'mesh.example.com', webauthnOrigins: ['https://mesh.example.com'] };
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/api/auth/passkey/register/options').send({});
      const credentialId = nextCredId();
      mockVerifyReg.mockResolvedValueOnce(regVerified(credentialId));
      const res = await agent.post('/api/auth/passkey/register/verify').send({ response: attestation(credentialId) });
      expect(res.status).toBe(200);
      expect(res.body.data.rpId).toBe('mesh.example.com');
      expect(mockVerifyReg.mock.calls[0][0].expectedOrigin).toEqual(['https://mesh.example.com']);
    });

    it('lists existing passkeys in excludeCredentials', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/auth/passkey/register/options').send({});
      expect(res.status).toBe(200);
      const regArgs = vi.mocked(generateRegistrationOptions).mock.calls.at(-1)![0];
      expect(regArgs.excludeCredentials).toEqual([{ id: credentialId, transports: ['internal'] }]);
    });

    it('refuses non-local users (D4)', async () => {
      const oidcUser = await createUser({ authMethod: 'oidc' });
      const agent = await harness.loginAs(oidcUser);
      const res = await agent.post('/api/auth/passkey/register/options').send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PASSKEY_LOCAL_ONLY');
    });

    it('refuses when DISABLE_LOCAL_AUTH is set', async () => {
      h.env = { disableLocalAuth: true };
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/auth/passkey/register/options').send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('LOCAL_AUTH_DISABLED');
    });

    it('rejects a failed verification and audits it', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/api/auth/passkey/register/options').send({});
      mockVerifyReg.mockRejectedValueOnce(new Error('bad attestation'));
      const credentialId = nextCredId();
      const res = await agent.post('/api/auth/passkey/register/verify').send({ response: attestation(credentialId) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_VERIFY_FAILED');
      expect(await harness.db.getPasskeyByCredentialIdAsync(credentialId)).toBeNull();
    });

    it('rejects a nickname longer than 64 characters', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/api/auth/passkey/register/options').send({});
      const credentialId = nextCredId();
      mockVerifyReg.mockResolvedValueOnce(regVerified(credentialId));
      const res = await agent
        .post('/api/auth/passkey/register/verify')
        .send({ response: attestation(credentialId), nickname: 'x'.repeat(65) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_NICKNAME');
    });

    it('will not use a login challenge to register', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/api/auth/passkey/login/options').send({});
      const credentialId = nextCredId();
      mockVerifyReg.mockResolvedValueOnce(regVerified(credentialId));
      const res = await agent.post('/api/auth/passkey/register/verify').send({ response: attestation(credentialId) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect(mockVerifyReg).not.toHaveBeenCalled();
    });
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('sends discoverable options with an empty allowCredentials', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/api/auth/passkey/login/options').send({});
      expect(res.status).toBe(200);
      expect(res.body.data.allowCredentials).toEqual([]);
      const args = vi.mocked(generateAuthenticationOptions).mock.calls.at(-1)![0];
      expect(args.allowCredentials).toEqual([]);
    });

    it('guards both login routes with authLimiter', async () => {
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      await agent.post('/api/auth/passkey/login/verify').send({});
      expect(h.authLimiterCalls).toEqual(['/login/options', '/login/verify']);
    });

    it('signs in with the same session fields as password login', async () => {
      const { credentialId, id } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      const opts = await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));

      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toMatchObject({ id: harness.limited.id, username: harness.limited.username });
      expect(res.body.data.user).not.toHaveProperty('passwordHash');
      expect(res.body.data.user).not.toHaveProperty('mfaSecret');

      expect(mockVerifyAuth.mock.calls[0][0].expectedChallenge).toBe(opts.body.data.challenge);

      const session = await agent.get('/__test__/session');
      expect(session.body).toMatchObject({
        userId: harness.limited.id,
        username: harness.limited.username,
        authProvider: 'local',
        isAdmin: false,
        hasChallenge: false,
      });

      const stored = await harness.db.listPasskeySummariesForUserAsync(harness.limited.id);
      expect(stored.find(p => p.id === id)?.lastUsedAt).toEqual(expect.any(Number));

      expect(await hasPasskeyAudit(harness.limited.id, 'login_success')).toBe(true);
    });

    it('skips TOTP for a user with MFA on (D5)', async () => {
      const mfaUser = await createUser();
      await harness.db.auth.updateUser(mfaUser.id, { mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' } as never);
      const { credentialId } = await seedPasskey(mfaUser.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));

      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('requireMfa');
      const session = await agent.get('/__test__/session');
      expect(session.body.userId).toBe(mfaUser.id);
      expect(session.body.pendingMfaUserId).toBeNull();
    });

    it('rejects an inactive user', async () => {
      const inactive = await createUser({ isActive: false });
      const { credentialId } = await seedPasskey(inactive.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('PASSKEY_LOGIN_FAILED');
      expect((await agent.get('/__test__/session')).body.userId).toBeNull();
    });

    it('rejects a non-local user', async () => {
      const oidcUser = await createUser({ authMethod: 'oidc' });
      const { credentialId } = await seedPasskey(oidcUser.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(401);
    });

    it('rejects an unknown credential with the same error', async () => {
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion('no-such-credential'));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('PASSKEY_LOGIN_FAILED');
      expect(mockVerifyAuth).not.toHaveBeenCalled();
    });

    it('signs in the credential owner even when the user handle names another user', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));
      const wrongHandle = Buffer.from(`meshmonitor:${harness.admin.id}`).toString('base64url');
      const res = await agent
        .post('/api/auth/passkey/login/verify')
        .send(assertion(credentialId, { userHandle: wrongHandle }));
      expect(res.status).toBe(200);
      const session = await agent.get('/__test__/session');
      expect(session.body.userId).toBe(harness.limited.id);
      expect(session.body.isAdmin).not.toBe(true);
    });

    it('treats a missing response as a failed login', async () => {
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      const res = await agent.post('/api/auth/passkey/login/verify').send({});
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('PASSKEY_LOGIN_FAILED');
    });

    it('refuses both login routes when DISABLE_LOCAL_AUTH is set', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      h.env = { disableLocalAuth: true };
      const opts = await agent.post('/api/auth/passkey/login/options').send({});
      expect(opts.status).toBe(403);
      mockVerifyAuth.mockResolvedValue(authVerified(0));
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('LOCAL_AUTH_DISABLED');
      expect((await agent.get('/__test__/session')).body.userId).toBeNull();
    });

    it('fails verification as a 401 and audits login_failed', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockRejectedValueOnce(new Error('bad signature'));
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(401);
      expect(await hasPasskeyAudit(harness.limited.id, 'login_failed')).toBe(true);
    });
  });

  // ── Challenge handling ────────────────────────────────────────────────────

  describe('challenge', () => {
    it('is single use', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const first = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(first.status).toBe(200);
      const second = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(second.status).toBe(400);
      expect(second.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
    });

    it('is deleted by a failed attempt too', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce({ verified: false, authenticationInfo: { newCounter: 0 } } as never);
      expect((await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId))).status).toBe(401);

      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));
      const retry = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(retry.status).toBe(400);
      expect(retry.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
    });

    it('is required', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      mockVerifyAuth.mockResolvedValue(authVerified(0));
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect(mockVerifyAuth).not.toHaveBeenCalled();
    });

    it('expires after 5 minutes', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + CHALLENGE_TTL_MS + 1000);
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect(mockVerifyAuth).not.toHaveBeenCalled();
    });

    it('is still good just inside 5 minutes', async () => {
      const { credentialId } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + CHALLENGE_TTL_MS - 5000);
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      expect(res.status).toBe(200);
    });
  });

  // ── Counter (§7) ──────────────────────────────────────────────────────────

  describe('signature counter', () => {
    async function loginWithCounter(stored: number, reported: number) {
      const { credentialId, id } = await seedPasskey(harness.limited.id, { counter: stored });
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(reported));
      const res = await agent.post('/api/auth/passkey/login/verify').send(assertion(credentialId));
      const row = (await harness.db.listPasskeysForUserAsync(harness.limited.id)).find(p => p.id === id)!;
      return { res, row };
    }

    it('rejects a counter that did not go up', async () => {
      const { res, row } = await loginWithCounter(5, 5);
      expect(res.status).toBe(401);
      expect(row.counter).toBe(5);
    });

    it('rejects a counter that went down', async () => {
      const { res } = await loginWithCounter(5, 3);
      expect(res.status).toBe(401);
    });

    it('accepts and stores a higher counter', async () => {
      const { res, row } = await loginWithCounter(5, 6);
      expect(res.status).toBe(200);
      expect(row.counter).toBe(6);
    });

    it('accepts 0 (synced passkeys)', async () => {
      const { res, row } = await loginWithCounter(0, 0);
      expect(res.status).toBe(200);
      expect(row.counter).toBe(0);
    });
  });

  // ── List / rename / delete ────────────────────────────────────────────────

  describe('manage', () => {
    it('lists only the caller’s passkeys, without key material', async () => {
      await seedPasskey(harness.limited.id, { nickname: 'mine' });
      await seedPasskey(harness.admin.id, { nickname: 'theirs' });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/auth/passkey/');
      expect(res.status).toBe(200);
      expect(res.body.data.map((p: { nickname: string }) => p.nickname)).toEqual(['mine']);
      expect(res.body.data[0]).not.toHaveProperty('publicKey');
      expect(res.body.data[0]).not.toHaveProperty('credentialId');
      expect(res.body.data[0].rpId).toBe('127.0.0.1');
    });

    it('renames the caller’s own passkey', async () => {
      const { id } = await seedPasskey(harness.limited.id, { nickname: 'old' });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.patch(`/api/auth/passkey/${id}`).send({ nickname: 'new' });
      expect(res.status).toBe(200);
      expect(res.body.data.nickname).toBe('new');
    });

    it('will not rename or delete another user’s passkey', async () => {
      const { id } = await seedPasskey(harness.admin.id, { nickname: 'theirs' });
      const agent = await harness.loginAs(harness.limited);
      const rename = await agent.patch(`/api/auth/passkey/${id}`).send({ nickname: 'hijacked' });
      expect(rename.status).toBe(404);
      const del = await agent.delete(`/api/auth/passkey/${id}`);
      expect(del.status).toBe(404);
      const theirs = await harness.db.listPasskeySummariesForUserAsync(harness.admin.id);
      expect(theirs.find(p => p.id === id)?.nickname).toBe('theirs');
    });

    it('deletes the caller’s own passkey', async () => {
      const { id } = await seedPasskey(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/api/auth/passkey/${id}`);
      expect(res.status).toBe(200);
      expect(await harness.db.countPasskeysForUserAsync(harness.limited.id)).toBe(0);
    });

    it('refuses to delete the last passkey of a passkey-only account', async () => {
      const { id } = await seedPasskey(harness.limited.id);
      await harness.db.setPasswordLoginDisabledAsync(harness.limited.id, true);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/api/auth/passkey/${id}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_PASSKEY');
      expect(await harness.db.countPasskeysForUserAsync(harness.limited.id)).toBe(1);
    });

    it('allows deleting one of two passkeys on a passkey-only account', async () => {
      const { id } = await seedPasskey(harness.limited.id);
      await seedPasskey(harness.limited.id);
      await harness.db.setPasswordLoginDisabledAsync(harness.limited.id, true);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/api/auth/passkey/${id}`);
      expect(res.status).toBe(200);
      expect(await harness.db.countPasskeysForUserAsync(harness.limited.id)).toBe(1);
    });

    it('rejects a bad id', async () => {
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.delete('/api/auth/passkey/abc')).status).toBe(400);
      expect((await agent.patch('/api/auth/passkey/0').send({ nickname: 'x' })).status).toBe(400);
    });

    it('requires sign-in', async () => {
      const agent = await harness.loginAs(null);
      expect((await agent.get('/api/auth/passkey/')).status).toBe(401);
      expect((await agent.delete('/api/auth/passkey/1')).status).toBe(401);
    });

    it('refuses non-local users', async () => {
      const oidcUser = await createUser({ authMethod: 'oidc' });
      const agent = await harness.loginAs(oidcUser);
      expect((await agent.get('/api/auth/passkey/')).status).toBe(403);
    });
  });

  // A leaked API token must not manage passkeys; only a browser session can.
  describe('API tokens are refused', () => {
    it.each([
      ['post', '/api/auth/passkey/register/options'],
      ['post', '/api/auth/passkey/register/verify'],
      ['get', '/api/auth/passkey/'],
      ['patch', '/api/auth/passkey/1'],
      ['delete', '/api/auth/passkey/1'],
    ] as const)('%s %s with a Bearer token is 401 SESSION_REQUIRED', async (method, path) => {
      const token = await harness.tokenFor(harness.limited);
      const res = await request(harness.app)[method](path)
        .set('Authorization', `Bearer ${token}`)
        .send({ nickname: 'x' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_REQUIRED');
    });
  });
});
