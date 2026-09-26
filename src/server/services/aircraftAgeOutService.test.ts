/**
 * Unit tests for the aircraft age-out sweep and live-position lift
 * (#5364/#5365 Phase 2). Every dependency is injected; no DB, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AircraftAgeOutService,
  pairPositionRows,
  type AircraftAgeOutDeps,
} from './aircraftAgeOutService.js';
import type { AircraftAgeOutCandidate } from '../../db/repositories/nodes.js';

const SRC = 'src-a';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const M = 1 / 111_320; // ~1 m of latitude

function cand(nodeNum: number, o: Partial<AircraftAgeOutCandidate> = {}): AircraftAgeOutCandidate {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    lastHeard: Math.floor((NOW - 48 * HOUR) / 1000),
    isFavorite: false,
    isIgnored: false,
    aircraftAgedOutAt: null,
    positionOverrideEnabled: false,
    latitudeOverride: null,
    longitudeOverride: null,
    altitudeOverride: null,
    latitude: 40,
    longitude: -105,
    altitude: 9000,
    ...o,
  };
}

function makeDeps(opts: {
  settings?: Record<string, string>;
  candidates?: AircraftAgeOutCandidate[];
  fixes?: Record<string, Array<{ lat: number; lon: number }>>;
  localNodeNum?: number | null;
  sourceType?: string;
  ignored?: Set<number>;
  agedOut?: Map<number, number>;
  liftResult?: boolean;
} = {}) {
  const settings = new Map(Object.entries(opts.settings ?? {}));
  const written = new Map<string, string>();
  const deps: AircraftAgeOutDeps = {
    getSourceSetting: vi.fn(async (_s: string, k: string) => settings.get(k) ?? null),
    setSourceSetting: vi.fn(async (_s: string, k: string, v: string) => { written.set(k, v); }),
    getSourceType: vi.fn(async () => opts.sourceType ?? 'meshtastic_tcp'),
    getLocalNodeNum: vi.fn(async () => opts.localNodeNum ?? null),
    listCandidates: vi.fn(async () => opts.candidates ?? []),
    getPositionFixes: vi.fn(async (nodeId: string) => opts.fixes?.[nodeId] ?? []),
    setFixed: vi.fn(async () => undefined),
    addAircraftIgnore: vi.fn(async () => true),
    markAgedOut: vi.fn(async () => undefined),
    deleteNode: vi.fn(async () => undefined),
    getAgedOutAt: vi.fn(async (n: number) => opts.agedOut?.get(n) ?? null),
    isIgnoredCached: vi.fn((n: number) => opts.ignored?.has(n) ?? false),
    liftAircraftIgnore: vi.fn(async () => opts.liftResult ?? true),
    clearAgedOut: vi.fn(async () => undefined),
    scheduleClassification: vi.fn(),
  };
  return { deps, written };
}

const AGE_ON = { aircraftAgeOutEnabled: 'true' };

describe('pairPositionRows', () => {
  it('pairs lat/lon rows on the shared timestamp and drops orphans', () => {
    expect(pairPositionRows([
      { telemetryType: 'latitude', timestamp: 1, value: 40 },
      { telemetryType: 'longitude', timestamp: 1, value: -105 },
      { telemetryType: 'latitude', timestamp: 2, value: 41 },
      { telemetryType: 'altitude', timestamp: 1, value: 9000 },
    ])).toEqual([{ lat: 40, lon: -105 }]);
  });
});

describe('AircraftAgeOutService.runSweep — gating', () => {
  it('skips when detection is off for the source, and persists nothing', async () => {
    const { deps, written } = makeDeps({ settings: { aircraftDetectionEnabled: 'false', ...AGE_ON }, candidates: [cand(1)] });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(r.ran).toBe(false);
    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(written.size).toBe(0);
  });

  it.each(['meshcore', 'meshcore_mqtt', 'reticulum'])('skips an excluded %s source', async (type) => {
    const { deps } = makeDeps({ settings: AGE_ON, candidates: [cand(1)], sourceType: type });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(r.ran).toBe(false);
    expect(deps.addAircraftIgnore).not.toHaveBeenCalled();
  });

  it('age-out off: nothing is aged out, but the sweep still runs and records its time', async () => {
    const { deps, written } = makeDeps({ candidates: [cand(1)] });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(r.ran).toBe(true);
    expect(deps.addAircraftIgnore).not.toHaveBeenCalled();
    expect(deps.deleteNode).not.toHaveBeenCalled();
    expect(written.get('aircraftAgeOutLastRunAt')).toBe(String(NOW));
    expect(JSON.parse(written.get('aircraftAgeOutLastResult')!)).toEqual({ agedOut: 0, fixed: 0, lifted: 0, deleted: 0 });
  });
});

describe('AircraftAgeOutService.runSweep — age-out pass', () => {
  it('ignore action: DB-only ignore then marks aged out', async () => {
    const { deps, written } = makeDeps({ settings: AGE_ON, candidates: [cand(1)] });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.addAircraftIgnore).toHaveBeenCalledWith(1, SRC, '!00000001', 'Node 1', 'N1');
    expect(deps.markAgedOut).toHaveBeenCalledWith(1, SRC, NOW);
    expect(deps.deleteNode).not.toHaveBeenCalled();
    expect(r.agedOut).toBe(1);
    expect(JSON.parse(written.get('aircraftAgeOutLastResult')!).agedOut).toBe(1);
  });

  it('delete action: deletes the node and does not ignore it', async () => {
    const { deps } = makeDeps({ settings: { ...AGE_ON, aircraftAgeOutAction: 'delete' }, candidates: [cand(1)] });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.deleteNode).toHaveBeenCalledWith(1, SRC);
    expect(deps.addAircraftIgnore).not.toHaveBeenCalled();
    expect(r.deleted).toBe(1);
  });

  it('respects the hours window (a node heard inside N hours is kept)', async () => {
    const recent = cand(2, { lastHeard: Math.floor((NOW - 30 * HOUR) / 1000) });
    const old = cand(3, { lastHeard: Math.floor((NOW - 50 * HOUR) / 1000) });
    const { deps } = makeDeps({ settings: { ...AGE_ON, aircraftAgeOutHours: '48' }, candidates: [recent, old] });
    await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.addAircraftIgnore).toHaveBeenCalledTimes(1);
    expect((deps.addAircraftIgnore as any).mock.calls[0][0]).toBe(3);
  });

  it('protects favourites, the local node, already-ignored nodes, and never-heard rows', async () => {
    const { deps } = makeDeps({
      settings: AGE_ON,
      localNodeNum: 11,
      candidates: [
        cand(10, { isFavorite: true }),
        cand(11),
        cand(12, { isIgnored: true }),
        cand(13, { lastHeard: null }),
      ],
    });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.addAircraftIgnore).not.toHaveBeenCalled();
    expect(deps.markAgedOut).not.toHaveBeenCalled();
    expect(r.agedOut).toBe(0);
  });

  it('protection also holds for the delete action', async () => {
    const { deps } = makeDeps({
      settings: { ...AGE_ON, aircraftAgeOutAction: 'delete' },
      localNodeNum: 11,
      candidates: [cand(10, { isFavorite: true }), cand(11), cand(12, { isIgnored: true })],
    });
    await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.deleteNode).not.toHaveBeenCalled();
  });
});

describe('AircraftAgeOutService.runSweep — fixed pass', () => {
  const recentHeard = Math.floor((NOW - 2 * HOUR) / 1000);
  const tight = [{ lat: 40, lon: -105 }, { lat: 40 + 50 * M, lon: -105 }, { lat: 40 + 90 * M, lon: -105 }];

  it('marks a recently heard, stationary node as fixed at its effective position', async () => {
    const { deps } = makeDeps({
      candidates: [cand(20, { lastHeard: recentHeard, latitude: 40.001, longitude: -105.002 })],
      fixes: { '!00000014': tight },
    });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.getPositionFixes).toHaveBeenCalledWith('!00000014', NOW - 24 * HOUR, SRC);
    expect(deps.setFixed).toHaveBeenCalledWith(20, SRC, { atMs: NOW, lat: 40.001, lon: -105.002 });
    expect(r.fixed).toBe(1);
  });

  it('uses the position override as the anchor when one is set', async () => {
    const { deps } = makeDeps({
      candidates: [cand(21, {
        lastHeard: recentHeard, positionOverrideEnabled: true, latitudeOverride: 41, longitudeOverride: -106,
      })],
      fixes: { '!00000015': tight },
    });
    await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.setFixed).toHaveBeenCalledWith(21, SRC, { atMs: NOW, lat: 41, lon: -106 });
  });

  it('does not mark a moving node, a node with too few fixes, an old node, or an ignored node', async () => {
    const { deps } = makeDeps({
      candidates: [
        cand(22, { lastHeard: recentHeard }),
        cand(23, { lastHeard: recentHeard }),
        cand(24, { lastHeard: Math.floor((NOW - 30 * HOUR) / 1000) }),
        cand(25, { lastHeard: recentHeard, isIgnored: true }),
      ],
      fixes: {
        '!00000016': [...tight, { lat: 40 + 500 * M, lon: -105 }],
        '!00000017': tight.slice(0, 2),
        '!00000018': tight,
        '!00000019': tight,
      },
    });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(deps.setFixed).not.toHaveBeenCalled();
    expect(r.fixed).toBe(0);
    // The old and ignored nodes never even load telemetry.
    expect(deps.getPositionFixes).toHaveBeenCalledTimes(2);
  });

  it('a node marked fixed in this sweep is not also aged out', async () => {
    // Heard 10 h ago: inside the 24 h fixed window AND past a 6 h age-out.
    const { deps } = makeDeps({
      settings: { ...AGE_ON, aircraftAgeOutHours: '6' },
      candidates: [cand(26, { lastHeard: Math.floor((NOW - 10 * HOUR) / 1000) })],
      fixes: { '!0000001a': tight },
    });
    const r = await new AircraftAgeOutService(deps).runSweep(SRC, NOW);
    expect(r.fixed).toBe(1);
    expect(deps.addAircraftIgnore).not.toHaveBeenCalled();
  });
});

describe('AircraftAgeOutService — live-position lift (D3)', () => {
  it('lifts an aged-out aircraft, clears the mark, reclassifies, and reports it on the next sweep', async () => {
    const { deps, written } = makeDeps({ ignored: new Set([5]), agedOut: new Map([[5, NOW - HOUR]]) });
    const svc = new AircraftAgeOutService(deps);
    await svc.onLivePosition(SRC, 5);
    expect(deps.liftAircraftIgnore).toHaveBeenCalledWith(5, SRC);
    expect(deps.clearAgedOut).toHaveBeenCalledWith(5, SRC);
    expect(deps.scheduleClassification).toHaveBeenCalledWith(SRC, 5);

    await svc.runSweep(SRC, NOW);
    expect(JSON.parse(written.get('aircraftAgeOutLastResult')!).lifted).toBe(1);
    // The counter resets after it is reported.
    await svc.runSweep(SRC, NOW + HOUR);
    expect(JSON.parse(written.get('aircraftAgeOutLastResult')!).lifted).toBe(0);
  });

  it('a manual or geo ignore (lift returns false) keeps the node ignored and aged-out mark untouched', async () => {
    const { deps } = makeDeps({ ignored: new Set([6]), agedOut: new Map([[6, NOW]]), liftResult: false });
    await new AircraftAgeOutService(deps).onLivePosition(SRC, 6);
    expect(deps.liftAircraftIgnore).toHaveBeenCalled();
    expect(deps.clearAgedOut).not.toHaveBeenCalled();
    expect(deps.scheduleClassification).toHaveBeenCalledWith(SRC, 6);
  });

  it('an ignored node that was never aged out (manual/geo) is never lifted', async () => {
    const { deps } = makeDeps({ ignored: new Set([7]) });
    await new AircraftAgeOutService(deps).onLivePosition(SRC, 7);
    expect(deps.liftAircraftIgnore).not.toHaveBeenCalled();
    expect(deps.clearAgedOut).not.toHaveBeenCalled();
  });

  it('a non-ignored node skips the DB lookup and only reclassifies', async () => {
    const { deps } = makeDeps();
    await new AircraftAgeOutService(deps).onLivePosition(SRC, 8);
    expect(deps.getAgedOutAt).not.toHaveBeenCalled();
    expect(deps.scheduleClassification).toHaveBeenCalledWith(SRC, 8);
  });

  it('classify:false lifts but does not queue classification', async () => {
    const { deps } = makeDeps({ ignored: new Set([9]), agedOut: new Map([[9, NOW]]) });
    await new AircraftAgeOutService(deps).onLivePosition(SRC, 9, { classify: false });
    expect(deps.clearAgedOut).toHaveBeenCalled();
    expect(deps.scheduleClassification).not.toHaveBeenCalled();
  });

  it('handlePositionReception: a replayed (stale rxTime) position does not lift, only reclassifies', async () => {
    const { deps } = makeDeps({ ignored: new Set([5]), agedOut: new Map([[5, NOW]]) });
    const svc = new AircraftAgeOutService(deps);
    const staleRx = Math.floor(NOW / 1000) - 3 * 3600;
    svc.handlePositionReception(SRC, 5, staleRx, NOW);
    await Promise.resolve();
    expect(deps.getAgedOutAt).not.toHaveBeenCalled();
    expect(deps.liftAircraftIgnore).not.toHaveBeenCalled();
    expect(deps.scheduleClassification).toHaveBeenCalledWith(SRC, 5);
  });

  it('handlePositionReception: a live rxTime lifts', async () => {
    const { deps } = makeDeps({ ignored: new Set([5]), agedOut: new Map([[5, NOW]]) });
    const svc = new AircraftAgeOutService(deps);
    svc.handlePositionReception(SRC, 5, Math.floor(NOW / 1000) - 5, NOW);
    await vi.waitFor(() => expect(deps.clearAgedOut).toHaveBeenCalledWith(5, SRC));
  });

  it('handlePositionReception: a stale reception with classify:false does nothing', () => {
    const { deps } = makeDeps();
    new AircraftAgeOutService(deps).handlePositionReception(SRC, 5, Math.floor(NOW / 1000) - 3 * 3600, NOW, { classify: false });
    expect(deps.scheduleClassification).not.toHaveBeenCalled();
  });
});
