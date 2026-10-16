/**
 * Passkey-only accounts (#5841 PR 3): step-up, the password-login switch,
 * recovery codes, the gates on password sign-in, and the admin view/revoke.
 *
 * Real session + auth middleware + DB via createRouteTestApp, with the auth,
 * passkey and user routers mounted as in production. WebAuthn verification is
 * mocked at the @simplewebauthn/server boundary, like passkeyRoutes.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import passkeyRoutes, { CHALLENGE_TTL_MS, LAST_ADMIN_CONFIRM } from './passkeyRoutes.js';
import authRoutes from './authRoutes.js';
import userRoutes from './userRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { mfaService } from '../services/mfa.js';

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

// Pass-through limiter that records the paths it guards.
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
  generateRegistrationOptions: vi.fn(async (opts: { rpID: string }) => ({
    challenge: `reg-challenge-${Math.random().toString(36).slice(2)}`,
    rp: { id: opts.rpID, name: 'MeshMonitor' },
  })),
  generateAuthenticationOptions: vi.fn(async (opts: { rpID: string; allowCredentials?: unknown[] }) => ({
    challenge: `auth-challenge-${Math.random().toString(36).slice(2)}`,
    rpId: opts.rpID,
    allowCredentials: opts.allowCredentials ?? [],
  })),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

const mockGenAuth = vi.mocked(generateAuthenticationOptions);
const mockVerifyAuth = vi.mocked(verifyAuthenticationResponse);

function authVerified(newCounter: number) {
  return {
    verified: true,
    authenticationInfo: { newCounter },
  } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
}

/** A browser assertion, as the client posts it in `assertion`. */
function signed(credentialId: string) {
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON: 'x', authenticatorData: 'x', signature: 'x' },
    clientExtensionResults: {},
  };
}

let seq = 0;
const PASSWORD = 'correct-horse-9';

