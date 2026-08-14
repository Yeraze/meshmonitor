/**
 * Reticulum route tests (#3960 Phase 1a WP6)
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md — no
 * vi.mock('../../services/database.js'). Only sourceManagerRegistry is
 * mocked (mirrors every other route test file: it must not attempt a real
 * bridge connection), and isReticulumManager runs for real against the
 * mocked manager's plain `sourceType` field.
 *
 * Route profile:
 *   Mounted at /api/sources/:id/reticulum via a parent sourceRouter
 *   (mergeParams so requirePermission can read :id).
 *   GET /status uses optionalAuth() only (mirrors MeshCore's status
 *   endpoint) — no permission grant required.
 *   Every other endpoint uses requirePermission('nodes', 'read'|'write',
 *   { sourceIdFrom: 'params.id' }).
 *
 * Disconnected-source semantics (build spec §3.7, the key behavioral
 * difference from MeshCore): the guard NEVER 404s on a missing manager.
 * `GET /status` reports connected:false; every read endpoint keeps serving
 * persisted rows regardless of manager presence.
 *
 * **Resource choice (post-review correction).** The build spec originally
 * called for the `'sources'` resource, which is a GLOBAL resource (absent
 * from `SOURCEY_RESOURCES` in `src/types/permission.ts`) — for a global
 * resource, `databaseService.checkPermissionAsync` ignores the resolved
 * `sourceId` for matching, so a grant on one source would have authorized
 * every source, a real per-source access-control gap under CLAUDE.md's
 * "Permissions are per-source" rule. `'nodes'` IS a sourcey resource and is
 * the same one `atakRoutes.ts` uses for its per-source contact/node-list
 * reads — the direct analog to Reticulum's per-source destination list — so
 * these tests grant/deny `nodes:read`/`nodes:write` and assert genuine
 * cross-source 403s (a `nodes:read` grant on sourceA does NOT authorize
 * sourceB), not just data-layer isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Router } from 'express';

// Non-DB mock: sourceManagerRegistry must not attempt a real bridge
// connection. Individual tests configure getManager's return value.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(),
  },
}));

import reticulumRoutes from './reticulumRoutes.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  reticulumInterfaceNodeId,
  reticulumInterfaceNodeNum,
  RETICULUM_IFACE_TX_RATE,
  RETICULUM_IFACE_RX_RATE,
} from '../services/reticulumTelemetry.js';

const mockGetManager = sourceManagerRegistry.getManager as ReturnType<typeof vi.fn>;

/** Minimal stand-in for ReticulumManager — only what the guard/status route touch. */
function fakeConnectedManager(
  sourceId: string,
  versions: { bridgeVersion?: string | null; rnsVersion?: string | null } = {},
) {
  return {
    sourceId,
    sourceType: 'reticulum',
    isConnected: () => true,
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType: 'reticulum', connected: true }),
    getBridgeVersion: () => versions.bridgeVersion ?? null,
    getRnsVersion: () => versions.rnsVersion ?? null,
  };
}

