// @vitest-environment jsdom
// jsdom: the client merge module this imports touches `document` at load.
/**
 * Server age cut for the dashboard bundles (`?ageWindow=settings`).
 *
 * The cut must never change what the Dashboard map draws. These tests build
 * random multi-source bundles, run them through the client's own merge
 * (`mergeUnifiedSourceData`) and the map's age gate, and check that the nodes
 * the map would draw are identical, field for field, with and without the cut.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

import { applyDashboardAgeWindow, DASHBOARD_AGE_GRACE_SEC, type SourceDashboardPayload } from './sourceDashboardData.js';
import { mergeUnifiedSourceData, type UnifiedSourceBundle } from '../../hooks/useDashboardData.js';
import { effectiveMapMaxAgeHours } from '../../utils/mapAge.js';
import { isAgedOutAircraft } from '../../components/map/agedOutAircraft.js';
import { isMeshCoreInfrastructureAdvType } from '../../components/MeshCore/meshcoreRole.js';

const NOW = 1_800_000_000;

/**
 * DashboardMap's `passesAgeGate` plus the ignored filter in front of it, with
 * the slider at its default (follow the setting). Kept in step by hand: if the
 * map gate changes, change this and rowPassesAgeWindow.
 */
function mapShows(n: any, nodeHours: number, infraHours: number, nowSec: number): boolean {
  if (n.isIgnored && !isAgedOutAircraft(n)) return false;
  const ageCutoff = nowSec - effectiveMapMaxAgeHours(null, nodeHours) * 3600;
  const infraCutoff = nowSec - effectiveMapMaxAgeHours(null, infraHours) * 3600;
  if (n.isFavorite) return true;
  if (isAgedOutAircraft(n)) return true;
  if (n.lastHeard == null) return false;
  if (n.isMeshCore && isMeshCoreInfrastructureAdvType(n.advType)) {
    return infraHours <= 0 || n.lastHeard >= infraCutoff;
  }
  return n.lastHeard >= ageCutoff;
}

