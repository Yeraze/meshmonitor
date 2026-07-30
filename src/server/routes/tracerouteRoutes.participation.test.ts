/**
 * GET /api/traceroutes/participation/:nodeNum — route tests (phase 2 §8.4).
 *
 * Uses createRouteTestApp() (CLAUDE.md) rather than the legacy whole-module
 * vi.mock pattern the existing tracerouteRoutes.test.ts uses — that file is
 * NOT converted in this phase. See src/server/test-helpers/routeTestApp.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { DbTraceroute } from '../../db/types.js';

async function seedTraceroute(
  harness: RouteTestHarness,
  sourceId: string,
  overrides: Partial<DbTraceroute> & { fromNodeNum: number; toNodeNum: number },
) {
  const now = Date.now();
  const row: DbTraceroute = {
    fromNodeNum: overrides.fromNodeNum,
    toNodeNum: overrides.toNodeNum,
    fromNodeId: overrides.fromNodeId ?? `!${overrides.fromNodeNum.toString(16)}`,
    toNodeId: overrides.toNodeId ?? `!${overrides.toNodeNum.toString(16)}`,
    route: overrides.route ?? null,
    routeBack: overrides.routeBack ?? null,
    snrTowards: overrides.snrTowards ?? null,
    snrBack: overrides.snrBack ?? null,
    channel: overrides.channel,
    packetId: overrides.packetId,
    timestamp: overrides.timestamp ?? now,
    createdAt: overrides.createdAt ?? now,
  };
  await harness.db.traceroutes.insertTraceroute(row, sourceId);
}

describe('GET /api/traceroutes/participation/:nodeNum', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/', tracerouteRoutes) });
  });

  afterEach(async () => {
    // The harness's :memory: singleton persists for the whole file (vitest
    // fork isolation = one process per file); harness.cleanup() only removes
    // permissions/sources, not data rows. Without this, traceroute rows
    // seeded by an earlier test (same fixed sourceA/sourceB ids) leak into a
    // later test's participation query for the same nodeNum.
    await harness.db.traceroutes.deleteAllTraceroutes();
    await harness.cleanup();
  });

  it('200 + entries for a user granted traceroute:read on the requested source', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222 });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].participation).toBe('endpoint');
  });

  it('403 when the user is granted traceroute:read only on a different source', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceB);
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222 });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(403);
  });

  it('403 for an ungranted/anonymous agent', async () => {
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222 });

    const agent = await harness.loginAs(null);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(403);
  });

  it('400 MISSING_SOURCE_ID when sourceId is omitted', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
  });

  it('400 INVALID_NODE_NUM for a non-numeric nodeNum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/abc').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NODE_NUM');
  });

  it('400 INVALID_NODE_NUM for a nodeNum above the uint32 range', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/4294967296').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NODE_NUM');
  });

  it('400 INVALID_LIMIT below the minimum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA, limit: '0' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LIMIT');
  });

  it('400 INVALID_LIMIT above the maximum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA, limit: '201' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LIMIT');
  });

  it('hours omitted: no time window — a traceroute far older than 7 days still appears (History-dialog parity amendment)', async () => {
    const veryOld = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222, timestamp: veryOld });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].timestamp).toBe(veryOld);
  });

  it('hours explicitly provided still windows out an old row', async () => {
    const veryOld = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222, timestamp: veryOld });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA, hours: '168' });

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it('400 INVALID_HOURS below the minimum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA, hours: '0' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_HOURS');
  });

  it('400 INVALID_HOURS above the maximum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA, hours: '2161' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_HOURS');
  });

  it('rows seeded on sourceB never appear in a sourceA query (endpoint-level isolation)', async () => {
    await seedTraceroute(harness, harness.sourceB, { fromNodeNum: 111, toNodeNum: 222 });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it('returns hop-only participation (node inside route but not an endpoint)', async () => {
    await seedTraceroute(harness, harness.sourceA, {
      fromNodeNum: 500,
      toNodeNum: 600,
      route: '[111,777]',
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].participation).toBe('hop');
  });

  it('routePositions is absent from every entry', async () => {
    await seedTraceroute(harness, harness.sourceA, {
      fromNodeNum: 111,
      toNodeNum: 222,
      routePositions: JSON.stringify({ 111: { lat: 1, lng: 2 } }),
    } as Partial<DbTraceroute> & { fromNodeNum: number; toNodeNum: number });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    expect(res.body.data.entries[0]).not.toHaveProperty('routePositions');
  });

  it('hopCount is null for a null/unparseable route, and the hop-array length otherwise', async () => {
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222, packetId: 1, route: null });
    await seedTraceroute(harness, harness.sourceA, {
      fromNodeNum: 333,
      toNodeNum: 444,
      packetId: 2,
      route: '[111]',
    });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/participation/111').query({ sourceId: harness.sourceA });

    expect(res.status).toBe(200);
    const nullRouteEntry = res.body.data.entries.find((e: any) => e.route === null);
    const hopRouteEntry = res.body.data.entries.find((e: any) => e.route === '[111]');
    expect(nullRouteEntry.hopCount).toBeNull();
    expect(hopRouteEntry.hopCount).toBe(1);
  });

  it('channel masking: a channel:0 row is dropped without channel_0:viewOnMap, visible for admin', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await seedTraceroute(harness, harness.sourceA, { fromNodeNum: 111, toNodeNum: 222, channel: 0 });

    const limitedAgent = await harness.loginAs(harness.limited);
    const limitedRes = await limitedAgent.get('/participation/111').query({ sourceId: harness.sourceA });
    expect(limitedRes.status).toBe(200);
    expect(limitedRes.body.data.entries).toHaveLength(0);

    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const limitedRes2 = await limitedAgent.get('/participation/111').query({ sourceId: harness.sourceA });
    expect(limitedRes2.body.data.entries).toHaveLength(1);

    const adminAgent = await harness.loginAs(harness.admin);
    const adminRes = await adminAgent.get('/participation/111').query({ sourceId: harness.sourceA });
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.data.entries).toHaveLength(1);
  });
});
