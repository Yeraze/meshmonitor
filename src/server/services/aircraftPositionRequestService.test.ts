/**
 * AircraftPositionRequestService (#5704): 3 position requests at t = 0, 2 and
 * 4 minutes on the likely-aircraft transition, opt-in per source, at most 2
 * aircraft per source per rolling hour, with the cap persisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {} }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getManager: () => null } }));

import {
  AircraftPositionRequestService,
  MAX_SEQUENCES_PER_HOUR,
  SETTING_ENABLED,
  SETTING_STARTS,
  recentStarts,
  type AircraftPositionRequestDeps,
  type PositionRequestTarget,
} from './aircraftPositionRequestService.js';

const SRC = 'src-a';
const PLANE = 0x0a0b0c0d;
const MIN = 60_000;

interface World {
  deps: AircraftPositionRequestDeps;
  settings: Map<string, string>;
  sends: Array<{ dest: number; channel: number; origin?: string; at: number }>;
  node: { likelyAircraft: boolean | null; channel: number; isIgnored?: boolean } | null;
  manager: PositionRequestTarget & { failWith?: Error };
  sourceType: string | null;
}

function makeWorld(): World {
  const settings = new Map<string, string>([[`${SRC}:${SETTING_ENABLED}`, 'true']]);
  const sends: World['sends'] = [];
  const w = {
    settings,
    sends,
    node: { likelyAircraft: true, channel: 2 } as World['node'],
    sourceType: 'meshtastic_tcp' as string | null,
  } as World;
  w.manager = {
    isConnected: true,
    getLocalNodeInfo: () => ({ nodeNum: 0x11111111 }),
    sendPositionRequest: async (dest, channel = 0, options) => {
      if (w.manager.failWith) throw w.manager.failWith;
      sends.push({ dest, channel, origin: options?.origin, at: Date.now() });
    },
  };
  w.deps = {
    getSourceType: async () => w.sourceType,
    getSourceSetting: async (sourceId, key) => settings.get(`${sourceId}:${key}`) ?? null,
    setSourceSetting: async (sourceId, key, value) => { settings.set(`${sourceId}:${key}`, value); },
    getNode: async () => w.node,
    getManager: () => w.manager,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  return w;
}

describe('AircraftPositionRequestService (#5704)', () => {
  let w: World;
  let svc: AircraftPositionRequestService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    w = makeWorld();
    svc = new AircraftPositionRequestService(w.deps);
  });
  afterEach(() => {
    svc.stopAll();
    vi.useRealTimers();
  });

  it('sends exactly 3 requests at t = 0, 2 and 4 minutes, on the node channel, tagged automation', async () => {
    const t0 = Date.now();
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * MIN - 1);
    expect(w.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(w.sends).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(w.sends).toHaveLength(3);
    expect(w.sends.map((s) => s.at - t0)).toEqual([0, 2 * MIN, 4 * MIN]);
    expect(w.sends.every((s) => s.dest === PLANE && s.channel === 2 && s.origin === 'automation')).toBe(true);
  });

  it('sends nothing when the source has not opted in', async () => {
    w.settings.delete(`${SRC}:${SETTING_ENABLED}`);
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toEqual([]);
    expect(w.settings.has(`${SRC}:${SETTING_STARTS}`)).toBe(false);
  });

  it.each(['mqtt_bridge', 'mqtt_broker', 'meshcore', 'reticulum', null])('sends nothing on a %s source', async (type) => {
    w.sourceType = type;
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toEqual([]);
  });

  it('never asks the local node, and ignores an event with no source', async () => {
    await svc.onAircraftTransition(SRC, 0x11111111);
    await svc.onAircraftTransition(undefined, PLANE);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toEqual([]);
  });

  it('stops asking once the node is no longer a likely aircraft (landed or manually marked)', async () => {
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(0);
    w.node = { likelyAircraft: false, channel: 2 };
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toHaveLength(1);
  });

  it('stops when the node is ignored, deleted, or the source disconnects', async () => {
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(0);
    w.manager.isConnected = false;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toHaveLength(1);

    w.manager.isConnected = true;
    w.node = { likelyAircraft: true, channel: 2, isIgnored: true };
    await svc.onAircraftTransition(SRC, PLANE + 1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toHaveLength(1);
  });

  it('gives up on the aircraft when a send is refused (TX disabled)', async () => {
    w.manager.failWith = new Error('TX disabled');
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(0);
    w.manager.failWith = undefined;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toEqual([]);
  });

  it('does not start a second sequence for a node already being asked', async () => {
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(MIN);
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toHaveLength(3);
    expect(recentStarts(w.settings.get(`${SRC}:${SETTING_STARTS}`) ?? null, Date.now())).toHaveLength(1);
  });

  it(`asks at most ${MAX_SEQUENCES_PER_HOUR} aircraft per source per rolling hour`, async () => {
    await svc.onAircraftTransition(SRC, PLANE);
    await svc.onAircraftTransition(SRC, PLANE + 1);
    await svc.onAircraftTransition(SRC, PLANE + 2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(new Set(w.sends.map((s) => s.dest))).toEqual(new Set([PLANE, PLANE + 1]));
    expect(w.sends).toHaveLength(6);

    // A slot frees once the oldest start is an hour old.
    await vi.advanceTimersByTimeAsync(51 * MIN);
    await svc.onAircraftTransition(SRC, PLANE + 3);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends.filter((s) => s.dest === PLANE + 3)).toHaveLength(3);
  });

  it('the cap survives a restart and a settings save (it is persisted, per source)', async () => {
    await svc.onAircraftTransition(SRC, PLANE);
    await svc.onAircraftTransition(SRC, PLANE + 1);
    await vi.advanceTimersByTimeAsync(10 * MIN);

    // "Restart": a new service over the same stored settings. Saving the
    // user-facing switch again does not touch the stored start times.
    w.settings.set(`${SRC}:${SETTING_ENABLED}`, 'true');
    const restarted = new AircraftPositionRequestService(w.deps);
    await restarted.onAircraftTransition(SRC, PLANE + 2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends.some((s) => s.dest === PLANE + 2)).toBe(false);

    // Another source has its own allowance.
    w.settings.set(`src-b:${SETTING_ENABLED}`, 'true');
    await restarted.onAircraftTransition('src-b', PLANE + 2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends.filter((s) => s.dest === PLANE + 2)).toHaveLength(3);
    restarted.stopAll();
  });

  it('concurrent transitions cannot exceed the cap', async () => {
    await Promise.all([0, 1, 2, 3, 4].map((i) => svc.onAircraftTransition(SRC, PLANE + i)));
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(new Set(w.sends.map((s) => s.dest)).size).toBe(MAX_SEQUENCES_PER_HOUR);
  });

  it('a restart drops a sequence in flight and fires nothing on boot', async () => {
    await svc.onAircraftTransition(SRC, PLANE);
    await vi.advanceTimersByTimeAsync(0);
    svc.stopAll(); // process exit: pending timers are gone
    const restarted = new AircraftPositionRequestService(w.deps);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(w.sends).toHaveLength(1);
    restarted.stopAll();
  });
});

describe('recentStarts (#5704)', () => {
  it('keeps only start times inside the last hour and tolerates junk', () => {
    const now = 10 * 60 * MIN;
    expect(recentStarts(JSON.stringify([now - 61 * MIN, now - 59 * MIN, now]), now)).toEqual([now - 59 * MIN, now]);
    expect(recentStarts('not json', now)).toEqual([]);
    expect(recentStarts('{"a":1}', now)).toEqual([]);
    expect(recentStarts(null, now)).toEqual([]);
    expect(recentStarts(JSON.stringify([now + MIN, 'x']), now)).toEqual([]);
  });
});