describe('passkey-only accounts', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    h.env = { disableLocalAuth: false };
    h.authLimiterCalls = [];
    mockVerifyAuth.mockReset();
    mockGenAuth.mockClear();
    harness = await createRouteTestApp({
      mount: (app: Express) => {
        app.use('/api/auth/passkey', passkeyRoutes);
        app.use('/api/auth', authRoutes);
        app.use('/api/users', userRoutes);
        app.get('/__test__/session', (req, res) => {
          res.json({
            userId: req.session.userId ?? null,
            authProvider: req.session.authProvider ?? null,
            isAdmin: req.session.isAdmin ?? null,
            pendingMfaUserId: req.session.pendingMfaUserId ?? null,
            challengePurpose: req.session.webauthnChallenge?.purpose ?? null,
            passwordChangeRequired: req.session.passwordChangeRequired ?? null,
          });
        });
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function createUser(opts: { isAdmin?: boolean; password?: string; mfa?: boolean } = {}) {
    const username = `po-user-${Date.now().toString(36)}-${++seq}`;
    const id = await harness.db.auth.createUser({
      username,
      passwordHash: await bcrypt.hash(opts.password ?? PASSWORD, 4),
      authMethod: 'local',
      isAdmin: opts.isAdmin ?? false,
      isActive: true,
      createdAt: Date.now(),
    } as Parameters<typeof harness.db.auth.createUser>[0]);
    if (opts.mfa) {
      await harness.db.auth.updateUser(id, { mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
    }
    return { id, username, isAdmin: opts.isAdmin ?? false };
  }

  async function seedPasskey(userId: number, counter = 0) {
    const credentialId = `po-cred-${Date.now().toString(36)}-${++seq}`;
    const id = await harness.db.createPasskeyAsync({
      userId,
      credentialId,
      publicKey: 'AQIDBA',
      counter,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
      rpId: '127.0.0.1',
      nickname: null,
    });
    return { id, credentialId };
  }

  /** Put a user into passkey-only mode directly, returning the plain codes. */
  async function makePasskeyOnly(userId: number): Promise<string[]> {
    const codes = mfaService.generateBackupCodes();
    const hashes = await mfaService.hashBackupCodes(codes);
    await harness.db.setPasskeyRecoveryCodesAsync(userId, JSON.stringify(hashes));
    await harness.db.setPasswordLoginDisabledAsync(userId, true);
    return codes;
  }

  async function auditHas(userId: number, action: string): Promise<boolean> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { logs } = await harness.db.auth.getAuditLogsFiltered({ userId, action });
      if (logs.length > 0) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;
  }

  /**
   * Make `userId` the only active admin for one test, then put the others
   * back. The file's DB is shared, so other harness admins exist.
   */
  async function asOnlyAdmin<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const others = (await harness.db.auth.getAllUsers()).filter(u => u.isAdmin && u.isActive && u.id !== userId);
    for (const u of others) await harness.db.auth.updateUser(u.id, { isActive: false });
    try {
      return await fn();
    } finally {
      for (const u of others) await harness.db.auth.updateUser(u.id, { isActive: true });
    }
  }

  // ── session only ───────────────────────────────────────────────────────────

  describe('API tokens are refused on the session-only routes', () => {
    it.each([
      ['post', '/api/auth/passkey/step-up/options'],
      ['get', '/api/auth/passkey/password-login'],
      ['post', '/api/auth/passkey/password-login'],
    ] as const)('%s %s with a Bearer token is 401 SESSION_REQUIRED', async (method, path) => {
      const user = await createUser();
      await seedPasskey(user.id);
      const token = await harness.tokenFor(user.id);
      const res = await request(harness.app)[method](path)
        .set('Authorization', `Bearer ${token}`)
        .send({ disabled: false });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_REQUIRED');
    });

    it.each([
      ['get', '/api/auth/passkey/admin/users/1'],
      ['delete', '/api/auth/passkey/admin/users/1/1'],
    ] as const)("%s %s with an admin's Bearer token is 401 SESSION_REQUIRED", async (method, path) => {
      const token = await harness.tokenFor(harness.admin);
      const res = await request(harness.app)[method](path).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_REQUIRED');
    });
  });

  // ── step-up ────────────────────────────────────────────────────────────────

  describe('POST /step-up/options', () => {
    it("offers only the caller's own passkeys", async () => {
      const user = await createUser();
      const other = await createUser();
      const mine = await seedPasskey(user.id);
      await seedPasskey(other.id);

      const agent = await harness.loginAs(user.id);
      const res = await agent.post('/api/auth/passkey/step-up/options').send({});
      expect(res.status).toBe(200);
      const args = mockGenAuth.mock.calls.at(-1)![0];
      expect(args.allowCredentials).toEqual([{ id: mine.credentialId, transports: ['internal'] }]);

      const session = await agent.get('/__test__/session');
      expect(session.body.challengePurpose).toBe('step-up');
    });

    it('is 409 with no passkeys', async () => {
      const user = await createUser();
      const agent = await harness.loginAs(user.id);
      const res = await agent.post('/api/auth/passkey/step-up/options').send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_PASSKEYS');
    });

    it('requires sign-in', async () => {
      const agent = await harness.loginAs(null);
      expect((await agent.post('/api/auth/passkey/step-up/options').send({})).status).toBe(401);
    });
  });

  // ── turning password login off ─────────────────────────────────────────────

  describe('POST /password-login { disabled: true }', () => {
    it('turns it off with a fresh step-up and returns 10 codes once', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id, 4);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValueOnce(authVerified(5));

      const res = await agent.post('/api/auth/passkey/password-login').send({
        disabled: true,
        assertion: signed(pk.credentialId),
      });
      expect(res.status).toBe(200);
      expect(res.body.data.disabled).toBe(true);
      const codes: string[] = res.body.data.recoveryCodes;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);

      // Same library path as login: the step-up challenge and the stored key.
      const verifyArgs = mockVerifyAuth.mock.calls[0][0];
      expect(verifyArgs.expectedChallenge).toMatch(/^auth-challenge-/);
      expect(verifyArgs.credential.id).toBe(pk.credentialId);

      const state = await harness.db.getPasskeyLoginStateAsync(user.id);
      expect(state?.passwordLoginDisabled).toBe(true);
      const hashes = JSON.parse(state!.passkeyRecoveryCodes!) as string[];
      expect(hashes).toHaveLength(10);
      expect(hashes).not.toContain(codes[0]);
      expect(await bcrypt.compare(codes[0], hashes[0])).toBe(true);

      // Counter stored.
      const row = await harness.db.getPasskeyByCredentialIdAsync(pk.credentialId);
      expect(row?.counter).toBe(5);

      expect(await auditHas(user.id, 'password_login_disabled')).toBe(true);

      const status = await agent.get('/api/auth/passkey/password-login');
      expect(status.body.data).toEqual({ disabled: true, recoveryCodesLeft: 10 });
    });

    it('cannot reuse the step-up challenge', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const body = { disabled: true, assertion: signed(pk.credentialId) };
      expect((await agent.post('/api/auth/passkey/password-login').send(body)).status).toBe(200);
      await harness.db.enablePasswordLoginAsync(user.id);

      const again = await agent.post('/api/auth/passkey/password-login').send(body);
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect((await harness.db.getPasskeyLoginStateAsync(user.id))?.passwordLoginDisabled).toBe(false);
    });

    it('a failed step-up also spends the challenge', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});

      mockVerifyAuth.mockResolvedValueOnce({ verified: false } as never);
      const bad = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('STEP_UP_FAILED');

      mockVerifyAuth.mockResolvedValueOnce(authVerified(0));
      const retry = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(retry.status).toBe(400);
      expect(retry.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect((await harness.db.getPasskeyLoginStateAsync(user.id))?.passwordLoginDisabled).toBe(false);
    });

    it('a login challenge cannot stand in for step-up', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/login/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect(mockVerifyAuth).not.toHaveBeenCalled();
    });

    it('a register challenge cannot stand in for step-up', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/register/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
      expect(mockVerifyAuth).not.toHaveBeenCalled();
    });

    it('a step-up challenge cannot be used to log in', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const res = await agent.post('/api/auth/passkey/login/verify').send({ response: signed(pk.credentialId) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
    });

    it('expires after 5 minutes', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + CHALLENGE_TTL_MS + 1000);
      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
    });

    it("refuses an assertion from someone else's passkey", async () => {
      const user = await createUser();
      const other = await createUser();
      await seedPasskey(user.id);
      const theirs = await seedPasskey(other.id);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(theirs.credentialId) });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('STEP_UP_FAILED');
      expect(mockVerifyAuth).not.toHaveBeenCalled();
      expect((await harness.db.getPasskeyLoginStateAsync(user.id))?.passwordLoginDisabled).toBe(false);
    });

    it('refuses a counter that went backwards', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id, 10);
      const agent = await harness.loginAs(user.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(3));

      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(res.status).toBe(401);
      expect((await harness.db.getPasskeyLoginStateAsync(user.id))?.passwordLoginDisabled).toBe(false);
    });

    it('needs at least one passkey', async () => {
      const user = await createUser();
      const agent = await harness.loginAs(user.id);
      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed('x') });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_PASSKEYS');
    });

    it('needs a boolean `disabled`', async () => {
      const user = await createUser();
      const agent = await harness.loginAs(user.id);
      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  // ── last admin (D3) ────────────────────────────────────────────────────────

  describe('the only active admin', () => {
    it('must confirm with DISABLE; the step-up challenge stays valid for the retry', async () => {
      const admin = await createUser({ isAdmin: true });
      const pk = await seedPasskey(admin.id);
      const agent = await harness.loginAs(admin.id);

      await asOnlyAdmin(admin.id, async () => {
        await agent.post('/api/auth/passkey/step-up/options').send({});
        mockVerifyAuth.mockResolvedValue(authVerified(0));
        const body = { disabled: true, assertion: signed(pk.credentialId) };

        const first = await agent.post('/api/auth/passkey/password-login').send(body);
        expect(first.status).toBe(200);
        expect(first.body.data).toEqual({ requireConfirm: true });
        expect(mockVerifyAuth).not.toHaveBeenCalled();
        expect((await harness.db.getPasskeyLoginStateAsync(admin.id))?.passwordLoginDisabled).toBe(false);
        expect((await agent.get('/__test__/session')).body.challengePurpose).toBe('step-up');

        // Wrong word: still asks.
        const lower = await agent.post('/api/auth/passkey/password-login').send({ ...body, confirm: 'disable' });
        expect(lower.body.data).toEqual({ requireConfirm: true });

        const confirmed = await agent.post('/api/auth/passkey/password-login').send({ ...body, confirm: LAST_ADMIN_CONFIRM });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.data.disabled).toBe(true);
        expect(confirmed.body.data.recoveryCodes).toHaveLength(10);
      });
      expect((await harness.db.getPasskeyLoginStateAsync(admin.id))?.passwordLoginDisabled).toBe(true);
    });

    it('an admin with another active admin needs no confirmation', async () => {
      const admin = await createUser({ isAdmin: true });
      const pk = await seedPasskey(admin.id);
      const agent = await harness.loginAs(admin.id);
      await agent.post('/api/auth/passkey/step-up/options').send({});
      mockVerifyAuth.mockResolvedValue(authVerified(0));

      const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: true, assertion: signed(pk.credentialId) });
      expect(res.status).toBe(200);
      expect(res.body.data.disabled).toBe(true);
    });
  });

  // ── turning it back on ─────────────────────────────────────────────────────

  it('POST /password-login { disabled: false } clears the flag and the codes', async () => {
    const user = await createUser();
    await seedPasskey(user.id);
    await makePasskeyOnly(user.id);
    const agent = await harness.loginAs(user.id);

    const res = await agent.post('/api/auth/passkey/password-login').send({ disabled: false });
    expect(res.status).toBe(200);
    expect(await harness.db.getPasskeyLoginStateAsync(user.id)).toEqual({ passwordLoginDisabled: false, passkeyRecoveryCodes: null });
    expect(await auditHas(user.id, 'password_login_enabled')).toBe(true);
  });

  // ── password sign-in while off ─────────────────────────────────────────────

  describe('password sign-in while it is off', () => {
    it('POST /api/auth/login gives exactly the bad-password 401', async () => {
      const user = await createUser();
      const wrong = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: 'wrong-password' });
      expect(wrong.status).toBe(401);

      await makePasskeyOnly(user.id);
      const right = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: PASSWORD });
      expect(right.status).toBe(401);
      expect(right.body).toEqual(wrong.body);
      expect(right.headers['set-cookie']).toBeUndefined();
    });

    it('an MFA account gets the same 401, not the MFA step', async () => {
      const user = await createUser({ mfa: true });
      const wrong = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: 'wrong-password' });

      await makePasskeyOnly(user.id);
      const agent = await harness.loginAs(null);
      const right = await agent.post('/api/auth/login').send({ username: user.username, password: PASSWORD });
      expect(right.status).toBe(401);
      expect(right.body).toEqual(wrong.body);
      expect((await agent.get('/__test__/session')).body.pendingMfaUserId).toBeNull();
    });

    it('a pending MFA step cannot finish once password login is off', async () => {
      const user = await createUser({ mfa: true });
      const agent = await harness.loginAs(null);
      const first = await agent.post('/api/auth/login').send({ username: user.username, password: PASSWORD });
      expect(first.body.requireMfa).toBe(true);

      await makePasskeyOnly(user.id);
      const res = await agent.post('/api/auth/verify-mfa').send({ token: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid MFA state');
      expect((await agent.get('/__test__/session')).body.userId).toBeNull();
    });

    it('change-password is refused', async () => {
      const user = await createUser();
      await makePasskeyOnly(user.id);
      const before = await harness.db.auth.getUserById(user.id);
      const agent = await harness.loginAs(user.id);

      const res = await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'another-pass-1' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PASSWORD_LOGIN_DISABLED');
      expect((await harness.db.auth.getUserById(user.id))?.passwordHash).toBe(before?.passwordHash);
    });

    it('password sign-in works again once it is back on', async () => {
      const user = await createUser();
      await makePasskeyOnly(user.id);
      await harness.db.enablePasswordLoginAsync(user.id);
      const res = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: PASSWORD });
      expect(res.status).toBe(200);
    });
  });

  // ── recovery ───────────────────────────────────────────────────────────────

  describe('POST /recover', () => {
    it('signs in on a new session, turns password login back on, and asks for a new password', async () => {
      const user = await createUser();
      await seedPasskey(user.id);
      const codes = await makePasskeyOnly(user.id);
      const agent = await harness.loginAs(null);

      // Give the agent a session first, to check the id changes.
      const pre = await agent.post('/api/auth/passkey/login/options').send({});
      const preCookie = String(pre.headers['set-cookie']?.[0] ?? '').split(';')[0];
      expect(preCookie).toMatch(/^meshmonitor\.sid=/);

      const res = await agent.post('/api/auth/passkey/recover').send({ username: user.username, code: codes[3].toLowerCase() });
      expect(res.status).toBe(200);
      expect(res.body.data.passwordChangeRequired).toBe(true);
      expect(res.body.data.user).not.toHaveProperty('passkeyRecoveryCodes');
      const postCookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];
      expect(postCookie).toMatch(/^meshmonitor\.sid=/);
      expect(postCookie).not.toBe(preCookie);

      const session = await agent.get('/__test__/session');
      expect(session.body).toMatchObject({ userId: user.id, authProvider: 'local', isAdmin: false, passwordChangeRequired: true });

      expect(await harness.db.getPasskeyLoginStateAsync(user.id)).toEqual({ passwordLoginDisabled: false, passkeyRecoveryCodes: null });
      expect(h.authLimiterCalls).toContain('/recover');
      expect(await auditHas(user.id, 'passkey_recovery_used')).toBe(true);

      const status = await agent.get('/api/auth/status');
      expect(status.body.authenticated).toBe(true);
      expect(status.body.passwordChangeRequired).toBe(true);

      // Password login is back on.
      const login = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: PASSWORD });
      expect(login.status).toBe(200);
    });

    it('works once: the same code, or any other, fails afterwards', async () => {
      const user = await createUser();
      const codes = await makePasskeyOnly(user.id);

      const first = await request(harness.app).post('/api/auth/passkey/recover').send({ username: user.username, code: codes[0] });
      expect(first.status).toBe(200);

      // Put the account back into passkey-only mode with the OLD hashes gone.
      await harness.db.setPasswordLoginDisabledAsync(user.id, true);
      const again = await request(harness.app).post('/api/auth/passkey/recover').send({ username: user.username, code: codes[0] });
      expect(again.status).toBe(401);
      const other = await request(harness.app).post('/api/auth/passkey/recover').send({ username: user.username, code: codes[1] });
      expect(other.status).toBe(401);
    });

    it('two racing requests with one code: only one wins', async () => {
      const user = await createUser();
      const codes = await makePasskeyOnly(user.id);
      const [a, b] = await Promise.all([
        request(harness.app).post('/api/auth/passkey/recover').send({ username: user.username, code: codes[0] }),
        request(harness.app).post('/api/auth/passkey/recover').send({ username: user.username, code: codes[0] }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 401]);
    });

    it('gives one generic error for every failure', async () => {
      const user = await createUser();
      const codes = await makePasskeyOnly(user.id);
      const notPasskeyOnly = await createUser();

      const bodies = [
        { username: user.username, code: 'WRONG123' },
        { username: 'no-such-user-xyz', code: codes[0] },
        { username: notPasskeyOnly.username, code: codes[0] },
        { username: user.username },
        { username: user.username, code: 'x'.repeat(200) },
        { username: { $ne: '' }, code: codes[0] },
      ];
      const replies = [];
      for (const body of bodies) {
        const res = await request(harness.app).post('/api/auth/passkey/recover').send(body);
        replies.push({ status: res.status, body: res.body });
      }
      for (const r of replies) expect(r).toEqual(replies[0]);
      expect(replies[0].status).toBe(401);
      expect(replies[0].body.code).toBe('RECOVERY_FAILED');

      // None of them spent a code.
      expect((await harness.db.getPasskeyLoginStateAsync(user.id))?.passwordLoginDisabled).toBe(true);
    });

    it('an inactive user cannot recover', async () => {
      const user = await createUser();
      const codes = await makePasskeyOnly(user.id);
      await harness.db.auth.updateUser(user.id, { isActive: false });
      const res = await request(harness.app).post('/api/auth/passkey/recover').send({ username: user.username, code: codes[0] });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('RECOVERY_FAILED');
    });

    it('the recovered session sets a new password without the old one, once', async () => {
      const user = await createUser();
      const codes = await makePasskeyOnly(user.id);
      const agent = await harness.loginAs(null);
      await agent.post('/api/auth/passkey/recover').send({ username: user.username, code: codes[0] });

      const res = await agent.post('/api/auth/change-password').send({ newPassword: 'brand-new-pass-7' });
      expect(res.status).toBe(200);
      expect((await agent.get('/api/auth/status')).body.passwordChangeRequired).toBe(false);

      const login = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: 'brand-new-pass-7' });
      expect(login.status).toBe(200);

      // The flag went with the change: the old-password rule is back.
      const again = await agent.post('/api/auth/change-password').send({ newPassword: 'third-pass-777' });
      expect(again.status).toBe(400);
    });

    it('an ordinary session still needs the current password', async () => {
      const user = await createUser();
      const agent = await harness.loginAs(user.id);
      const res = await agent.post('/api/auth/change-password').send({ newPassword: 'brand-new-pass-7' });
      expect(res.status).toBe(400);
    });
  });

  // ── admin (D1) ─────────────────────────────────────────────────────────────

  describe('admin view and revoke', () => {
    it("lists a user's passkeys for an admin, not for anyone else", async () => {
      const user = await createUser();
      await seedPasskey(user.id);
      await seedPasskey(user.id);

      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get(`/api/auth/passkey/admin/users/${user.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.passkeys).toHaveLength(2);
      expect(res.body.data.passkeys[0]).not.toHaveProperty('publicKey');
      expect(res.body.data.passwordLoginDisabled).toBe(false);

      const limited = await harness.loginAs(harness.limited);
      expect((await limited.get(`/api/auth/passkey/admin/users/${user.id}`)).status).toBe(403);
      expect((await limited.delete(`/api/auth/passkey/admin/users/${user.id}/1`)).status).toBe(403);
    });

    it('revokes a passkey and audits it', async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.delete(`/api/auth/passkey/admin/users/${user.id}/${pk.id}`);
      expect(res.status).toBe(200);
      expect(await harness.db.countPasskeysForUserAsync(user.id)).toBe(0);
      expect(await auditHas(harness.admin.id, 'passkey_revoked_by_admin')).toBe(true);
    });

    it("refuses to revoke a passkey-only user's last passkey", async () => {
      const user = await createUser();
      const pk = await seedPasskey(user.id);
      await makePasskeyOnly(user.id);
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.delete(`/api/auth/passkey/admin/users/${user.id}/${pk.id}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_PASSKEY');
      expect(await harness.db.countPasskeysForUserAsync(user.id)).toBe(1);
      expect((await harness.db.getPasskeyLoginStateAsync(user.id))?.passwordLoginDisabled).toBe(true);
    });

    it("cannot revoke a passkey through another user's id", async () => {
      const user = await createUser();
      const other = await createUser();
      const theirs = await seedPasskey(other.id);
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.delete(`/api/auth/passkey/admin/users/${user.id}/${theirs.id}`);
      expect(res.status).toBe(404);
      expect(await harness.db.countPasskeysForUserAsync(other.id)).toBe(1);
    });

    it('an admin-set password turns password login back on and drops the codes', async () => {
      const user = await createUser();
      await seedPasskey(user.id);
      await makePasskeyOnly(user.id);
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.post(`/api/users/${user.id}/set-password`).send({ newPassword: 'admin-chosen-1' });
      expect(res.status).toBe(200);
      expect(await harness.db.getPasskeyLoginStateAsync(user.id)).toEqual({ passwordLoginDisabled: false, passkeyRecoveryCodes: null });

      const login = await request(harness.app).post('/api/auth/login').send({ username: user.username, password: 'admin-chosen-1' });
      expect(login.status).toBe(200);
    });

    it('an admin password reset does the same', async () => {
      const user = await createUser();
      await makePasskeyOnly(user.id);
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.post(`/api/users/${user.id}/reset-password`).send({});
      expect(res.status).toBe(200);
      expect(await harness.db.getPasskeyLoginStateAsync(user.id)).toEqual({ passwordLoginDisabled: false, passkeyRecoveryCodes: null });
    });

    it('the users list carries passkey counts and the switch', async () => {
      const user = await createUser();
      await seedPasskey(user.id);
      await seedPasskey(user.id);
      await makePasskeyOnly(user.id);
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.get('/api/users');
      const row = res.body.users.find((u: { id: number }) => u.id === user.id);
      expect(row).toMatchObject({ passkeyCount: 2, passwordLoginDisabled: true });
      expect(row).not.toHaveProperty('passkeyRecoveryCodes');
      const limitedRow = res.body.users.find((u: { id: number }) => u.id === harness.limited.id);
      expect(limitedRow.passkeyCount).toBe(0);
    });
  });
});
