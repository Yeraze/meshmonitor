/**
 * Route tests — GET/POST /automation/pathfinding/filter (#4024)
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md: real
 * express-session + real auth middleware + real checkPermissionAsync against
 * the singleton's `:memory:` SQLite DB. Only the source-manager registry is
 * mocked (non-DB — the router-level guard in meshcoreRoutes.ts requires a
 * registered manager whose `sourceType === 'meshcore'` for every request; we
 * are not exercising device IO here, just persistence/validation).
 *
 * VERIFIED mount prefix: `src/server/server.ts` does
 * `apiRouter.use('/sources/:id/meshcore', meshcoreRoutes)` where `apiRouter`
 * itself is mounted at `/api` (and `${BASE_URL}/api`). The harness doesn't
 * need the `/api` segment — supertest hits the Express app directly — so we
 * mount at `/sources/:id/meshcore`, matching meshcoreRoutes.ts's own
 * `mergeParams: true` router and its `params.id` reads.
 *
 * See docs/internal/dev-notes/PATHFINDING_FILTER_SPEC.md §7.3.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// Non-DB mock: the router-level guard in meshcoreRoutes.ts calls
// sourceManagerRegistry.getManager(sourceId) and 404s unless
// isMeshCoreManager(mgr) (sourceType === 'meshcore') is true. Register a
// minimal stub for the harness's two fixed source ids — no device IO is
// exercised by the filter routes, so the stub needs no other members.
vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({ sourceId, sourceType: 'meshcore' as const });
  const managers = new Map([
    ['rt-source-a', stubFor('rt-source-a')],
    ['rt-source-b', stubFor('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

const FILTER_PATH = '/automation/pathfinding/filter';

describe('meshcoreRoutes — GET/POST /automation/pathfinding/filter', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const urlFor = (sourceId: string) => `/sources/${sourceId}/meshcore${FILTER_PATH}`;

  describe('GET', () => {
    it('returns 403 without automation:read on the source', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(urlFor(harness.sourceA));
      expect(res.status).toBe(403);
    });

    it('returns 200 with default config when granted automation:read', async () => {
      await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(urlFor(harness.sourceA));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        enabled: false,
        targetKeys: [],
        contactsEnabled: false,
        regexEnabled: false,
        nameRegex: '.*',
        lastHeardEnabled: false,
        lastHeardHours: 168,
        hopsEnabled: false,
        hopsMin: 0,
        hopsMax: 10,
        signalEnabled: false,
        rssiMin: -200,
        snrMin: -100,
      });
      // All 13 fields present.
      expect(Object.keys(res.body.data).sort()).toEqual(
        [
          'contactsEnabled', 'enabled', 'hopsEnabled', 'hopsMax', 'hopsMin',
          'lastHeardEnabled', 'lastHeardHours', 'nameRegex', 'regexEnabled',
          'rssiMin', 'signalEnabled', 'snrMin', 'targetKeys',
        ].sort(),
      );
    });

    it('admin bypasses permission checks', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(urlFor(harness.sourceA));
      expect(res.status).toBe(200);
    });
  });

  describe('POST', () => {
    it('returns 403 without automation:write on the source', async () => {
      await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(urlFor(harness.sourceA)).send({ enabled: true, targetKeys: [] });
      expect(res.status).toBe(403);
    });

    it('persists a valid body and echoes it back; GET reflects it', async () => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const body = {
        enabled: true,
        targetKeys: ['deadbeef', 'ABCDEF0123456789'],
        contactsEnabled: true,
        regexEnabled: true,
        nameRegex: '^rep',
        lastHeardEnabled: true,
        lastHeardHours: 24,
        hopsEnabled: true,
        hopsMin: 1,
        hopsMax: 3,
        signalEnabled: true,
        rssiMin: -120,
        snrMin: -10,
      };

      const postRes = await agent.post(urlFor(harness.sourceA)).send(body);
      expect(postRes.status).toBe(200);
      expect(postRes.body.success).toBe(true);
      expect(postRes.body.data).toMatchObject(body);
      // targetKeys normalized as stored (order preserved by insertion).
      expect(postRes.body.data.targetKeys).toEqual(body.targetKeys);

      const getRes = await agent.get(urlFor(harness.sourceA));
      expect(getRes.status).toBe(200);
      expect(getRes.body.data).toMatchObject(body);
    });

    it('rejects an invalid regex with PATHFINDING_FILTER_BAD_REGEX', async () => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post(urlFor(harness.sourceA)).send({
        targetKeys: [],
        regexEnabled: true,
        nameRegex: '(unclosed',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PATHFINDING_FILTER_BAD_REGEX');
    });

    it('rejects an out-of-range hopsMax with PATHFINDING_FILTER_INVALID', async () => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post(urlFor(harness.sourceA)).send({
        targetKeys: [],
        hopsMin: 0,
        hopsMax: 99,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PATHFINDING_FILTER_INVALID');
    });

    it('rejects hopsMax < hopsMin with PATHFINDING_FILTER_INVALID', async () => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post(urlFor(harness.sourceA)).send({
        targetKeys: [],
        hopsMin: 5,
        hopsMax: 2,
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PATHFINDING_FILTER_INVALID');
    });

    it('rejects a non-hex targetKeys entry with PATHFINDING_FILTER_INVALID', async () => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post(urlFor(harness.sourceA)).send({
        targetKeys: ['not-hex!!'],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('PATHFINDING_FILTER_INVALID');
    });

    it.each([
      ['lastHeardHours out of range', { targetKeys: [], lastHeardHours: 99999 }],
      ['rssiMin out of range', { targetKeys: [], rssiMin: 5 }],
      ['snrMin out of range', { targetKeys: [], snrMin: 500 }],
      ['non-boolean enabled', { targetKeys: [], enabled: 'yes' }],
    ])('rejects %s with 400 PATHFINDING_FILTER_INVALID', async (_label, payload) => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post(urlFor(harness.sourceA)).send(payload);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PATHFINDING_FILTER_INVALID');
    });

    it('does not restart the scheduler (no startAutoPathfinding side effect)', async () => {
      // The stub manager in the mocked registry has no startAutoPathfinding
      // method at all — if the handler called it, the request would throw
      // (TypeError: not a function) and surface as a 500. A clean 200
      // confirms the handler never calls it.
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.admin);

      const res = await agent.post(urlFor(harness.sourceA)).send({ targetKeys: [], enabled: true });
      expect(res.status).toBe(200);
    });

    it('per-source isolation: POST to sourceA does not change sourceB', async () => {
      await harness.grant(harness.admin.id, 'automation', 'write', harness.sourceA);
      await harness.grant(harness.admin.id, 'automation', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.admin);

      await agent.post(urlFor(harness.sourceA)).send({
        targetKeys: ['deadbeef'],
        enabled: true,
        lastHeardHours: 48,
      });

      const bRes = await agent.get(urlFor(harness.sourceB));
      expect(bRes.status).toBe(200);
      expect(bRes.body.data.targetKeys).toEqual([]);
      expect(bRes.body.data.enabled).toBe(false);
      expect(bRes.body.data.lastHeardHours).toBe(168);
    });
  });
});
