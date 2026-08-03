/**
 * v1 messages — sourceId permission scoping tests
 *
 * Converted from the monkey-patch pattern (vi.mock('.../services/database.js'))
 * to the real-middleware harness (createRouteTestApp). Uses vi.spyOn passthrough
 * on checkPermissionAsync / getUserPermissionSetAsync to assert call routing
 * while the real permission logic runs against actual DB rows.
 *
 * Route profile: GET /api/v1/sources/:sourceId/messages
 *   - No requirePermission middleware — handler calls databaseService.checkPermissionAsync
 *     inline (getAccessibleChannels) when a sourceId path param is present, or
 *     calls getUserPermissionSetAsync for the global (no-sourceId) path.
 *   - Sets req.user from requireAPIToken in production; simulated via a mount
 *     middleware here (useOptionalAuth: false).
 *
 * See src/server/test-helpers/routeTestApp.ts for the design rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Non-DB mocks stay: these modules make external node connections or require
// hardware state that must not run in unit tests.
vi.mock('../../meshtasticManager.js', () => ({ default: {} }));
vi.mock('../../meshcoreManager.js', () => ({ default: {} }));
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn() },
}));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));
vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import v1Messages from './messages.js';

describe('v1 messages — sourceId scoping', () => {
  let harness: RouteTestHarness;
   
  let permSpy: any;
   
  let globalPermSpy: any;

  beforeEach(async () => {
    // useOptionalAuth: false — v1 routes authenticate via requireAPIToken, not
    // session. We simulate that by injecting req.user in the mount closure.
    // The closure captures the `harness` binding by reference, so harness.limited
    // is resolved at request time (after the createRouteTestApp call below).
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        // Simulate requireAPIToken: set req.user so the handler can read
        // userId / isAdmin without touching the session.
        app.use((req: any, _res: any, next: any) => {
          req.user = harness.limited;
          next();
        });
        // Scoped mount: the :sourceId path param threads into the mergeParams
        // router, mirroring the canonical /api/v1/sources/:sourceId/messages shape.
        app.use('/v1/sources/:sourceId/messages', v1Messages);
        // Unscoped mount: no :sourceId param exercises the handler's global
        // (getUserPermissionSetAsync) branch.
        app.use('/v1/messages', v1Messages);
      },
    });

    // Grant messages:read + channel_0:read on sourceA only.
    // No grants for sourceB — this is the source-isolation baseline.
    await harness.grant(harness.limited.id, 'messages',  'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);

    // Passthrough spies: record calls while running the real implementation so
    // we can assert both routing behaviour AND actual permission enforcement.
    permSpy       = vi.spyOn(databaseService, 'checkPermissionAsync');
    globalPermSpy = vi.spyOn(databaseService, 'getUserPermissionSetAsync');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  // ── source-isolation assertion ─────────────────────────────────────────────
  //
  // The limited user holds grants on sourceA only. The pair below drives the
  // real checkPermissionAsync SQL against permissions.sourceId rows, proving
  // that source isolation is enforced by actual DB logic — not a hand-rolled
  // lambda (the regression class exposed by issue #3745).

  it('GET /sources/sourceA/messages → checkPermissionAsync called with sourceA, 200 returned', async () => {
    const res = await request(harness.app)
      .get(`/v1/sources/${harness.sourceA}/messages`);

    expect(res.status).toBe(200);

    // Every call inside getAccessibleChannels must be scoped to sourceA
    const calls = permSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[3]).toBe(harness.sourceA);
    }
    // Global getUserPermissionSetAsync must NOT be invoked in the per-source path
    expect(globalPermSpy).not.toHaveBeenCalled();
  });

  it('GET /sources/sourceB/messages → empty accessible channels, count 0 (source isolation — real checkPermissionAsync)', async () => {
    // Limited user has NO grants on sourceB.  getAccessibleChannels loops
    // channels 0-7 + messages:read — all checkPermissionAsync calls return false.
    // accessibleChannels is an empty Set → every message is filtered → count 0.
    // Previously a `() => sourceId === 'sourceA'` lambda would hide this;
    // here the real SQL enforces it.
    const res = await request(harness.app)
      .get(`/v1/sources/${harness.sourceB}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);

    // All calls scoped to sourceB (no accidental sourceA bleed)
    const calls = permSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[3]).toBe(harness.sourceB);
    }
  });

  it('GET without sourceId → uses global getUserPermissionSetAsync, no per-source checks', async () => {
    // No sourceId → getAccessibleChannels falls through to the global path:
    // getUserPermissionSetAsync(userId) merges permissions across all sources
    // (most-permissive wins). checkPermissionAsync is NOT called in this path.
    const res = await request(harness.app).get('/v1/messages');

    expect(res.status).toBe(200);
    expect(globalPermSpy).toHaveBeenCalledWith(harness.limited.id);
    expect(permSpy).not.toHaveBeenCalled();
  });
});
