/**
 * Source Routes — per-source permission isolation tests
 *
 * Converted from the monkey-patch pattern (vi.mock('../../services/database.js', ...))
 * to the real-middleware harness (createRouteTestApp). The harness uses the live
 * DatabaseService singleton with real session + optionalAuth + requirePermission,
 * seeding per-test permission rows so that `checkPermissionAsync` exercises actual
 * SQL logic rather than a hand-rolled lambda.
 *
 * See src/server/test-helpers/routeTestApp.ts for the design rationale.
 * Template for new and converted route tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// Non-DB mocks stay: sourceRoutes.ts / sourceDashboardData.ts call these at
// request time and they must not attempt real TCP connections in tests.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

// ── describe 1: per-source permission isolation ───────────────────────────────
//
// The limited user holds grants on sourceA only. This exercises the real
// checkPermissionAsync + permissions.sourceId SQL path — previously a hand-rolled
// `(_u,_r,_a,sourceId) => sourceId === 'sourceA'` lambda that could pass while
// the real implementation was broken (issue #3745).

describe('sourceRoutes — per-source permission isolation', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // Grant limited user access on sourceA only.
    // neighbor-info uses the 'nodes' resource, so nodes:read covers both endpoints.
    await harness.grant(harness.limited.id, 'messages',   'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes',      'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    // No grants at all for sourceB.
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  // /channels deliberately excluded from this loop — see MM-SEC-7.
  // After MM-SEC-7 the route uses optionalAuth() + per-row channel_${id}:read,
  // so the "other source denied" case returns 200 with [] rather than 403.
  // Dedicated coverage lives in the dedicated assertion below.
  const endpoints = ['/messages', '/nodes', '/traceroutes', '/neighbor-info'];

  for (const ep of endpoints) {
    it(`GET /rt-source-a${ep} → 200 (allowed source)`, async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${harness.sourceA}${ep}`);
      expect(res.status).toBe(200);
    });

    it(`GET /rt-source-b${ep} → 403 (other source denied — real checkPermissionAsync)`, async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${harness.sourceB}${ep}`);
      expect(res.status).toBe(403);
    });
  }

  it('GET /rt-source-b/channels → 200 with [] (MM-SEC-7: per-channel filter, not source-level 403)', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceB}/channels`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('admin → 200 on both sources without explicit grants (real admin bypass)', async () => {
    const agentA = await harness.loginAs(harness.admin);
    const resA = await agentA.get(`/${harness.sourceA}/messages`);
    expect(resA.status).toBe(200);

    const agentB = await harness.loginAs(harness.admin);
    const resB = await agentB.get(`/${harness.sourceB}/messages`);
    expect(resB.status).toBe(200);
  });

  it('anonymous → 403 on per-source endpoint (real findUserByUsernameAsync path)', async () => {
    // loginAs(null) → no session cookie → optionalAuth falls back to the real
    // anonymous user row. Anonymous has nodes:read with sourceId=null (global),
    // but checkPermissionAsync with a specific sourceId requires an exact-match row,
    // so it returns false → 403.
    const agent = await harness.loginAs(null);
    const res = await agent.get(`/${harness.sourceA}/messages`);
    expect(res.status).toBe(403);
  });
});

// ── describe 2: cross-source channel filtering regression ─────────────────────
//
// The user can access both sources at the source level (nodes:read on A + B),
// but holds channel_0:viewOnMap only for sourceA.
//
// The real filterNodesByChannelPermission calls getUserPermissionSetAsync(userId, sourceId),
// which returns the permission set scoped to that sourceId. Without the channel
// permission for sourceB the node is filtered from the response body even though
// the HTTP status is still 200 — this is the MM-SEC-7 / #3745 regression pattern.

describe('sourceRoutes — cross-source channel filtering (regression)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // Pass the requirePermission('nodes','read') gate for BOTH sources.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);

    // Channel permissions differ by source:
    //   sourceA: channel_0 viewOnMap granted → node visible
    //   sourceB: no channel_0 permission    → node filtered
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    // Seed the same node on BOTH sources. This replicates the regression scenario:
    // a bug could make a node from source A bleed into source B's response.
    // With the real per-source getUserPermissionSetAsync the channel filter is
    // applied independently per source, so the node appears on A but not B.
    const nodeData = {
      nodeNum: 2864434397,
      nodeId: '!aabbccdd',
      longName: 'TestNode',
      shortName: 'TN',
      channel: 0,
      lastHeard: Math.floor(Date.now() / 1000),
    };
    await harness.db.nodes.upsertNode(nodeData, harness.sourceA);
    await harness.db.nodes.upsertNode(nodeData, harness.sourceB);
  });

  afterEach(async () => {
    await harness.cleanup();
    // Note: cleanup() removes permissions and sources but not the seeded node rows.
    // The node rows remain in the in-memory DB (keyed by nodeNum+sourceId). On the
    // next beforeEach, upsertNode() updates them in-place — this is safe because
    // vitest's fork isolation resets the entire process between files.
  });

  it('nodes on channel_0 visible on sourceA (channel_0:viewOnMap granted)', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/nodes`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('nodes on channel_0 filtered on sourceB (no channel grant — regression)', async () => {
    // Real getUserPermissionSetAsync(limitedId, 'rt-source-b') returns {} (no
    // channel_0 row with sourceId='rt-source-b'), so filterNodesByChannelPermission
    // strips the node. Previously the mock made this pass while the real SQL was broken.
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceB}/nodes`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it('admin sees nodes on all sources regardless of channel grants (admin bypass)', async () => {
    // Admin → filterNodesByChannelPermission returns all nodes immediately (user.isAdmin guard).
    const agentA = await harness.loginAs(harness.admin);
    const resA = await agentA.get(`/${harness.sourceA}/nodes`);
    expect(resA.status).toBe(200);
    expect(resA.body.length).toBeGreaterThanOrEqual(1);

    const agentB = await harness.loginAs(harness.admin);
    const resB = await agentB.get(`/${harness.sourceB}/nodes`);
    expect(resB.status).toBe(200);
    expect(resB.body.length).toBeGreaterThanOrEqual(1);
  });
});
