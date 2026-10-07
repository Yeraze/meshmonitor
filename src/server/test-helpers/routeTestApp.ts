/**
 * Integration-grade route test harness.
 *
 * ## Why this exists
 * The previous pattern for route tests mocked the entire DatabaseService singleton
 * (`vi.mock('../../services/database.js', ...)`), hand-rolling fake implementations
 * of `checkPermissionAsync`, `findUserByIdAsync`, etc. That approach lets tests pass
 * while the real middleware chain is broken — the mock re-implements the logic under
 * test, so a regression in `checkPermissionAsync` silently passes.
 *
 * ## Singleton DB decision (load-bearing — read before changing)
 * Under vitest `DATABASE_PATH=:memory:`, `src/services/database.ts` exports
 * `new DatabaseService()` at module level. The constructor opens a fresh `:memory:`
 * better-sqlite3 database, runs all registered migrations, and seeds the admin +
 * anonymous users. `authMiddleware.ts` imports this exact singleton, so the
 * middleware and the harness always see the same data.
 *
 * A separate `createTestDb()` connection is invisible to the middleware without an
 * invasive singleton rebind across ~35 repositories. This is why the harness uses
 * `databaseService` directly rather than a second `createTestDb()` connection.
 * `createTestDb()` remains correct for pure repository / service unit tests.
 *
 * ## Usage
 * ```ts
 * let harness: RouteTestHarness;
 * beforeEach(async () => {
 *   harness = await createRouteTestApp({ mount: app => app.use('/', myRouter) });
 *   await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
 * });
 * afterEach(() => harness.cleanup());
 *
 * it('allows access to sourceA', async () => {
 *   const agent = await harness.loginAs(harness.limited);
 *   const res = await agent.get('/rt-source-a/nodes');
 *   expect(res.status).toBe(200);
 * });
 * ```
 */

