/**
 * Auto-Enrichment scheduler (#5287).
 *
 * The limits here are mesh-impact policy (CLAUDE.md checklist), so each gets
 * an assertion: the one-hour schedule floor, the 25-per-run push cap, the 30 s
 * spacing, dropping failed pushes instead of retrying, and the timer rules —
 * enabling, saving and restarting must never count as a run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks -----------------------------------------------------------------

const store = new Map<string, string>();
vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(async (key: string) => store.get(key) ?? null),
      setSetting: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    },
  },
}));

const analyzeEnrichment = vi.fn();
const applyEnrichment = vi.fn();
vi.mock('./nodeInfoEnrichmentService.js', () => ({
  analyzeEnrichment: (...args: unknown[]) => analyzeEnrichment(...args),
  applyEnrichment: (...args: unknown[]) => applyEnrichment(...args),
}));

const pushNodeInfoRequestForNode = vi.fn();
vi.mock('./nodeInfoCopyService.js', () => ({
  pushNodeInfoRequestForNode: (...args: unknown[]) => pushNodeInfoRequestForNode(...args),
}));

import {
  AutoEnrichmentScheduler,
  clampIntervalMinutes,
  cronFiresAtMostHourly,
  isAutoEnrichmentDue,
  DEFAULT_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  PENDING_PUSH_CAP,
  PUSH_CAP_PER_RUN,
  PUSH_SPACING_MS,
} from './autoEnrichmentScheduler.js';

// ---- helpers ---------------------------------------------------------------

const HOUR = 60 * 60_000;

/** An analysis that fills `count` nodes on source B from source A. */
function stageFill(count: number, startNodeNum = 1000) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    nodeNum: startNodeNum + i,
    targets: [{ targetSourceId: 'B', donorSourceId: 'A' }],
  }));
  analyzeEnrichment.mockResolvedValueOnce({ nodes, summary: {} });
  applyEnrichment.mockResolvedValueOnce({
    applied: nodes.map(n => ({
      nodeNum: n.nodeNum, targetSourceId: 'B', donorSourceId: 'A',
      copiedFields: ['longName'], pushedToDevice: false,
    })),
    totalFieldsCopied: count,
  });
}

function enable(extra: Record<string, string> = {}) {
  store.set('autoEnrichmentEnabled', 'true');
  store.set('autoEnrichmentScheduleType', 'interval');
  store.set('autoEnrichmentIntervalMinutes', '60');
  for (const [k, v] of Object.entries(extra)) store.set(k, v);
}

/** Wait for the background push phase of the current run to finish. */
async function settle(s: AutoEnrichmentScheduler) {
  const lock = (s as any).runLock as Promise<unknown> | null;
  if (lock) await lock.catch(() => {});
}

beforeEach(() => {
  store.clear();
  analyzeEnrichment.mockReset();
  applyEnrichment.mockReset();
  pushNodeInfoRequestForNode.mockReset().mockResolvedValue(true);
});

// ---- pure helpers ----------------------------------------------------------

describe('schedule floor', () => {
  it('clamps an interval into [1 hour, 7 days]', () => {
    expect(clampIntervalMinutes(5)).toBe(MIN_INTERVAL_MINUTES);
    expect(clampIntervalMinutes(99_999)).toBe(MAX_INTERVAL_MINUTES);
    expect(clampIntervalMinutes('360')).toBe(360);
    expect(clampIntervalMinutes('junk')).toBe(DEFAULT_INTERVAL_MINUTES);
  });

  it.each([
    ['0 * * * *', true],
    ['0 */6 * * *', true],
    ['15 3 * * *', true],
    ['* * * * *', false],
    ['*/30 * * * *', false],
    ['0,30 * * * *', false],
    ['not a cron', false],
    ['', false],
  ])('cron %s fires at most hourly: %s', (expr, expected) => {
    expect(cronFiresAtMostHourly(expr)).toBe(expected);
  });

  it('decides due-ness for interval and cron', () => {
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const interval = { type: 'interval' as const, intervalMinutes: 60, cron: '' };
    expect(isAutoEnrichmentDue(interval, t0, t0 + 59 * 60_000)).toBe(false);
    expect(isAutoEnrichmentDue(interval, t0, t0 + HOUR)).toBe(true);

    const cron = { type: 'cron' as const, intervalMinutes: 60, cron: '0 * * * *' };
    expect(isAutoEnrichmentDue(cron, t0 + 60_000, t0 + 30 * 60_000)).toBe(false);
    expect(isAutoEnrichmentDue(cron, t0 + 60_000, t0 + HOUR + 60_000)).toBe(true);

    // A too-frequent cron is never due, even if it would match.
    const tooFast = { type: 'cron' as const, intervalMinutes: 60, cron: '* * * * *' };
    expect(isAutoEnrichmentDue(tooFast, t0, t0 + 10 * HOUR)).toBe(false);
  });
});

// ---- timer safety ----------------------------------------------------------

