/**
 * Waypoint route tests
 *
 * Converted from the monkey-patch pattern (vi.mock('../../services/database.js'))
 * to the real-middleware harness (createRouteTestApp). The harness uses the live
 * DatabaseService singleton with real session + requirePermission so that
 * checkPermissionAsync exercises actual SQL logic against permissions.sourceId rows.
 *
 * Route profile:
 *   Mounted at /api/sources/:id/waypoints via a parent sourceRouter.
 *   Every endpoint is gated by requirePermission('waypoints', …, { sourceIdFrom: 'params.id' }).
 *   'waypoints' IS a sourcey resource (SOURCEY_RESOURCES in types/permission.ts) so
 *   checkPermissionAsync does an exact-match on permissions.sourceId when a sourceId is
 *   provided by the middleware.
 *
 * Source-isolation assertion:
 *   Limited user receives waypoints:read on harness.sourceA ONLY (canWrite=false on
 *   the same row). GET sourceA → 200. GET/POST sourceB → 403 (real checkPermissionAsync,
 *   no row for sourceB). POST sourceA → 403 (canWrite=false, proves column-level check).
 *
 * Grant strategy note:
 *   The permissions schema has a UNIQUE constraint on (userId, resource, sourceId).
 *   A single grant() call creates one row with canRead XOR canWrite set.  Tests that
 *   need write-success use harness.admin (admin bypass in requirePermission) rather
 *   than stacking two grant() calls that would violate the unique constraint.
 *
 * Non-DB mocks stay: sourceManagerRegistry and waypointService are kept so
 * routes do not attempt real TCP connections or file I/O.
 * databaseService.waypoints.getAsync is spied on per-test for DELETE scenarios
 * since no waypoint rows are seeded in the in-memory test DB.
 *
 * See src/server/test-helpers/routeTestApp.ts for the design rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Router } from 'express';

// Non-DB mocks stay.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(),
  },
}));

vi.mock('../services/waypointService.js', () => ({
  waypointService: {
    list: vi.fn(),
    get: vi.fn(),
    createLocal: vi.fn(),
    update: vi.fn(),
    deleteLocal: vi.fn(),
    expireSweep: vi.fn(),
  },
}));

import databaseService from '../../services/database.js';
import waypointRoutes from './waypoints.js';
import { waypointService } from '../services/waypointService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const mockWaypointService = waypointService as unknown as {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  createLocal: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteLocal: ReturnType<typeof vi.fn>;
};

describe('Waypoint routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      // Match production wiring: parent router with :id, child waypoints router.
      // mergeParams on the waypoints router lets requirePermission read :id.
      mount: (app) => {
        const sourceRouter = Router();
        sourceRouter.use('/:id/waypoints', waypointRoutes);
        app.use('/api/sources', sourceRouter);
      },
    });

    // Grant waypoints:read on sourceA ONLY for the limited user (canWrite stays false
    // in the same row — only one row per (user, resource, sourceId) is allowed by the
    // UNIQUE constraint).  Tests needing write-success use harness.admin instead.
    await harness.grant(harness.limited.id, 'waypoints', 'read', harness.sourceA);
    // No grants for sourceB.

    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  // ── GET /api/sources/:id/waypoints ──────────────────────────────────────────

  describe('GET /api/sources/:id/waypoints', () => {
    it('returns the list for an authorised user (sourceA — real waypoints:read grant)', async () => {
      const sample = [
        { sourceId: harness.sourceA, waypointId: 1, name: 'A', latitude: 30, longitude: -90 },
      ];
      mockWaypointService.list.mockResolvedValue(sample);

      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/waypoints`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: sample });
      expect(mockWaypointService.list).toHaveBeenCalledWith(harness.sourceA, expect.any(Object));
    });

    it('returns 403 when unauthenticated (anonymous user has no waypoints:read — real requirePermission)', async () => {
      // loginAs(null) → no session → requirePermission falls back to the real
      // anonymous user (seeded by DatabaseService.seedInitialData). Anonymous
      // has no waypoints:read grant → checkPermissionAsync returns false → 403.
      // (The old test expected 401 because findUserByUsernameAsync was mocked to
      // return null; with the real anonymous user always present, 403 is correct.)
      const agent = await harness.loginAs(null);
      const res = await agent.get(`/api/sources/${harness.sourceA}/waypoints`);
      expect(res.status).toBe(403);
    });

    it('returns 403 for sourceB (source isolation — no grant row for sourceB, real checkPermissionAsync)', async () => {
      // Limited has waypoints:read only on sourceA. requirePermission extracts
      // the sourceId from params.id, then calls checkPermissionAsync(userId,
      // 'waypoints', 'read', 'rt-source-b') — no matching row → false → 403.
      // Previously a `mockResolvedValue(false)` hid any real implementation bug.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceB}/waypoints`);
      expect(res.status).toBe(403);
    });

    it('returns 200 for sourceA (source isolation — granted)', async () => {
      mockWaypointService.list.mockResolvedValue([]);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/waypoints`);
      expect(res.status).toBe(200);
    });

    it('returns 404 when the source does not exist', async () => {
      // Admin bypasses requirePermission; handler then calls sources.getSource()
      // on the real DB — 'nonexistent-source-xyz' was never created → 404.
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/sources/nonexistent-source-xyz/waypoints');
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/sources/:id/waypoints ─────────────────────────────────────────

  describe('POST /api/sources/:id/waypoints', () => {
    it('creates a waypoint with valid input', async () => {
      // Admin user bypasses requirePermission — no grant setup needed.
      mockWaypointService.createLocal.mockResolvedValue({
        sourceId: harness.sourceA,
        waypointId: 99,
        latitude: 30,
        longitude: -90,
        name: 'Test',
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ lat: 30, lon: -90, name: 'Test', virtual: true });

      expect(res.status).toBe(201);
      expect(res.body.data.waypointId).toBe(99);
      expect(mockWaypointService.createLocal).toHaveBeenCalled();
    });

    it('rejects invalid coordinates with 400', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ lat: 999, lon: -90 });
      expect(res.status).toBe(400);
    });

    it('rejects missing coordinates with 400', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ name: 'no coords' });
      expect(res.status).toBe(400);
    });

    it('returns 403 for read-only limited user on sourceA (canWrite=false — real column-level check)', async () => {
      // Limited user has a waypoints row with canRead=true, canWrite=false on sourceA.
      // requirePermission('waypoints','write',...) calls checkPermissionAsync with action
      // 'write' → looks up canWrite field → false → 403. This proves the real row-level
      // write gate, not just a mock.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ lat: 30, lon: -90 });
      expect(res.status).toBe(403);
    });

    it('returns 403 for limited user on sourceB (source isolation — no grant)', async () => {
      // Limited has no waypoints grant on sourceB at all.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post(`/api/sources/${harness.sourceB}/waypoints`)
        .send({ lat: 30, lon: -90 });
      expect(res.status).toBe(403);
    });

    it('rejects a rebroadcast interval below the 600 s (10-min) airtime floor', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ lat: 30, lon: -90, rebroadcast_interval_s: 300 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least 600 seconds/);
    });

    it('rejects a non-integer rebroadcast interval', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ lat: 30, lon: -90, rebroadcast_interval_s: 700.5 });
      expect(res.status).toBe(400);
    });

    it('accepts a rebroadcast interval at the 10-min floor', async () => {
      mockWaypointService.createLocal.mockResolvedValue({
        sourceId: harness.sourceA, waypointId: 1, latitude: 30, longitude: -90,
      });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/waypoints`)
        .send({ lat: 30, lon: -90, rebroadcast_interval_s: 600 });
      expect(res.status).toBe(201);
    });
  });

  // ── PATCH /api/sources/:id/waypoints/:waypointId ────────────────────────────

  describe('PATCH /api/sources/:id/waypoints/:waypointId', () => {
    it('returns 403 when waypoint is locked to another node', async () => {
      mockWaypointService.update.mockRejectedValue(new Error('waypoint 1 is locked to 999'));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .patch(`/api/sources/${harness.sourceA}/waypoints/1`)
        .send({ name: 'edit' });
      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /api/sources/:id/waypoints/:waypointId ───────────────────────────

  describe('DELETE /api/sources/:id/waypoints/:waypointId', () => {
    it('deletes when waypoint exists', async () => {
      // The DELETE handler calls databaseService.waypoints.getAsync directly
      // before delegating to waypointService.deleteLocal. Spy on the repo method
      // since no waypoint rows are seeded in the in-memory test DB.
      vi.spyOn(databaseService.waypoints, 'getAsync').mockResolvedValue({
        sourceId: harness.sourceA,
        waypointId: 1,
        isVirtual: true,
      } as any);
      mockWaypointService.deleteLocal.mockResolvedValue(true);

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(`/api/sources/${harness.sourceA}/waypoints/1`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when waypoint missing', async () => {
      // Real databaseService.waypoints.getAsync returns null for an unknown
      // waypointId in the empty in-memory DB → handler returns 404.
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(`/api/sources/${harness.sourceA}/waypoints/99999`);
      expect(res.status).toBe(404);
    });
  });
});
