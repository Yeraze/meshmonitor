/**
 * Regression: proxy-auth must regenerate the session ID when it binds a user
 * to the request, or an attacker who planted a `meshmonitor.sid` cookie on
 * the victim's browser can ride the post-authentication session (the
 * reverse-proxy's X-Forwarded-User headers are added ON TOP OF the client's
 * cookie, so a naive write of `req.session.userId = user.id` writes into the
 * attacker's session).
 *
 * The fix mirrors what `authRoutes.ts` already does for local / MFA / OIDC
 * login. This file exists purely to lock that behavior in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import databaseService from '../../services/database.js';
import { optionalAuth } from './authMiddleware.js';
import { extractProxyUser, isAdminUser, isNormalProxyUserAllowed } from './proxyAuth.js';
import { getEnvironmentConfig } from '../config/environment.js';

vi.mock('../../services/database.js', () => ({
  default: {
    findUserByIdAsync: vi.fn(),
    findUserByEmailAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    auditLogAsync: vi.fn().mockResolvedValue(undefined),
    auth: {
      createUser: vi.fn(),
      createPermission: vi.fn(),
      updateUser: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('./proxyAuth.js', () => ({
  extractProxyUser: vi.fn(),
  isAdminUser: vi.fn(() => false),
  isNormalProxyUserAllowed: vi.fn(() => true),
}));

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    proxyAuthEnabled: true,
    proxyAuthAutoProvision: false,
    proxyAuthAuditLogging: false,
  })),
}));

const mockDb = databaseService as any;
const mockExtract = extractProxyUser as unknown as ReturnType<typeof vi.fn>;
const mockIsAdmin = isAdminUser as unknown as ReturnType<typeof vi.fn>;
const mockGroupAllowed = isNormalProxyUserAllowed as unknown as ReturnType<typeof vi.fn>;
const mockEnv = getEnvironmentConfig as unknown as ReturnType<typeof vi.fn>;

const alice = { id: 42, username: 'alice', email: 'alice@example.com', isActive: true, isAdmin: false, authProvider: 'proxy' };
const bob   = { id: 43, username: 'bob',   email: 'bob@example.com',   isActive: true, isAdmin: false, authProvider: 'proxy' };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: true, // set session cookie even if nothing written yet
    cookie: { secure: false },
    name: 'meshmonitor.sid',
  }));
  app.get('/whoami', optionalAuth(), (req: any, res) => {
    res.json({ userId: req.user?.id ?? null, sid: req.sessionID });
  });
  return app;
}

/** Pull the meshmonitor.sid cookie value out of a supertest response. */
function extractSid(headers: any): string | undefined {
  const setCookie = headers['set-cookie'];
  if (!Array.isArray(setCookie)) return undefined;
  const line = setCookie.find((c: string) => c.startsWith('meshmonitor.sid='));
  return line?.split(';')[0].split('=')[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGroupAllowed.mockReturnValue(true);
  mockIsAdmin.mockReturnValue(false);
  mockEnv.mockReturnValue({
    proxyAuthEnabled: true,
    proxyAuthAutoProvision: false,
    proxyAuthAuditLogging: false,
  });
});

