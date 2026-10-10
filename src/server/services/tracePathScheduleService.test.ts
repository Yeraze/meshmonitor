/**
 * TracePathScheduleService (#5723): per-path intervals and the per-source
 * hourly cap, both from persisted state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {} }));

import {
  TracePathScheduleService,
  SETTING_TRACE_SCHEDULE_STATE,
  parseTraceScheduleState,
  type TraceScheduleDeps,
} from './tracePathScheduleService.js';
import { TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR, TRACE_SCHEDULE_MIN_INTERVAL_MINUTES } from '../../types/tracePathSchedule.js';

const MIN = 60_000;

describe('TracePathScheduleService (#5723)', () => {
  let now: number;
  let settings: Map<string, string>;
  let deps: TraceScheduleDeps;
  let svc: TracePathScheduleService;

  beforeEach(() => {
    now = 1_000_000_000;
    settings = new Map();
    deps = {
      getSourceSetting: async (s, k) => settings.get(`${s}:${k}`) ?? null,
      setSourceSetting: async (s, k, v) => { settings.set(`${s}:${k}`, v); },
      now: () => now,
    };
    svc = new TracePathScheduleService(deps);
  });

  const claim = (pathKey: string, intervalMinutes = 10, sourceId = 's1') => svc.claim({ sourceId, pathKey, intervalMinutes });

  it('a new path is due at once, then waits out its own interval', async () => {
    expect(await claim('a', 10)).toEqual({ due: true });
    now += 9 * MIN;
    expect(await claim('a', 10)).toEqual({ due: false, reason: 'not_due', nextDueAt: 1_000_000_000 + 10 * MIN });
    now += MIN;
    expect(await claim('a', 10)).toEqual({ due: true });
  });

  it('each path keeps its own interval', async () => {
    await claim('fast', 10);
    await claim('slow', 600);
    now += 10 * MIN;
    expect((await claim('fast', 10)).due).toBe(true);
    expect((await claim('slow', 600)).due).toBe(false);
  });

  it(`never runs a path more often than every ${TRACE_SCHEDULE_MIN_INTERVAL_MINUTES} minutes, whatever the config says`, async () => {
    await claim('a', 1);
    now += 5 * MIN;
    expect((await claim('a', 1)).due).toBe(false);
    now += 5 * MIN;
    expect((await claim('a', 1)).due).toBe(true);
  });

  it(`caps a source at ${TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR} traces in a rolling hour`, async () => {
    for (let i = 0; i < TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR; i++) expect((await claim(`p${i}`)).due).toBe(true);
    expect(await claim('extra')).toEqual({ due: false, reason: 'hourly_cap' });
    // Another source has its own allowance.
    expect((await claim('extra', 10, 's2')).due).toBe(true);
    // A slot frees once the oldest run is an hour old; the capped path was never stamped.
    now += 60 * MIN + 1;
    expect((await claim('extra')).due).toBe(true);
  });

  it('concurrent claims cannot exceed the cap', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(`c${i}`)));
    expect(results.filter((r) => r.due)).toHaveLength(TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR);
  });

  it('a restart or a settings save does not reset a path or the cap (state is persisted)', async () => {
    await claim('a', 30);
    now += 3 * MIN;
    const restarted = new TracePathScheduleService(deps);
    expect((await restarted.claim({ sourceId: 's1', pathKey: 'a', intervalMinutes: 30 })).due).toBe(false);
    const state = JSON.parse(settings.get(`s1:${SETTING_TRACE_SCHEDULE_STATE}`)!);
    expect(state.last.a).toBe(1_000_000_000);
    expect(state.runs).toHaveLength(1);
  });
});

describe('parseTraceScheduleState (#5723)', () => {
  it('drops junk, future times, old runs and stale paths', () => {
    const now = 100 * 24 * 60 * MIN;
    const state = parseTraceScheduleState(JSON.stringify({
      last: { fresh: now - MIN, stale: now - 40 * 24 * 60 * MIN, future: now + MIN, junk: 'x' },
      runs: [now - 61 * MIN, now - 59 * MIN, now + MIN, 'x'],
    }), now);
    expect(state).toEqual({ last: { fresh: now - MIN }, runs: [now - 59 * MIN] });
    expect(parseTraceScheduleState('nope', now)).toEqual({ last: {}, runs: [] });
    expect(parseTraceScheduleState(null, now)).toEqual({ last: {}, runs: [] });
  });
});