/** Small seeded PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SOURCES = ['src-a', 'src-b', 'src-c'];

function randomBundles(seed: number): SourceDashboardPayload[] {
  const r = rng(seed);
  const bundles: SourceDashboardPayload[] = SOURCES.map((sourceId) => ({
    sourceId, nodes: [], traceroutes: [], neighborInfo: [], channels: [],
  }));
  // 60 Meshtastic node numbers, each heard by a random subset of sources.
  for (let i = 0; i < 60; i++) {
    const nodeNum = 0x2000 + i;
    for (const b of bundles) {
      if (r() < 0.5) continue;
      const ageHours = r() < 0.5 ? r() * 48 : r() * 2000;
      const row: Record<string, unknown> = {
        nodeNum,
        nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
        sourceId: b.sourceId,
        longName: r() < 0.3 ? `Node !${nodeNum.toString(16).padStart(8, '0')}` : `Name${i}${b.sourceId}`,
        shortName: `N${i}`,
        lastHeard: r() < 0.05 ? null : Math.floor(NOW - ageHours * 3600),
        isFavorite: r() < 0.1,
        isIgnored: r() < 0.1,
      };
      if (r() < 0.7) {
        row.latitude = 30 + r();
        row.longitude = -90 + r();
        row.positionTimestamp = row.lastHeard;
      }
      if (r() < 0.05) row.aircraftAgedOutAt = (NOW - 3600) * 1000;
      b.nodes.push(row);
    }
  }
  // MeshCore contacts: companions and infrastructure, some shared by pubkey.
  for (let i = 0; i < 30; i++) {
    const publicKey = `ab${i.toString(16).padStart(62, '0')}`;
    for (const b of bundles) {
      if (r() < 0.6) continue;
      const ageHours = r() * 1500;
      const nodeId = `mc:${b.sourceId}:${publicKey.substring(0, 12)}`;
      b.nodes.push({
        nodeId, nodeNum: 0, sourceId: b.sourceId, isMeshCore: true, publicKey,
        isIgnored: false, isFavorite: r() < 0.1, longName: `MC${i}`, shortName: `MC${i}`,
        latitude: 31 + r(), longitude: -91 + r(),
        lastHeard: Math.floor(NOW - ageHours * 3600),
        advType: [1, 2, 3, 4][Math.floor(r() * 4)],
      });
    }
  }
  return bundles;
}

function toUnified(bundles: SourceDashboardPayload[]): UnifiedSourceBundle[] {
  return bundles.map((b) => ({
    sourceId: b.sourceId,
    sourceName: b.sourceId,
    protocol: 'Meshtastic',
    nodes: b.nodes,
    traceroutes: b.traceroutes,
    neighborInfo: b.neighborInfo,
    channels: b.channels,
  }));
}

function drawn(bundles: SourceDashboardPayload[], nodeHours: number, infraHours: number, nowSec: number) {
  const { nodes } = mergeUnifiedSourceData(toUnified(bundles));
  return (nodes as any[])
    .filter((n) => mapShows(n, nodeHours, infraHours, nowSec))
    .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
}

function clone(bundles: SourceDashboardPayload[]): SourceDashboardPayload[] {
  return JSON.parse(JSON.stringify(bundles));
}

describe('applyDashboardAgeWindow', () => {
  const windows: Array<[number, number]> = [[36, 720], [24, 0], [0, 720], [1, 1], [720, 24]];

  for (const [nodeHours, infraHours] of windows) {
    it(`unified: the map draws the same nodes with and without the cut (node ${nodeHours}h, infra ${infraHours}h)`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const full = randomBundles(seed);
        const cut = clone(full);
        applyDashboardAgeWindow(cut, { nodeHours, infraHours }, new Set(), NOW);
        // The client renders a little later than the server built the body.
        const clientNow = NOW + 120;
        expect(drawn(cut, nodeHours, infraHours, clientNow)).toEqual(drawn(full, nodeHours, infraHours, clientNow));
      }
    });

    it(`single source: the map draws the same nodes (node ${nodeHours}h, infra ${infraHours}h)`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        for (let i = 0; i < SOURCES.length; i++) {
          const full = [randomBundles(seed)[i]];
          const cut = clone(full);
          applyDashboardAgeWindow(cut, { nodeHours, infraHours }, new Set(), NOW);
          const show = (b: SourceDashboardPayload[]) =>
            (b[0].nodes as any[]).filter((n) => mapShows(n, nodeHours, infraHours, NOW));
          expect(show(cut)).toEqual(show(full));
        }
      }
    });
  }

  it('actually drops old rows, and records the uncut count', () => {
    const full = randomBundles(7);
    const cut = clone(full);
    applyDashboardAgeWindow(cut, { nodeHours: 36, infraHours: 720 }, new Set(), NOW);
    const before = full.reduce((s, b) => s + b.nodes.length, 0);
    const after = cut.reduce((s, b) => s + b.nodes.length, 0);
    expect(after).toBeLessThan(before);
    cut.forEach((b, i) => expect(b.nodeCount).toBe(full[i].nodes.length));
  });

  it('keeps every row of a node that any source heard inside the window', () => {
    const fresh = { nodeNum: 0x3001, nodeId: '!00003001', lastHeard: NOW - 60 };
    const stale = { nodeNum: 0x3001, nodeId: '!00003001', lastHeard: NOW - 900 * 3600, latitude: 30, longitude: -90 };
    const bundles: SourceDashboardPayload[] = [
      { sourceId: 'a', nodes: [fresh], traceroutes: [], neighborInfo: [], channels: [] },
      { sourceId: 'b', nodes: [stale], traceroutes: [], neighborInfo: [], channels: [] },
    ];
    applyDashboardAgeWindow(bundles, { nodeHours: 24, infraHours: 720 }, new Set(), NOW);
    // The stale row carries the only position of a live node.
    expect(bundles[1].nodes).toEqual([stale]);
  });

  it('keeps favourites, aged-out aircraft and local nodes; drops other stale rows', () => {
    const old = NOW - 1000 * 3600;
    const nodes = [
      { nodeNum: 1, lastHeard: old, isFavorite: true },
      { nodeNum: 2, lastHeard: old, isIgnored: true, aircraftAgedOutAt: 1 },
      { nodeNum: 3, lastHeard: old },
      { nodeNum: 4, lastHeard: old },
      { nodeNum: 5, lastHeard: null },
      { nodeNum: 6, lastHeard: NOW - 24 * 3600 - DASHBOARD_AGE_GRACE_SEC + 5 },
    ];
    const bundles: SourceDashboardPayload[] = [{ sourceId: 'a', nodes, traceroutes: [], neighborInfo: [], channels: [] }];
    applyDashboardAgeWindow(bundles, { nodeHours: 24, infraHours: 720 }, new Set([3]), NOW);
    expect(bundles[0].nodes.map((n: any) => n.nodeNum)).toEqual([1, 2, 3, 6]);
    expect(bundles[0].nodeCount).toBe(6);
  });

  it('applies the infra window to MeshCore repeaters and room servers only', () => {
    const at = NOW - 100 * 3600; // older than 24h, inside 720h
    const mc = (advType: number, i: number) => ({ isMeshCore: true, publicKey: `k${i}`, nodeId: `mc:a:k${i}`, nodeNum: 0, advType, lastHeard: at });
    const bundles: SourceDashboardPayload[] = [{ sourceId: 'a', nodes: [mc(1, 1), mc(2, 2), mc(3, 3), mc(4, 4)], traceroutes: [], neighborInfo: [], channels: [] }];
    applyDashboardAgeWindow(bundles, { nodeHours: 24, infraHours: 720 }, new Set(), NOW);
    expect(bundles[0].nodes.map((n: any) => n.advType)).toEqual([2, 3]);
  });

  it('a window of 0 keeps everything', () => {
    const full = randomBundles(3);
    const cut = clone(full);
    applyDashboardAgeWindow(cut, { nodeHours: 0, infraHours: 0 }, new Set(), NOW);
    expect(cut.map((b) => b.nodes)).toEqual(full.map((b) => b.nodes));
  });
});