describe('optionalAuth() — proxy-auth session-fixation defense', () => {
  it('rotates the session ID when binding a user to a pre-existing session (the fixation case)', async () => {
    const app = buildApp();

    // Step 1: attacker plants a cookie by hitting an unauthenticated endpoint.
    // No proxy-auth headers, no user — but the session ID is now issued.
    mockExtract.mockReturnValue(null);
    const planted = await request(app).get('/whoami');
    const plantedSid = extractSid(planted.headers);
    expect(plantedSid).toBeTruthy();
    expect(planted.body.userId).toBeNull();

    // Step 2: victim reuses that same cookie, this time with proxy-auth
    // headers set by the reverse proxy. The middleware MUST bind alice to a
    // FRESH session id, not the planted one.
    mockExtract.mockReturnValue({ email: alice.email, groups: [], source: 'proxy' });
    mockDb.findUserByEmailAsync.mockResolvedValue(alice);
    mockDb.findUserByIdAsync.mockResolvedValue(alice);

    const authed = await request(app)
      .get('/whoami')
      .set('Cookie', `meshmonitor.sid=${plantedSid}`);

    expect(authed.status).toBe(200);
    expect(authed.body.userId).toBe(alice.id);
    // The proof: sessionID (server-side) has rotated away from the attacker's.
    expect(authed.body.sid).not.toBe(plantedSid);
    // And the Set-Cookie carries the new id, so the browser will swap over.
    const rotatedSid = extractSid(authed.headers);
    expect(rotatedSid).toBeTruthy();
    expect(rotatedSid).not.toBe(plantedSid);
  });

  it('does NOT rotate on subsequent hops that carry the already-bound identity', async () => {
    const app = buildApp();

    // First bind: force one rotation.
    mockExtract.mockReturnValue({ email: alice.email, groups: [], source: 'proxy' });
    mockDb.findUserByEmailAsync.mockResolvedValue(alice);
    mockDb.findUserByIdAsync.mockResolvedValue(alice);
    const first = await request(app).get('/whoami');
    const boundSid = first.body.sid;
    expect(boundSid).toBeTruthy();

    // Second hop with the SAME cookie AND the same headers — must keep sid.
    const second = await request(app)
      .get('/whoami')
      .set('Cookie', `meshmonitor.sid=${extractSid(first.headers)}`);

    expect(second.body.userId).toBe(alice.id);
    expect(second.body.sid).toBe(boundSid);
  });

  it('rotates again when a DIFFERENT proxy user arrives on the same cookie', async () => {
    const app = buildApp();

    mockExtract.mockReturnValue({ email: alice.email, groups: [], source: 'proxy' });
    mockDb.findUserByEmailAsync.mockResolvedValue(alice);
    mockDb.findUserByIdAsync.mockResolvedValue(alice);
    const asAlice = await request(app).get('/whoami');
    const aliceSid = extractSid(asAlice.headers);

    // Same session cookie, but the reverse proxy now identifies a different user.
    mockExtract.mockReturnValue({ email: bob.email, groups: [], source: 'proxy' });
    mockDb.findUserByEmailAsync.mockResolvedValue(bob);
    mockDb.findUserByIdAsync.mockResolvedValue(bob);
    const asBob = await request(app)
      .get('/whoami')
      .set('Cookie', `meshmonitor.sid=${aliceSid}`);

    expect(asBob.body.userId).toBe(bob.id);
    expect(asBob.body.sid).not.toBe(asAlice.body.sid);
  });

  it('preserves csrfToken across regeneration', async () => {
    const app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true,
      cookie: { secure: false },
      name: 'meshmonitor.sid',
    }));
    // Prime a csrfToken on the session before the proxy-auth hop, then run
    // optionalAuth and check the token still sits on req.session afterward.
    app.get('/prime', (req: any, res) => { req.session.csrfToken = 'csrf-abc'; res.json({ sid: req.sessionID }); });
    app.get('/whoami', optionalAuth(), (req: any, res) => {
      res.json({ userId: req.user?.id ?? null, sid: req.sessionID, csrf: req.session.csrfToken ?? null });
    });

    mockExtract.mockReturnValue(null);
    const primed = await request(app).get('/prime');
    const primedSid = extractSid(primed.headers);

    mockExtract.mockReturnValue({ email: alice.email, groups: [], source: 'proxy' });
    mockDb.findUserByEmailAsync.mockResolvedValue(alice);
    mockDb.findUserByIdAsync.mockResolvedValue(alice);

    const authed = await request(app)
      .get('/whoami')
      .set('Cookie', `meshmonitor.sid=${primedSid}`);

    expect(authed.body.userId).toBe(alice.id);
    expect(authed.body.sid).not.toBe(primedSid);
    expect(authed.body.csrf).toBe('csrf-abc');
  });
});
