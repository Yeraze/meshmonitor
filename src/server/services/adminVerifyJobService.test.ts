import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AdminVerifyJobService,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  MAX_DURATION_MS,
  MAX_RUNNING_PER_SOURCE,
  VerifyJobLimitError,
  diffConfig,
  resolveVerifyTarget,
  valuesEqual,
  type VerifyJobDeps,
  type VerifyTarget,
} from './adminVerifyJobService.js';

const baseline = { role: 0, nodeInfoBroadcastSecs: 3600, tzdef: '' };
const expected = { role: 2, nodeInfoBroadcastSecs: 3600, tzdef: 'EST5EDT' };
const target: VerifyTarget = { kind: 'device', section: 'device', adminType: 0, expected };

function start(svc: AdminVerifyJobService, deps: VerifyJobDeps, over: Partial<{ sourceId: string; node: number; section: string }> = {}) {
  return svc.start(
    {
      sourceId: over.sourceId ?? 'src-a',
      destinationNodeNum: over.node ?? 1234,
      command: 'setDeviceConfig',
      target: over.section ? { ...target, section: over.section } : target,
      baseline,
    },
    deps,
  );
}

/** Advance fake time and let the job's awaited promises settle. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('valuesEqual', () => {
  it('treats missing and proto3 defaults as equal', () => {
    expect(valuesEqual(undefined, 0)).toBe(true);
    expect(valuesEqual(null, '')).toBe(true);
    expect(valuesEqual([], undefined)).toBe(true);
    expect(valuesEqual(Buffer.alloc(0), undefined)).toBe(true);
    expect(valuesEqual('0', 0)).toBe(true);
  });

  it('compares bytes, arrays, nested objects and float32 rounding', () => {
    expect(valuesEqual(Buffer.from([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(valuesEqual(Buffer.from([1, 2]), Buffer.from([1, 3]))).toBe(false);
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
    expect(valuesEqual({ a: 1, b: 0 }, { a: 1 })).toBe(true);
    expect(valuesEqual(906.875, 906.8750000001)).toBe(true);
    expect(valuesEqual(906.875, 907)).toBe(false);
    expect(valuesEqual('12345678901', 12345678901)).toBe(true);
  });
});

describe('diffConfig', () => {
  it('only judges fields the save changed', () => {
    const d = diffConfig('device', expected, baseline, { role: 2, nodeInfoBroadcastSecs: 7200, tzdef: 'EST5EDT' });
    expect(d).toEqual({ applied: ['role', 'tzdef'], notApplied: [], differs: [] });
  });

  it('splits old values from third values', () => {
    const d = diffConfig('device', expected, baseline, { role: 0, tzdef: 'UTC' });
    expect(d.notApplied).toEqual(['role']);
    expect(d.differs).toEqual(['tzdef']);
  });

  it('skips fields the firmware redacts', () => {
    const d = diffConfig('mqtt', { password: 'new' }, { password: 'sekrit' }, { password: 'sekrit' });
    expect(d).toEqual({ applied: [], notApplied: [], differs: [] });
  });
});

describe('resolveVerifyTarget', () => {
  it('maps set_config and set_module_config variants', () => {
    expect(resolveVerifyTarget({ setConfig: { payloadVariant: 'lora', lora: { hopLimit: 5 } } })).toMatchObject({
      kind: 'device', section: 'lora', adminType: 5, expected: { hopLimit: 5 },
    });
    expect(resolveVerifyTarget({ setModuleConfig: { payloadVariant: 'neighborInfo', neighborInfo: { enabled: true } } }))
      .toMatchObject({ kind: 'module', section: 'neighborInfo', adminType: 9 });
  });

  it('refuses security and non-config commands', () => {
    expect(resolveVerifyTarget({ setConfig: { payloadVariant: 'security', security: {} } })).toBeNull();
    expect(resolveVerifyTarget({ reboot: 10 })).toBeNull();
  });
});

describe('AdminVerifyJobService', () => {
  let svc: AdminVerifyJobService;
  beforeEach(() => {
    vi.useFakeTimers();
    svc = new AdminVerifyJobService();
  });
  afterEach(() => vi.useRealTimers());

  it('verifies on the first check after the settle delay', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const readBack = vi.fn().mockResolvedValue(expected);
    const job = start(svc, { send, readBack });

    await advance(0);
    expect(send).toHaveBeenCalledTimes(1);
    await advance(FIRST_CHECK_DELAY_MS - 1);
    expect(readBack).not.toHaveBeenCalled();
    await advance(1);
    expect(job.status).toBe('verified');
    expect(job.sends).toBe(1);
  });

  it('never resends when the node does not answer', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const readBack = vi.fn().mockResolvedValue(null);
    const job = start(svc, { send, readBack });

    await advance(MAX_DURATION_MS + CHECK_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('gave_up');
    expect(job.lastCheckOutcome).toBe('no_reply');
    // 90s, then every 5 min until 2 h.
    expect(readBack.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil((MAX_DURATION_MS - FIRST_CHECK_DELAY_MS) / CHECK_INTERVAL_MS));
  });

  it('resends once when the old value comes back, then verifies', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const readBack = vi.fn().mockResolvedValueOnce(baseline).mockResolvedValue(expected);
    const job = start(svc, { send, readBack });

    await advance(FIRST_CHECK_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(2);
    await advance(FIRST_CHECK_DELAY_MS);
    expect(job.status).toBe('verified');
  });

  it('stops as refused when a resend comes back with the same old fields', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const readBack = vi.fn().mockResolvedValue(baseline);
    const job = start(svc, { send, readBack });

    await advance(FIRST_CHECK_DELAY_MS * 3);
    expect(job.status).toBe('refused');
    expect(send).toHaveBeenCalledTimes(2);
    expect(job.pendingFields).toEqual(['role', 'tzdef']);
  });

  it('settles as differs when the node holds a third value', async () => {
    const job = start(svc, {
      send: vi.fn().mockResolvedValue(undefined),
      readBack: vi.fn().mockResolvedValue({ role: 2, tzdef: 'UTC' }),
    });
    await advance(FIRST_CHECK_DELAY_MS);
    expect(job.status).toBe('differs');
    expect(job.differingFields).toEqual(['tzdef']);
  });

  it('fails on a fatal send error', async () => {
    const job = start(svc, {
      send: vi.fn().mockRejectedValue(new Error('tx off')),
      readBack: vi.fn(),
      isFatal: () => ({ code: 'TX_DISABLED', message: 'off' }),
    });
    await advance(0);
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('TX_DISABLED');
  });

  it('cancel stops the job before the next check', async () => {
    const readBack = vi.fn().mockResolvedValue(expected);
    const job = start(svc, { send: vi.fn().mockResolvedValue(undefined), readBack });
    await advance(0);
    svc.cancel(job.id);
    await advance(FIRST_CHECK_DELAY_MS * 2);
    expect(job.status).toBe('cancelled');
    expect(readBack).not.toHaveBeenCalled();
  });

  it('replaces a job for the same node and section', async () => {
    const deps = () => ({ send: vi.fn().mockResolvedValue(undefined), readBack: vi.fn().mockResolvedValue(null) });
    const first = start(svc, deps());
    const second = start(svc, deps());
    expect(first.status).toBe('cancelled');
    expect(second.status).toBe('waiting');
  });

  it(`caps running jobs at ${MAX_RUNNING_PER_SOURCE} per source`, () => {
    const deps = () => ({ send: vi.fn().mockResolvedValue(undefined), readBack: vi.fn().mockResolvedValue(null) });
    for (let i = 0; i < MAX_RUNNING_PER_SOURCE; i++) start(svc, deps(), { node: i + 1 });
    expect(() => start(svc, deps(), { node: 99 })).toThrow(VerifyJobLimitError);
    expect(() => start(svc, deps(), { node: 99, sourceId: 'src-b' })).not.toThrow();
  });
});