describe('timer safety', () => {
  it('does nothing while disabled', async () => {
    const s = new AutoEnrichmentScheduler(async () => {});
    await s.checkAndRun(Date.now());
    expect(analyzeEnrichment).not.toHaveBeenCalled();
    expect(store.has('autoEnrichmentArmedAt')).toBe(false);
  });

  it('does not run on the tick that first sees it enabled', async () => {
    enable();
    const s = new AutoEnrichmentScheduler(async () => {});
    const t0 = Date.now();
    await s.checkAndRun(t0);
    expect(analyzeEnrichment).not.toHaveBeenCalled();
    expect(store.get('autoEnrichmentArmedAt')).toBe(String(t0));

    // One full period later it runs.
    stageFill(0);
    await s.checkAndRun(t0 + HOUR);
    await settle(s);
    expect(analyzeEnrichment).toHaveBeenCalledTimes(1);
  });

  it('a restart does not count as a run — the persisted last run is honoured', async () => {
    enable({ autoEnrichmentLastRunAt: String(Date.now() - 10 * 60_000) });
    const restarted = new AutoEnrichmentScheduler(async () => {});
    await restarted.checkAndRun(Date.now());
    expect(analyzeEnrichment).not.toHaveBeenCalled();
  });

  it('runNow refuses to overlap a run in progress', async () => {
    enable({ autoEnrichmentPushToNodeDb: 'true' });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const s = new AutoEnrichmentScheduler(() => gate);
    stageFill(2);
    await s.runNow('manual'); // resolves after the DB phase; pushes still pending
    await expect(s.runNow('manual')).rejects.toThrow(/in progress/);
    release();
    await settle(s);
  });
});

// ---- mesh impact -----------------------------------------------------------

describe('push limits', () => {
  it('fills the DB without pushing when pushToNodeDb is off, and clears any queue', async () => {
    enable({ autoEnrichmentPendingPushes: JSON.stringify([{ nodeNum: 1, targetSourceId: 'B' }]) });
    const s = new AutoEnrichmentScheduler(async () => {});
    stageFill(5);
    const summary = await s.runNow('manual');
    await settle(s);

    expect(applyEnrichment).toHaveBeenCalledWith(expect.any(Array), { pushToNodeDb: false });
    expect(summary.nodesFilled).toBe(5);
    expect(pushNodeInfoRequestForNode).not.toHaveBeenCalled();
    expect(JSON.parse(store.get('autoEnrichmentPendingPushes')!)).toEqual([]);
  });

  it(`pushes at most ${PUSH_CAP_PER_RUN} per run, ${PUSH_SPACING_MS / 1000}s apart, and queues the rest`, async () => {
    enable({ autoEnrichmentPushToNodeDb: 'true' });
    const sleep = vi.fn(async (_ms: number, _signal: { cancelled: boolean }) => {});
    const s = new AutoEnrichmentScheduler(sleep);
    stageFill(40);
    await s.runNow('manual');
    await settle(s);

    expect(pushNodeInfoRequestForNode).toHaveBeenCalledTimes(PUSH_CAP_PER_RUN);
    // One gap between each pair of sends, never before the first.
    expect(sleep).toHaveBeenCalledTimes(PUSH_CAP_PER_RUN - 1);
    for (const call of sleep.mock.calls) expect(call[0]).toBe(PUSH_SPACING_MS);
    expect(JSON.parse(store.get('autoEnrichmentPendingPushes')!)).toHaveLength(40 - PUSH_CAP_PER_RUN);

    // The next run drains the queue before anything new, still capped.
    pushNodeInfoRequestForNode.mockClear();
    stageFill(0);
    await s.runNow('manual');
    await settle(s);
    expect(pushNodeInfoRequestForNode).toHaveBeenCalledTimes(40 - PUSH_CAP_PER_RUN);
    expect(pushNodeInfoRequestForNode.mock.calls[0]).toEqual([1000 + PUSH_CAP_PER_RUN, 'B']);
  });

  it('drops a failed push instead of retrying it', async () => {
    enable({ autoEnrichmentPushToNodeDb: 'true' });
    pushNodeInfoRequestForNode.mockResolvedValue(false);
    const s = new AutoEnrichmentScheduler(async () => {});
    stageFill(3);
    await s.runNow('manual');
    await settle(s);

    const summary = JSON.parse(store.get('autoEnrichmentLastRunSummary')!);
    expect(summary.pushesFailed).toBe(3);
    expect(JSON.parse(store.get('autoEnrichmentPendingPushes')!)).toEqual([]);
  });

  it(`bounds the pending queue at ${PENDING_PUSH_CAP}`, async () => {
    enable({ autoEnrichmentPushToNodeDb: 'true' });
    const s = new AutoEnrichmentScheduler(async () => {});
    stageFill(PENDING_PUSH_CAP + 200);
    await s.runNow('manual');
    await settle(s);

    const pending = JSON.parse(store.get('autoEnrichmentPendingPushes')!);
    expect(pending.length).toBeLessThanOrEqual(PENDING_PUSH_CAP);
  });

  it('does not queue a node twice across runs', async () => {
    enable({ autoEnrichmentPushToNodeDb: 'true' });
    const s = new AutoEnrichmentScheduler(async () => {});
    // Stop before pushing so the queue is left intact between runs.
    s.stop();
    stageFill(30);
    await s.runNow('manual');
    await settle(s);
    const afterFirst = JSON.parse(store.get('autoEnrichmentPendingPushes')!).length;

    stageFill(30); // same nodes filled again
    await s.runNow('manual');
    await settle(s);
    expect(JSON.parse(store.get('autoEnrichmentPendingPushes')!).length).toBe(afterFirst);
  });

  it('records the run time even when the push phase is cut short', async () => {
    enable({ autoEnrichmentPushToNodeDb: 'true' });
    const s = new AutoEnrichmentScheduler(async () => {});
    s.stop();
    stageFill(5);
    const before = Date.now();
    await s.runNow('manual');
    await settle(s);
    expect(Number(store.get('autoEnrichmentLastRunAt'))).toBeGreaterThanOrEqual(before);
  });
});
