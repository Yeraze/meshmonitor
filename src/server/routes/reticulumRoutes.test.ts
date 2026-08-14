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

  // ── Messages/propagation/identity (#3960 Phase 2 WP4) ───────────────────
  //
  // Resource: 'messages' (sourcey), distinct from the 'nodes' resource used
  // by the Phase 1a routes above — these tests seed their own messages:read
  // / messages:write grants rather than reusing the outer beforeEach's
  // nodes:read grant, and assert real per-source 403s the same way.

  /** Minimal stand-in for ReticulumManager covering only what WP4's routes touch. */
  function fakeMessageManager(overrides: Partial<{
    ownAddress: string | null;
    sendMessage: ReturnType<typeof vi.fn>;
    syncPropagation: ReturnType<typeof vi.fn>;
    setPropagationNode: ReturnType<typeof vi.fn>;
    setDisplayName: ReturnType<typeof vi.fn>;
    getIdentity: ReturnType<typeof vi.fn>;
  }> = {}) {
    return {
      sourceType: 'reticulum',
      isConnected: () => true,
      getOwnAddresses: () => (overrides.ownAddress ? [overrides.ownAddress] : []),
      sendMessage: overrides.sendMessage ?? vi.fn(),
      syncPropagation: overrides.syncPropagation ?? vi.fn().mockResolvedValue(undefined),
      setPropagationNode: overrides.setPropagationNode ?? vi.fn().mockResolvedValue(undefined),
      setDisplayName: overrides.setDisplayName ?? vi.fn().mockResolvedValue(undefined),
      getIdentity:
        overrides.getIdentity ?? vi.fn().mockResolvedValue({ destinationHash: 'aa'.repeat(16), displayName: 'Alice' }),
    };
  }

  describe('LXMF messages/propagation/identity', () => {
    beforeEach(async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      // No messages:write grant, and no grant at all on sourceB — proves
      // read/write enforcement and per-source isolation below.
    });

    // ── GET /messages ──────────────────────────────────────────────────

    describe('GET /:id/reticulum/messages', () => {
      beforeEach(async () => {
        await harness.db.reticulum.upsertMessage(harness.sourceA, {
          id: `${harness.sourceA}_msg-a1`,
          fromHash: 'aa'.repeat(16),
          toHash: 'bb'.repeat(16),
          content: 'hi from A',
          timestamp: Date.now(),
          // 'sent' is an outbound-flavored state (OUTBOUND_MESSAGE_STATES in
          // reticulum.ts) — with no selfHash available (no manager
          // registered in this describe), listConversations infers the peer
          // as toHash for outbound-flavored rows, so the peer is 'bb'*16.
          state: 'sent',
        });
        await harness.db.reticulum.upsertMessage(harness.sourceB, {
          id: `${harness.sourceB}_msg-b1`,
          fromHash: 'cc'.repeat(16),
          toHash: 'dd'.repeat(16),
          content: 'hi from B',
          timestamp: Date.now(),
          state: 'delivered',
        });
      });

      it('lists conversations for the requested source only (data-layer isolation)', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/messages`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const peers = res.body.data.map((c: { peerHash: string }) => c.peerHash);
        expect(peers).toContain('bb'.repeat(16));
        expect(peers).not.toContain('dd'.repeat(16));
      });

      it('serves persisted conversations even with no manager registered', async () => {
        mockGetManager.mockReturnValue(undefined);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/messages`);
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
      });

      it('403s when the user holds no `messages:read` grant at all', async () => {
        await harness.revokeAll(harness.limited.id);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/messages`);
        expect(res.status).toBe(403);
      });

      it('403s for a source the user has no `messages:read` grant on (cross-source)', async () => {
        // limited holds messages:read on sourceA ONLY.
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/messages`);
        expect(res.status).toBe(403);
      });
    });

    // ── GET /messages/:peerHash ───────────────────────────────────────────

    describe('GET /:id/reticulum/messages/:peerHash', () => {
      const peerHash = 'ee'.repeat(16);

      beforeEach(async () => {
        await harness.db.reticulum.upsertMessage(harness.sourceA, {
          id: `${harness.sourceA}_msg-peer1`,
          fromHash: 'aa'.repeat(16),
          toHash: peerHash,
          content: 'hello peer',
          timestamp: Date.now(),
          state: 'delivered',
        });
      });

      it('returns the conversation for an authorised read', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/messages/${peerHash}`);
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].toHash).toBe(peerHash);
      });

      it('403s for a source the user has no grant on (cross-source)', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/messages/${peerHash}`);
        expect(res.status).toBe(403);
      });
    });

    // ── GET /threads/:threadHash ──────────────────────────────────────────

    describe('GET /:id/reticulum/threads/:threadHash', () => {
      it('403s for a source the user has no grant on (cross-source)', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/threads/${'ff'.repeat(16)}`);
        expect(res.status).toBe(403);
      });

      it('200s with an empty array for an authorised read of an unknown thread', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/threads/${'ff'.repeat(16)}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
      });
    });

    // ── POST /messages ────────────────────────────────────────────────────

    describe('POST /:id/reticulum/messages', () => {
      beforeEach(async () => {
        // Outer describe already granted messages:read on sourceA; revoke
        // first since (user, resource, sourceId) is unique — write tests
        // need write only.
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
      });

      it('sends via manager.sendMessage with the right args and returns the created row', async () => {
        const createdRow = {
          id: `${harness.sourceA}_abc123`,
          sourceId: harness.sourceA,
          fromHash: 'aa'.repeat(16),
          toHash: 'bb'.repeat(16),
          title: null,
          content: 'hello',
          timestamp: Date.now(),
          state: 'sent',
        };
        const sendMessage = vi.fn().mockResolvedValue(createdRow);
        mockGetManager.mockReturnValue(fakeMessageManager({ sendMessage }));

        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .post(`/api/sources/${harness.sourceA}/reticulum/messages`)
          .send({ to: 'bb'.repeat(16), content: 'hello', title: 'Hi', method: 'direct', replyToHash: 'cc'.repeat(16) });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(createdRow);
        expect(sendMessage).toHaveBeenCalledWith({
          to: 'bb'.repeat(16),
          content: 'hello',
          title: 'Hi',
          fields: undefined,
          method: 'direct',
          replyToHash: 'cc'.repeat(16),
        });
      });

      it('409s with SOURCE_NOT_CONNECTED when no manager is registered', async () => {
        mockGetManager.mockReturnValue(undefined);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .post(`/api/sources/${harness.sourceA}/reticulum/messages`)
          .send({ to: 'bb'.repeat(16), content: 'hello' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      });

      it('400s on a missing `to`', async () => {
        mockGetManager.mockReturnValue(fakeMessageManager());
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .post(`/api/sources/${harness.sourceA}/reticulum/messages`)
          .send({ content: 'hello' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_TO');
      });

      it('400s on an invalid `method`', async () => {
        mockGetManager.mockReturnValue(fakeMessageManager());
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .post(`/api/sources/${harness.sourceA}/reticulum/messages`)
          .send({ to: 'bb'.repeat(16), content: 'hello', method: 'carrier-pigeon' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_METHOD');
      });

      it('403s on a read-only grant (write required)', async () => {
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .post(`/api/sources/${harness.sourceA}/reticulum/messages`)
          .send({ to: 'bb'.repeat(16), content: 'hello' });
        expect(res.status).toBe(403);
      });

      it('403s for a source the user has no write grant on (cross-source)', async () => {
        // limited holds messages:write on sourceA ONLY.
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .post(`/api/sources/${harness.sourceB}/reticulum/messages`)
          .send({ to: 'bb'.repeat(16), content: 'hello' });
        expect(res.status).toBe(403);
      });
    });

    // ── POST /propagation/sync ────────────────────────────────────────────

    describe('POST /:id/reticulum/propagation/sync', () => {
      beforeEach(async () => {
        // Outer describe already granted messages:read on sourceA; revoke
        // first since (user, resource, sourceId) is unique — write tests
        // need write only.
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
      });

      it('calls manager.syncPropagation and returns ok', async () => {
        const syncPropagation = vi.fn().mockResolvedValue(undefined);
        mockGetManager.mockReturnValue(fakeMessageManager({ syncPropagation }));
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.post(`/api/sources/${harness.sourceA}/reticulum/propagation/sync`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(syncPropagation).toHaveBeenCalledTimes(1);
      });

      it('409s with SOURCE_NOT_CONNECTED when no manager is registered', async () => {
        mockGetManager.mockReturnValue(undefined);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.post(`/api/sources/${harness.sourceA}/reticulum/propagation/sync`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      });

      it('403s on a read-only grant (write required)', async () => {
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.post(`/api/sources/${harness.sourceA}/reticulum/propagation/sync`);
        expect(res.status).toBe(403);
      });
    });

    // ── PUT /propagation/node ─────────────────────────────────────────────

    describe('PUT /:id/reticulum/propagation/node', () => {
      beforeEach(async () => {
        // Outer describe already granted messages:read on sourceA; revoke
        // first since (user, resource, sourceId) is unique — write tests
        // need write only.
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
      });

      it('calls manager.setPropagationNode with the given destHash', async () => {
        const setPropagationNode = vi.fn().mockResolvedValue(undefined);
        mockGetManager.mockReturnValue(fakeMessageManager({ setPropagationNode }));
        const agent = await harness.loginAs(harness.limited);
        const destHash = 'ab'.repeat(16);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/propagation/node`)
          .send({ destHash });
        expect(res.status).toBe(200);
        expect(setPropagationNode).toHaveBeenCalledWith(destHash);
      });

      it('400s when destHash is null (clearing is unsupported)', async () => {
        mockGetManager.mockReturnValue(fakeMessageManager());
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/propagation/node`)
          .send({ destHash: null });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PROPAGATION_NODE_CLEAR_UNSUPPORTED');
      });

      it('409s with SOURCE_NOT_CONNECTED when no manager is registered', async () => {
        mockGetManager.mockReturnValue(undefined);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/propagation/node`)
          .send({ destHash: 'ab'.repeat(16) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      });
    });

    // ── GET /identity ──────────────────────────────────────────────────────

    describe('GET /:id/reticulum/identity', () => {
      it('returns only destinationHash + displayName — never a private key', async () => {
        const identity = { destinationHash: 'aa'.repeat(16), displayName: 'Alice' };
        mockGetManager.mockReturnValue(fakeMessageManager({ getIdentity: vi.fn().mockResolvedValue(identity) }));
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/identity`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(identity);
        expect(Object.keys(res.body.data).sort()).toEqual(['destinationHash', 'displayName']);
        const serialized = JSON.stringify(res.body);
        expect(serialized.toLowerCase()).not.toContain('privatekey');
        expect(serialized.toLowerCase()).not.toContain('identityhash');
      });

      it('degrades gracefully (nulls) rather than erroring when no manager is registered', async () => {
        mockGetManager.mockReturnValue(undefined);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceA}/reticulum/identity`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ destinationHash: null, displayName: null });
      });

      it('403s for a source the user has no `messages:read` grant on (cross-source)', async () => {
        const agent = await harness.loginAs(harness.limited);
        const res = await agent.get(`/api/sources/${harness.sourceB}/reticulum/identity`);
        expect(res.status).toBe(403);
      });
    });

    // ── PUT /display-name ─────────────────────────────────────────────────

    describe('PUT /:id/reticulum/display-name', () => {
      beforeEach(async () => {
        // Outer describe already granted messages:read on sourceA; revoke
        // first since (user, resource, sourceId) is unique — write tests
        // need write only.
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
      });

      it('calls manager.setDisplayName with the given name', async () => {
        const setDisplayName = vi.fn().mockResolvedValue(undefined);
        mockGetManager.mockReturnValue(fakeMessageManager({ setDisplayName }));
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/display-name`)
          .send({ name: 'New Name' });
        expect(res.status).toBe(200);
        expect(setDisplayName).toHaveBeenCalledWith('New Name');
      });

      it('400s on an empty name', async () => {
        mockGetManager.mockReturnValue(fakeMessageManager());
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/display-name`)
          .send({ name: '' });
        expect(res.status).toBe(400);
      });

      it('409s with SOURCE_NOT_CONNECTED when no manager is registered', async () => {
        mockGetManager.mockReturnValue(undefined);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/display-name`)
          .send({ name: 'New Name' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      });

      it('403s on a read-only grant (write required)', async () => {
        await harness.revokeAll(harness.limited.id);
        await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await agent
          .put(`/api/sources/${harness.sourceA}/reticulum/display-name`)
          .send({ name: 'New Name' });
        expect(res.status).toBe(403);
      });
    });
  });
});
