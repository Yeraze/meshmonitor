/**
 * `?ageWindow=settings` on the dashboard bundles (GET /api/unified/dashboard,
 * GET /api/sources/:id/dashboard), through the real routes and permission
 * tables.
 *
 * With the flag, the bundles leave out nodes older than the widest
 * `maxNodeAgeHours` across every source (plus a grace period), keep
 * favourites, and report the uncut total in `nodeCount`. Without it, the
 * bundles are unchanged (Map Analysis reads them and draws nodes of any age).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const nowSec = Math.floor(Date.now() / 1000);
const HOUR = 3600;

function seedRows(): Array<Record<string, unknown>> {
  return [
    { nodeNum: 0x4001, nodeId: '!00004001', longName: 'Fresh', channel: 0, latitude: 30, longitude: -90, lastHeard: nowSec - 60 },
    { nodeNum: 0x4002, nodeId: '!00004002', longName: 'Inside48h', channel: 0, latitude: 31, longitude: -91, lastHeard: nowSec - 40 * HOUR },
    { nodeNum: 0x4003, nodeId: '!00004003', longName: 'Old', channel: 0, latitude: 32, longitude: -92, lastHeard: nowSec - 100 * HOUR },
    { nodeNum: 0x4004, nodeId: '!00004004', longName: 'OldFavorite', channel: 0, latitude: 33, longitude: -93, lastHeard: nowSec - 100 * HOUR, isFavorite: true },
    // Channel 1: the limited user cannot see it at all.
    { nodeNum: 0x4005, nodeId: '!00004005', longName: 'OtherChan', channel: 1, latitude: 34, longitude: -94, lastHeard: nowSec - 60 },
    { nodeNum: 0x4006, nodeId: '!00004006', longName: 'OldOtherChan', channel: 1, latitude: 35, longitude: -95, lastHeard: nowSec - 100 * HOUR },
  ];
}

const nums = (nodes: any[]) => nodes.map((n) => Number(n.nodeNum)).sort((a, b) => a - b);

describe('dashboard bundles: ageWindow=settings', () => {
  let harness: RouteTestHarness;

  async function setWindows(a: string, b: string) {
    await harness.db.settings.setSourceSetting(harness.sourceA, 'maxNodeAgeHours', a);
    await harness.db.settings.setSourceSetting(harness.sourceB, 'maxNodeAgeHours', b);
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use('/api/unified', unifiedRoutes);
        app.use('/api/sources', sourceRoutes);
      },
    });
    for (const row of seedRows()) {
      await harness.db.nodes.upsertNode(row as any, harness.sourceA);
    }
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    // sourceA 48h, sourceB 12h: the widest (48h) applies to every source.
    await setWindows('48', '12');
  });

  afterEach(async () => {
    await setWindows('', '');
    await harness.db.nodes.deleteAllNodes(harness.sourceA).catch(() => {});
    await harness.cleanup();
  });

  async function fetchBoth(user: SeededUser, query: string) {
    const agent = await harness.loginAs(user);
    const unified = await agent.get(`/api/unified/dashboard?sources=${harness.sourceA}${query ? `&${query}` : ''}`);
    const perSource = await agent.get(`/api/sources/${harness.sourceA}/dashboard${query ? `?${query}` : ''}`);
    expect(unified.status).toBe(200);
    expect(perSource.status).toBe(200);
    return { unified: unified.body[0], perSource: perSource.body };
  }

  it('admin: drops nodes older than the widest window, keeps favourites, reports the uncut count', async () => {
    const plain = await fetchBoth(harness.admin, '');
    const cut = await fetchBoth(harness.admin, 'ageWindow=settings');

    expect(nums(plain.unified.nodes)).toEqual([0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006]);
    expect(plain.unified.nodeCount).toBeUndefined();
    expect(nums(cut.unified.nodes)).toEqual([0x4001, 0x4002, 0x4004, 0x4005]);
    expect(cut.unified.nodeCount).toBe(6);
    expect(cut.perSource.nodes).toEqual(cut.unified.nodes);
    expect(cut.perSource.nodeCount).toBe(6);

    // Kept rows are the same objects the uncut bundle sends.
    const byNum = new Map(plain.unified.nodes.map((n: any) => [n.nodeNum, n]));
    for (const n of cut.unified.nodes) expect(n).toEqual(byNum.get(n.nodeNum));
    // The other datasets are untouched.
    expect(cut.unified.channels).toEqual(plain.unified.channels);
    expect(cut.unified.traceroutes).toEqual(plain.unified.traceroutes);
    expect(cut.unified.neighborInfo).toEqual(plain.unified.neighborInfo);
  });

  it('limited user: channel filter first, then the age cut; count is what the user may see', async () => {
    const plain = await fetchBoth(harness.limited, '');
    const cut = await fetchBoth(harness.limited, 'ageWindow=settings');

    expect(nums(plain.unified.nodes)).toEqual([0x4001, 0x4002, 0x4003, 0x4004]);
    expect(nums(cut.unified.nodes)).toEqual([0x4001, 0x4002, 0x4004]);
    expect(cut.unified.nodeCount).toBe(4);
    expect(cut.perSource.nodes).toEqual(cut.unified.nodes);
    expect(JSON.stringify(cut)).not.toContain('OtherChan');
  });

  it('a source set to 0 (no limit) turns the cut off', async () => {
    await setWindows('48', '0');
    const cut = await fetchBoth(harness.admin, 'ageWindow=settings');
    expect(nums(cut.unified.nodes)).toEqual([0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006]);
  });

  it('never cuts tighter than the default window (the client uses it while settings load)', async () => {
    await setWindows('1', '1');
    const cut = await fetchBoth(harness.admin, 'ageWindow=settings');
    // 24h default + grace: 40h and 100h rows go, the favourite stays.
    expect(nums(cut.unified.nodes)).toEqual([0x4001, 0x4004, 0x4005]);
  });

  it('a user without nodes:read still gets no nodes', async () => {
    await harness.revokeAll(harness.limited.id);
    const cut = await fetchBoth(harness.limited, 'ageWindow=settings');
    expect(cut.unified.nodes).toEqual([]);
    expect(cut.perSource.nodes).toEqual([]);
  });
});
