/**
 * The real runScheduledTrace dep (#5723): the due/cap claim happens before the
 * send, at most one trace goes out per call, and nothing is sent when the path
 * is not due, the source is capped, or the source is not a MeshCore companion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getManager = vi.fn();
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => getManager(id) },
}));
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: async (s: string, k: string) => settings.get(`${s}:${k}`) ?? null,
      setSourceSetting: async (s: string, k: string, v: string) => { settings.set(`${s}:${k}`, v); },
    },
  },
}));
vi.mock('../appriseNotificationService.js', () => ({ appriseNotificationService: {} }));
vi.mock('../../utils/scriptRunner.js', () => ({ runScript: vi.fn() }));
vi.mock('../waypointService.js', () => ({ waypointService: {} }));

import { createMeshActionDeps } from './meshActionDeps.js';
import { TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR } from '../../../types/tracePathSchedule.js';

const K = (c: string) => c.repeat(64);
const path = (c: string, over: Record<string, unknown> = {}) => ({ publicKey: K(c), hashBytes: 'auto' as const, intervalMinutes: 10, ...over });

describe('runScheduledTrace (#5723)', () => {
  let trace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settings.clear();
    getManager.mockReset();
    trace = vi.fn().mockResolvedValue({ ok: true, hops: [{ snr: 1 }, { snr: 2 }], lastSnr: 3 });
    getManager.mockReturnValue({ traceContactPathDetailed: trace });
  });

  it('sends exactly one trace for a due path, with the chosen width and return leg', async () => {
    const deps = createMeshActionDeps();
    const r = await deps.runScheduledTrace({ sourceId: 'mc', pathKey: 'k1', path: path('a', { hashBytes: 2 }), autoReturn: true });
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace).toHaveBeenCalledWith(K('a'), { autoReturn: true, hashBytes: 2 });
    expect(r).toMatchObject({ publicKey: K('a'), traced: true, hops: 2 });
  });

  it('"auto" width passes no override', async () => {
    await createMeshActionDeps().runScheduledTrace({ sourceId: 'mc', pathKey: 'k1', path: path('a'), autoReturn: false });
    expect(trace).toHaveBeenCalledWith(K('a'), { autoReturn: false });
  });

  it('a second call inside the interval sends nothing and reports not due', async () => {
    const deps = createMeshActionDeps();
    await deps.runScheduledTrace({ sourceId: 'mc', pathKey: 'k1', path: path('a'), autoReturn: false });
    const r = await deps.runScheduledTrace({ sourceId: 'mc', pathKey: 'k1', path: path('a'), autoReturn: false });
    expect(trace).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ skipped: true, notDue: true });
  });

  it(`sends nothing past ${TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR} traces an hour on one source`, async () => {
    const deps = createMeshActionDeps();
    for (let i = 0; i < TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR; i++) {
      await deps.runScheduledTrace({ sourceId: 'mc', pathKey: `k${i}`, path: path('a'), autoReturn: false });
    }
    const r = await deps.runScheduledTrace({ sourceId: 'mc', pathKey: 'extra', path: path('b'), autoReturn: false }) as { skipped?: boolean; notDue?: boolean; reason?: string };
    expect(trace).toHaveBeenCalledTimes(TRACE_SCHEDULE_MAX_PER_SOURCE_PER_HOUR);
    expect(r.skipped).toBe(true);
    expect(r.notDue).toBeUndefined(); // a capped tick is worth a run-log row
    expect(r.reason).toMatch(/12 scheduled traces/);
  });

  it('a failed or unanswered trace still counts and is never retried', async () => {
    trace.mockResolvedValue({ ok: false, reason: 'timeout' });
    const deps = createMeshActionDeps();
    const r = await deps.runScheduledTrace({ sourceId: 'mc', pathKey: 'k1', path: path('a'), autoReturn: false });
    expect(r).toMatchObject({ traced: false });
    await deps.runScheduledTrace({ sourceId: 'mc', pathKey: 'k1', path: path('a'), autoReturn: false });
    expect(trace).toHaveBeenCalledTimes(1);
  });

  it('a source that is not a MeshCore companion sends nothing and uses no slot', async () => {
    getManager.mockReturnValue({ sendTextMessage: vi.fn() });
    const r = await createMeshActionDeps().runScheduledTrace({ sourceId: 'mt', pathKey: 'k1', path: path('a'), autoReturn: false });
    expect(r).toMatchObject({ skipped: true });
    expect(settings.size).toBe(0);
  });
});
