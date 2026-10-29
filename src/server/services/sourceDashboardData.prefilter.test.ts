/**
 * The dashboard age cut in SQL (`nodePrefilter`) must not change what the
 * dashboard bundles send.
 *
 * `?ageWindow=settings` first read every node row and then dropped the ones
 * applyDashboardAgeWindow rejects (#6032). With `nodePrefilter` the node read
 * skips rows of nodes with no live row in any listed source, and the same
 * in-memory pass runs after it. This checks, against a real SQLite database
 * and the real permission tables, that both give byte-identical bundles
 * (including `nodeCount`) for random multi-source data, for an admin and a
 * channel-limited user, across windows and local nodes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

type LocalInfo = { nodeNum: number; nodeId: string; longName: string; shortName: string };
let currentLocal: LocalInfo | null = null;

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((id: string) =>
      id === 'rt-source-a' && currentLocal ? { getLocalNodeInfo: () => currentLocal } : null),
    getAllManagers: vi.fn().mockReturnValue([]),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const {
  buildSourceDashboard,
  applyDashboardAgeWindow,
  dashboardNodePrefilter,
} = await import('./sourceDashboardData.js');

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3600;

describe('dashboard nodePrefilter: same bundles as the in-memory cut alone', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ useOptionalAuth: false, mount: () => {} });
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_1', 'viewOnMap', harness.sourceB);
  });

  afterEach(async () => {
    vi.useRealTimers();
    currentLocal = null;
    for (const s of [harness.sourceA, harness.sourceB]) {
      await harness.db.nodes.deleteAllNodes(s).catch(() => {});
    }
    await harness.cleanup();
  });

  async function seed(seedNum: number, nowSec: number) {
    const r = rng(seedNum);
    const ages = [60, 20 * HOUR, 40 * HOUR, 49 * HOUR, 60 * HOUR, 200 * HOUR, 2000 * HOUR, null];
    for (const s of [harness.sourceA, harness.sourceB]) {
      await harness.db.nodes.deleteAllNodes(s).catch(() => {});
    }
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (let num = 1; num <= 50; num++) {
        if (r() < 0.4) continue;
        const age = ages[Math.floor(r() * ages.length)];
        const row: Record<string, unknown> = {
          nodeNum: num,
          nodeId: `!${num.toString(16).padStart(8, '0')}`,
          longName: `N${num}-${sourceId.slice(-1)}`,
          shortName: `N${num}`,
          channel: Math.floor(r() * 3),
          isFavorite: r() < 0.1,
        };
        if (age !== null) row.lastHeard = nowSec - age;
        if (r() < 0.6) {
          row.latitude = 30 + r();
          row.longitude = -90 - r();
        }
        await harness.db.nodes.upsertNode(row as any, sourceId);
        if (r() < 0.05) await harness.db.nodes.markAircraftAgedOut(num, sourceId, nowSec * 1000);
      }
    }
    // Local node of source A: sometimes a stored row, sometimes not stored yet
    // (the builder synthesizes one), sometimes none.
    const pick = r();
    const localNum = pick < 0.4 ? 1 + Math.floor(r() * 50) : pick < 0.7 ? 999 : 0;
    currentLocal = localNum
      ? { nodeNum: localNum, nodeId: `!${localNum.toString(16).padStart(8, '0')}`, longName: 'Local', shortName: 'LOC' }
      : null;
    return new Set<number>(localNum ? [localNum] : []);
  }

  const windows = [
    { nodeHours: 48, infraHours: 720 },
    { nodeHours: 24, infraHours: 720 },
    { nodeHours: 1, infraHours: 1 },
    { nodeHours: 0, infraHours: 720 },
    { nodeHours: 0, infraHours: 0 },
  ];

  for (const seedNum of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seedNum}: unified and single-source bundles match for admin and limited user`, async () => {
      // A local node not stored yet is synthesized with lastHeard = Date.now()
      // at build time; pin the clock so the two builds stamp the same second.
      vi.useFakeTimers({ toFake: ['Date'] });
      const nowSec = Math.floor(Date.now() / 1000);
      const keep = await seed(seedNum, nowSec);
      const sources = (await harness.db.sources.getAllSources())
        .filter((s) => s.id === harness.sourceA || s.id === harness.sourceB);
      expect(sources).toHaveLength(2);

      for (const user of [harness.admin, harness.limited]) {
        for (const window of windows) {
          const sets = [sources, [sources[0]], [sources[1]]];
          for (const set of sets) {
            const ids = set.map((s) => s.id);
            const plain = await Promise.all(set.map((s) => buildSourceDashboard(s as any, user as any)));
            applyDashboardAgeWindow(plain, window, keep, nowSec);

            const listed = await dashboardNodePrefilter(ids, window, keep, nowSec);
            // Both read forms: the bound list, and the subquery used past
            // DASHBOARD_LIVE_NODE_LIST_MAX.
            const subquery = listed ? { ...listed, nodeNums: undefined } : undefined;
            for (const prefilter of [listed, subquery]) {
              const fast = await Promise.all(
                set.map((s) => buildSourceDashboard(s as any, user as any, { nodePrefilter: prefilter })),
              );
              applyDashboardAgeWindow(fast, window, keep, nowSec);
              expect(JSON.stringify(fast)).toBe(JSON.stringify(plain));
            }
          }
        }
      }
    });
  }

  it('the prefilter reads fewer rows and still reports the uncut count', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (let num = 1; num <= 10; num++) {
      await harness.db.nodes.upsertNode({
        nodeNum: num, nodeId: `!0000000${num.toString(16)}`, longName: `N${num}`, shortName: `N${num}`,
        channel: num % 2, lastHeard: nowSec - (num <= 3 ? 60 : 500 * HOUR),
      } as any, harness.sourceA);
    }
    const [source] = (await harness.db.sources.getAllSources()).filter((s) => s.id === harness.sourceA);
    const window = { nodeHours: 24, infraHours: 720 };
    const prefilter = await dashboardNodePrefilter([source.id], window, new Set(), nowSec);
    expect(prefilter?.nodeNums?.sort()).toEqual([1, 2, 3]);

    const admin = await buildSourceDashboard(source as any, harness.admin as any, { nodePrefilter: prefilter });
    expect(admin.nodes.map((n: any) => n.nodeNum).sort()).toEqual([1, 2, 3]);
    expect(admin.nodeCount).toBe(10);

    // The limited user may see channel 0 only on source A: 5 rows, 1 live.
    const limited = await buildSourceDashboard(source as any, harness.limited as any, { nodePrefilter: prefilter });
    expect(limited.nodes.map((n: any) => n.nodeNum)).toEqual([2]);
    expect(limited.nodeCount).toBe(5);

    // Without a prefilter the bundle has no nodeCount (unchanged shape).
    const plain = await buildSourceDashboard(source as any, harness.admin as any);
    expect(plain.nodeCount).toBeUndefined();
    expect('nodeCount' in plain).toBe(false);
  });

  it('no prefilter when the node window is off', async () => {
    expect(await dashboardNodePrefilter(['a'], { nodeHours: 0, infraHours: 720 }, new Set())).toBeUndefined();
    expect(await dashboardNodePrefilter([], { nodeHours: 24, infraHours: 720 }, new Set())).toBeUndefined();
    const p = await dashboardNodePrefilter(['a'], { nodeHours: 24, infraHours: 720 }, new Set([7]), 1_000_000.5);
    expect(p).toEqual({ sourceIds: ['a'], minLastHeard: 1_000_000 - 24 * HOUR - 3600, keepNodeNums: [7], nodeNums: [] });
  });
});