describe('Reticulum routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      // Match production wiring: parent router with :id, child reticulum router.
      mount: (app) => {
        const sourceRouter = Router();
        sourceRouter.use('/:id/reticulum', reticulumRoutes);
        app.use('/api/sources', sourceRouter);
      },
    });

    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    // No grants at all for sourceB — proves per-source isolation.

    mockGetManager.mockReset();
    mockGetManager.mockReturnValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  // ── GET /status ──────────────────────────────────────────────────────────

  describe('GET /:id/reticulum/status', () => {
    it('returns connected:false when no manager is registered (disconnected source)', async () => {
      mockGetManager.mockReturnValue(undefined);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.connected).toBe(false);
      expect(res.body.data.interfaceCount).toBe(0);
      expect(res.body.data.destinationCount).toBe(0);
    });

    it('returns connected:true when a Reticulum manager is registered', async () => {
      mockGetManager.mockReturnValue(fakeConnectedManager(harness.sourceA));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
      expect(res.body.data.connected).toBe(true);
    });

    it('includes rnsVersion/bridgeVersion when the manager has cached them (WP-B)', async () => {
      mockGetManager.mockReturnValue(
        fakeConnectedManager(harness.sourceA, { bridgeVersion: '0.1.0', rnsVersion: '1.4.2' }),
      );
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
      expect(res.body.data.bridgeVersion).toBe('0.1.0');
      expect(res.body.data.rnsVersion).toBe('1.4.2');
    });

    it('reports rnsVersion/bridgeVersion as null when a manager is registered but hasn\'t handshaken yet', async () => {
      mockGetManager.mockReturnValue(fakeConnectedManager(harness.sourceA));
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
      expect(res.body.data.bridgeVersion).toBeNull();
      expect(res.body.data.rnsVersion).toBeNull();
    });

    it('omits rnsVersion/bridgeVersion when no manager is registered (disconnected source)', async () => {
      mockGetManager.mockReturnValue(undefined);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
      expect(res.body.data.bridgeVersion).toBeUndefined();
      expect(res.body.data.rnsVersion).toBeUndefined();
    });

    it('reflects seeded destination/interface counts', async () => {
      await harness.db.reticulum.upsertDestination(harness.sourceA, { destinationHash: 'aa'.repeat(16) });
      await harness.db.reticulum.upsertInterface(harness.sourceA, {
        interfaceName: 'tcp0',
        status: 'up',
        online: true,
        txBytes: 10,
        rxBytes: 20,
      });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
      expect(res.body.data.destinationCount).toBe(1);
      expect(res.body.data.interfaceCount).toBe(1);
    });

    it('does not require a permission grant (optionalAuth only) — anonymous still gets 200', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/status`);
      expect(res.status).toBe(200);
    });
  });

  // ── GET /destinations ────────────────────────────────────────────────────

  describe('GET /:id/reticulum/destinations', () => {
    beforeEach(async () => {
      await harness.db.reticulum.upsertDestination(harness.sourceA, {
        destinationHash: 'a1'.repeat(16),
        displayName: 'Source A dest',
      });
      await harness.db.reticulum.upsertDestination(harness.sourceB, {
        destinationHash: 'b1'.repeat(16),
        displayName: 'Source B dest',
      });
    });

    it('lists the requested source\'s destinations, never the other source\'s (data-layer isolation)', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/destinations`);
      expect(res.status).toBe(200);
      const hashes = res.body.data.map((d: { destinationHash: string }) => d.destinationHash);
      expect(hashes).toContain('a1'.repeat(16));
      expect(hashes).not.toContain('b1'.repeat(16));
    });

    it('403s when the user holds no `nodes:read` grant at all', async () => {
      await harness.revokeAll(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/destinations`);
      expect(res.status).toBe(403);
    });

    it('403s for a source the user has no grant on (real per-source access control — `nodes` is sourcey)', async () => {
      // limited holds nodes:read on sourceA ONLY (outer beforeEach). Unlike
      // the pre-review `'sources'` resource, `'nodes'` IS in SOURCEY_RESOURCES,
      // so checkPermissionAsync does an exact (resource, sourceId) match — a
      // grant on sourceA must NOT authorize sourceB.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/destinations`);
      expect(res.status).toBe(403);
    });

    it('admin sees both sources independently (no cross-source leak)', async () => {
      const agentA = await harness.loginAs(harness.admin);
      const resA = await agentA.get(`/api/sources/${harness.sourceA}/reticulum/destinations`);
      const hashesA = resA.body.data.map((d: { destinationHash: string }) => d.destinationHash);
      expect(hashesA).toContain('a1'.repeat(16));
      expect(hashesA).not.toContain('b1'.repeat(16));

      const agentB = await harness.loginAs(harness.admin);
      const resB = await agentB.get(`/api/sources/${harness.sourceB}/reticulum/destinations`);
      const hashesB = resB.body.data.map((d: { destinationHash: string }) => d.destinationHash);
      expect(hashesB).toContain('b1'.repeat(16));
      expect(hashesB).not.toContain('a1'.repeat(16));
    });

    it('serves persisted rows even with no manager registered (disconnected source)', async () => {
      mockGetManager.mockReturnValue(undefined);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/destinations`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((d: { destinationHash: string }) => d.destinationHash)).toContain('a1'.repeat(16));
    });
  });

  // ── GET /destinations/:hash ──────────────────────────────────────────────

  describe('GET /:id/reticulum/destinations/:hash', () => {
    const hash = 'c3'.repeat(16);

    beforeEach(async () => {
      await harness.db.reticulum.upsertDestination(harness.sourceA, { destinationHash: hash });
    });

    it('returns the destination when it exists', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/destinations/${hash}`);
      expect(res.status).toBe(200);
      expect(res.body.data.destinationHash).toBe(hash);
    });

    it('404s for an unknown hash', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/destinations/${'ff'.repeat(16)}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('DESTINATION_NOT_FOUND');
    });

    it('404s (not leaked) when the hash exists only on the other source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/destinations/${hash}`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /destinations/:hash/favorite ────────────────────────────────────

  describe('POST /:id/reticulum/destinations/:hash/favorite', () => {
    const hash = 'd4'.repeat(16);

    beforeEach(async () => {
      await harness.db.reticulum.upsertDestination(harness.sourceA, { destinationHash: hash });
    });

    it('sets the favorite flag for an authorised write', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/reticulum/destinations/${hash}/favorite`)
        .send({ favorite: true });
      expect(res.status).toBe(200);
      expect(res.body.data.isFavorite).toBe(true);

      const row = await harness.db.reticulum.getDestination(harness.sourceA, hash);
      expect(row?.isFavorite).toBe(true);
    });

    it('403s on read-only grant (write required)', async () => {
      // limited has nodes:read only on sourceA (outer beforeEach) — no write grant.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/reticulum/destinations/${hash}/favorite`)
        .send({ favorite: true });
      expect(res.status).toBe(403);
    });

    it('403s on a write grant for a different source (real per-source access control)', async () => {
      // nodes:write on sourceB does not authorize a write against sourceA.
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/reticulum/destinations/${hash}/favorite`)
        .send({ favorite: true });
      expect(res.status).toBe(403);
    });

    it('400s on a non-boolean body', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/reticulum/destinations/${hash}/favorite`)
        .send({ favorite: 'yes' });
      expect(res.status).toBe(400);
    });

    it('404s for an unknown destination', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/api/sources/${harness.sourceA}/reticulum/destinations/${'ee'.repeat(16)}/favorite`)
        .send({ favorite: true });
      expect(res.status).toBe(404);
    });
  });

  // ── GET /interfaces ──────────────────────────────────────────────────────

  describe('GET /:id/reticulum/interfaces', () => {
    beforeEach(async () => {
      await harness.db.reticulum.upsertInterface(harness.sourceA, {
        interfaceName: 'tcp-a',
        status: 'up',
        online: true,
        txBytes: 100,
        rxBytes: 200,
      });
      await harness.db.reticulum.upsertInterface(harness.sourceB, {
        interfaceName: 'tcp-b',
        status: 'up',
        online: true,
        txBytes: 1,
        rxBytes: 2,
      });
    });

    it('lists the requested source\'s interfaces, never the other source\'s (data-layer isolation)', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/interfaces`);
      expect(res.status).toBe(200);
      const names = res.body.data.map((i: { interfaceName: string }) => i.interfaceName);
      expect(names).toContain('tcp-a');
      expect(names).not.toContain('tcp-b');
    });

    it('403s for a source the user has no grant on (real per-source access control)', async () => {
      // limited holds nodes:read on sourceA ONLY — nodes is sourcey, so this
      // must be denied for sourceB rather than falling back to any grant.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/interfaces`);
      expect(res.status).toBe(403);
    });

    it('403s when the user holds no `nodes:read` grant at all', async () => {
      await harness.revokeAll(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/interfaces`);
      expect(res.status).toBe(403);
    });
  });

  // ── GET /interfaces/:name/history ────────────────────────────────────────

  describe('GET /:id/reticulum/interfaces/:name/history', () => {
    const ifaceName = 'tcp-hist';

    beforeEach(async () => {
      await harness.db.reticulum.upsertInterface(harness.sourceA, {
        interfaceName: ifaceName,
        status: 'up',
        online: true,
        txBytes: 100,
        rxBytes: 200,
      });

      const nodeId = reticulumInterfaceNodeId(ifaceName);
      const nodeNum = reticulumInterfaceNodeNum(ifaceName);
      const now = Date.now();
      await harness.db.telemetry.insertTelemetryBatch(
        [
          { nodeId, nodeNum, telemetryType: RETICULUM_IFACE_TX_RATE, timestamp: now - 1000, value: 42, unit: 'B/s', createdAt: now },
          { nodeId, nodeNum, telemetryType: RETICULUM_IFACE_RX_RATE, timestamp: now - 500, value: 84, unit: 'B/s', createdAt: now },
        ],
        harness.sourceA,
      );
    });

    it('returns throughput samples for a known interface', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/interfaces/${ifaceName}/history`);
      expect(res.status).toBe(200);
      expect(res.body.data.interfaceName).toBe(ifaceName);
      expect(res.body.data.samples.length).toBe(2);
      const types = res.body.data.samples.map((s: { telemetryType: string }) => s.telemetryType).sort();
      expect(types).toEqual([RETICULUM_IFACE_RX_RATE, RETICULUM_IFACE_TX_RATE]);
    });

    it('404s for an unknown interface name', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/interfaces/does-not-exist/history`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INTERFACE_NOT_FOUND');
    });

    it('404s (not leaked) when the interface exists only on the other source (admin, real data-layer check)', async () => {
      // Admin bypasses requirePermission, so this exercises the DB query
      // itself: the interface was only upserted under sourceA, so sourceB's
      // scoped getInterface() lookup finds nothing.
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/interfaces/${ifaceName}/history`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INTERFACE_NOT_FOUND');
    });

    it('403s for a source the user has no grant on (real per-source access control)', async () => {
      // limited holds nodes:read on sourceA ONLY — denied for sourceB before
      // the handler (and thus the DB) is ever reached.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/interfaces/${ifaceName}/history`);
      expect(res.status).toBe(403);
    });

    it('403s when the user holds no `nodes:read` grant at all', async () => {
      await harness.revokeAll(harness.limited.id);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/interfaces/${ifaceName}/history`);
      expect(res.status).toBe(403);
    });
  });
});