import express, { type Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';

/**
 * Monotonic counter ensuring unique usernames across repeated `createRouteTestApp()`
 * calls within the same test file. The in-memory DB persists for the entire file
 * (vitest fork isolation = one process per file), so unique usernames sidestep
 * duplicate-username errors without needing a hard user delete.
 */
let _rtCounter = 0;

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal user shape returned by the harness. */
export interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface RouteTestHarness {
  /** The Express app with real session + optionalAuth mounted, and the router under test. */
  app: Express;
  /**
   * The live singleton (already :memory: + migrations + seeded users).
   * Use for extra seeding or assertions: `harness.db.nodes.upsertNode(...)`.
   */
  db: typeof databaseService;
  /** Fixed source id 'rt-source-a' — seeded in the DB. */
  sourceA: string;
  /** Fixed source id 'rt-source-b' — seeded in the DB. */
  sourceB: string;
  /** Admin user (isAdmin: true) — bypasses all permission checks. */
  admin: SeededUser;
  /** Non-admin user — grants applied per-test via `grant()`. */
  limited: SeededUser;
  /** The real 'anonymous' row seeded by DatabaseService.seedInitialData. */
  anonymous: SeededUser;
  /**
   * Return a supertest agent whose cookie jar carries a real express-session for
   * the given user (session.userId set exactly as the real login does after
   * password verification). Pass `null` / `undefined` for an unauthenticated
   * agent — exercises the `findUserByUsernameAsync('anonymous')` fallback path.
   */
  loginAs(user?: SeededUser | number | null): Promise<ReturnType<typeof request.agent>>;
  /**
   * Insert one permission row scoped to `sourceId` (or global when omitted).
   * One call per action: call twice for read + write.
   *
   * @example
   * await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
   * await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
   */
  grant(
    userId: number,
    resource: string,
    action: 'read' | 'write' | 'viewOnMap',
    sourceId?: string
  ): Promise<void>;
  /** Delete all permission rows for a user (useful between sub-scenarios in one test). */
  revokeAll(userId: number): Promise<void>;
  /**
   * Mint a real API token for `user` and return the plaintext `mm_v1_…` string,
   * for exercising `Authorization: Bearer` on legacy routes end-to-end (#4259).
   * Backed by `auth.generateAndCreateApiToken` (real bcrypt hash → real
   * `validateApiTokenAsync`), so the middleware validates it exactly as in
   * production. Note: generating a token revokes the user's prior active token
   * (one active token per user), matching the app.
   */
  tokenFor(user: SeededUser | number): Promise<string>;
  /**
   * Delete seeded permissions + sources. Call in `afterEach`.
   * Users are left in place (inactive-safe, unique names).
   */
  cleanup(): Promise<void>;
}

export interface CreateRouteTestAppOptions {
  /**
   * Called after the session middleware and optionalAuth are mounted.
   * Mount your router under test here, e.g. `app => app.use('/api/sources', sourceRoutes)`.
   */
  mount: (app: Express) => void;
  /**
   * Set `false` to skip `optionalAuth()`, e.g. for routes that authenticate via
   * `requireAPIToken()` and set `req.user` themselves. Default: `true`.
   */
  useOptionalAuth?: boolean;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createRouteTestApp(
  opts: CreateRouteTestAppOptions
): Promise<RouteTestHarness> {
  // Must await before touching any repo — `initializeDrizzleRepositoriesAsync`
  // is fire-and-forget from the constructor; repos throw "Database not initialized"
  // until readyPromise resolves.
  await databaseService.waitForReady();

  const n = ++_rtCounter;
  const SOURCE_A = 'rt-source-a';
  const SOURCE_B = 'rt-source-b';

  // Seed sources idempotently: delete first (ignoring "not found"), then create.
  // This handles the case where a previous test run left rows behind (singleton
  // DB persists for the whole file). deleteSource returns false on not-found rather
  // than throwing, but the `.catch(() => {})` is a belt-and-suspenders guard.
  await databaseService.sources.deleteSource(SOURCE_A).catch(() => {});
  await databaseService.sources.deleteSource(SOURCE_B).catch(() => {});
  await databaseService.sources.createSource({
    id: SOURCE_A,
    name: 'Source A',
    type: 'meshtastic_tcp',
    config: {},
    enabled: true,
  });
  await databaseService.sources.createSource({
    id: SOURCE_B,
    name: 'Source B',
    type: 'meshtastic_tcp',
    config: {},
    enabled: true,
  });

  // Seed users. Unique usernames (rt-admin-N, rt-limited-N) prevent collision
  // across repeated createRouteTestApp() calls in the same file. No bcrypt —
  // tests log in programmatically via the /__test__/login route.
  const adminId = await databaseService.auth.createUser({
    username: `rt-admin-${n}`,
    passwordHash: null,
    authMethod: 'local',
    isAdmin: true,
    isActive: true,
    createdAt: Date.now(),
  });
  const limitedId = await databaseService.auth.createUser({
    username: `rt-limited-${n}`,
    passwordHash: null,
    authMethod: 'local',
    isAdmin: false,
    isActive: true,
    createdAt: Date.now(),
  });

  // Fetch the real anonymous row (guaranteed by DatabaseService.seedInitialData).
  //
  // DatabaseService resolves readyPromise synchronously (for SQLite) but fires
  // ensureAnonymousUser() as a fire-and-forget async task.  Under vitest
  // singleFork+isolate a new module instance is created for each file, and the
  // test's beforeEach may run before that background task commits the anonymous
  // row.  Poll with a 2-second timeout to let the seeding complete.
  let anonRow = await databaseService.auth.getUserByUsername('anonymous');
  if (!anonRow) {
    const deadline = Date.now() + 2000;
    while (!anonRow && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      anonRow = await databaseService.auth.getUserByUsername('anonymous');
    }
  }
  if (!anonRow) {
    throw new Error(
      'routeTestApp: anonymous user not found — seedInitialData must have run before createRouteTestApp()'
    );
  }

  const admin: SeededUser = { id: adminId, username: `rt-admin-${n}`, isAdmin: true };
  const limited: SeededUser = { id: limitedId, username: `rt-limited-${n}`, isAdmin: false };
  const anonymous: SeededUser = { id: anonRow.id, username: 'anonymous', isAdmin: false };

  // ── Build the Express app ─────────────────────────────────────────────────

  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'route-test',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false },
      // Cookie name must match requireAuth()'s cookie sniff (authMiddleware.ts L232)
      // so requireAuth-guarded routes receive the session correctly.
      name: 'meshmonitor.sid',
    })
  );

  // Test-only login route: sets session.userId exactly as the real login does
  // after successful password verification, but skips bcrypt for speed.
  app.post('/__test__/login', (req, res) => {
    req.session.userId = req.body.userId ?? undefined;
    req.session.save(() => res.status(204).end());
  });

  if (opts.useOptionalAuth !== false) {
    app.use(optionalAuth());
  }

  opts.mount(app);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const grant = async (
    userId: number,
    resource: string,
    action: 'read' | 'write' | 'viewOnMap',
    sourceId?: string
  ): Promise<void> => {
    await databaseService.auth.createPermission({
      userId,
      resource,
      canRead: action === 'read',
      canWrite: action === 'write',
      canViewOnMap: action === 'viewOnMap',
      sourceId: sourceId ?? null,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  };

  const revokeAll = async (userId: number): Promise<void> => {
    await databaseService.auth.deletePermissionsForUser(userId);
  };

  const cleanup = async (): Promise<void> => {
    await databaseService.auth.deletePermissionsForUser(limited.id).catch(() => {});
    await databaseService.auth.deletePermissionsForUser(admin.id).catch(() => {});
    await databaseService.sources.deleteSource(SOURCE_A).catch(() => {});
    await databaseService.sources.deleteSource(SOURCE_B).catch(() => {});
  };

  const loginAs = async (
    user?: SeededUser | number | null
  ): Promise<ReturnType<typeof request.agent>> => {
    const agent = request.agent(app);
    if (user != null) {
      const userId = typeof user === 'number' ? user : user.id;
      await agent.post('/__test__/login').send({ userId });
    }
    // loginAs(null) → unauthenticated agent → optionalAuth() falls through to
    // findUserByUsernameAsync('anonymous') → anonymous user.
    return agent;
  };

  const tokenFor = async (user: SeededUser | number): Promise<string> => {
    const userId = typeof user === 'number' ? user : user.id;
    const { token } = await databaseService.auth.generateAndCreateApiToken(userId, userId);
    return token;
  };

  return {
    app,
    db: databaseService,
    sourceA: SOURCE_A,
    sourceB: SOURCE_B,
    admin,
    limited,
    anonymous,
    loginAs,
    grant,
    revokeAll,
    tokenFor,
    cleanup,
  };
}
