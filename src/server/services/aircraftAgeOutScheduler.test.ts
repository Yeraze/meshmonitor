/**
 * Aircraft age-out scheduler (#5364/#5365 Phase 2): the due check reads the
 * persisted last run, so a restart never counts as (or forces) a run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AircraftAgeOutScheduler,
  isSweepDue,
  MIN_RUN_GAP_MS,
  FIRST_TICK_DELAY_MS,
  TICK_INTERVAL_MS,
} from './aircraftAgeOutScheduler.js';

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('isSweepDue', () => {
  it('due when never run or unparseable', () => {
    expect(isSweepDue(null, NOW)).toBe(true);
    expect(isSweepDue('', NOW)).toBe(true);
    expect(isSweepDue('garbage', NOW)).toBe(true);
  });
  it('not due inside 55 min; due at 55 min', () => {
    expect(isSweepDue(String(NOW - MIN_RUN_GAP_MS + 1), NOW)).toBe(false);
    expect(isSweepDue(String(NOW - MIN_RUN_GAP_MS), NOW)).toBe(true);
  });
});

function makeScheduler(opts: {
  sources: Array<{ sourceId: string; sourceType: string }>;
  lastRun?: Record<string, string>;
  runSweep?: (sourceId: string, now: number) => Promise<unknown>;
}) {
  const lastRun = new Map(Object.entries(opts.lastRun ?? {}));
  const runSweep = vi.fn(opts.runSweep ?? (async (sourceId: string, now: number) => { lastRun.set(sourceId, String(now)); }));
  const clock = { now: NOW };
  const sched = new AircraftAgeOutScheduler({
    listSources: () => opts.sources,
    getLastRunAt: async (sourceId) => lastRun.get(sourceId) ?? null,
    runSweep,
    now: () => clock.now,
  });
  return { sched, runSweep, lastRun, clock };
}

describe('AircraftAgeOutScheduler.tick', () => {
  it('runs every eligible source that is due and skips MeshCore/Reticulum', async () => {
    const { sched, runSweep } = makeScheduler({
      sources: [
        { sourceId: 'tcp', sourceType: 'meshtastic_tcp' },
        { sourceId: 'mqtt', sourceType: 'mqtt' },
        { sourceId: 'mc', sourceType: 'meshcore' },
        { sourceId: 'mcm', sourceType: 'meshcore_mqtt' },
        { sourceId: 'ret', sourceType: 'reticulum' },
      ],
    });
    await sched.tick();
    expect(runSweep.mock.calls.map((c) => c[0]).sort()).toEqual(['mqtt', 'tcp']);
  });

  it('honours the persisted last run: a restart (new instance) inside 55 min does not run', async () => {
    // Simulates a container restart: a fresh scheduler, but the DB already
    // holds a run from 10 minutes ago.
    const { sched, runSweep } = makeScheduler({
      sources: [{ sourceId: 'tcp', sourceType: 'meshtastic_tcp' }],
      lastRun: { tcp: String(NOW - 10 * 60_000) },
    });
    await sched.tick();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it('runs again once 55 min have passed since the persisted run', async () => {
    const { sched, runSweep, clock } = makeScheduler({ sources: [{ sourceId: 'tcp', sourceType: 'meshtastic_tcp' }] });
    await sched.tick();
    expect(runSweep).toHaveBeenCalledTimes(1);
    clock.now += 30 * 60_000;
    await sched.tick();
    expect(runSweep).toHaveBeenCalledTimes(1);
    clock.now += 30 * 60_000;
    await sched.tick();
    expect(runSweep).toHaveBeenCalledTimes(2);
  });

  it('per-source re-entry guard: an overlapping tick does not start a second sweep', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { sched, runSweep } = makeScheduler({
      sources: [{ sourceId: 'tcp', sourceType: 'meshtastic_tcp' }],
      runSweep: async () => { await gate; },
    });
    const first = sched.tick();
    await sched.tick();
    release();
    await first;
    expect(runSweep).toHaveBeenCalledTimes(1);
  });

  it('a failing sweep on one source does not stop the others', async () => {
    const { sched, runSweep } = makeScheduler({
      sources: [{ sourceId: 'a', sourceType: 'mqtt' }, { sourceId: 'b', sourceType: 'mqtt' }],
      runSweep: async (sourceId) => { if (sourceId === 'a') throw new Error('boom'); },
    });
    await sched.tick();
    expect(runSweep).toHaveBeenCalledTimes(2);
  });
});

describe('AircraftAgeOutScheduler timers', () => {
  it('first tick after 5 min, then hourly; nothing on initialize itself; shutdown stops it', async () => {
    vi.useFakeTimers();
    const { sched, runSweep, clock } = makeScheduler({ sources: [{ sourceId: 'tcp', sourceType: 'mqtt' }] });
    sched.initialize();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS - 1);
    expect(runSweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runSweep).toHaveBeenCalledTimes(1);
    clock.now += TICK_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(runSweep).toHaveBeenCalledTimes(2);
    sched.shutdown();
    clock.now += TICK_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(runSweep).toHaveBeenCalledTimes(2);
  });
});
