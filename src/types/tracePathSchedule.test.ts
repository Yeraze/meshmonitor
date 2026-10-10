/**
 * action.tracePathSchedule params (#5723): validation the save route and the
 * builder share.
 */
import { describe, it, expect } from 'vitest';
import { parseTracePathEntry, tracePathScheduleParamErrors, TRACE_SCHEDULE_MAX_PATHS } from './tracePathSchedule';
import { validateAutomationGraph } from './automation';
import { rewidthPathHops } from '../utils/meshcorePath';

const K = (c: string) => c.repeat(64);

describe('parseTracePathEntry (#5723)', () => {
  it('normalises a good row', () => {
    expect(parseTracePathEntry({ publicKey: K('A'), hashBytes: '2', intervalMinutes: 600, label: '  Hilltop ' }))
      .toEqual({ value: { publicKey: K('a'), hashBytes: 2, intervalMinutes: 600, label: 'Hilltop' } });
    expect(parseTracePathEntry({ publicKey: K('a'), intervalMinutes: 10 }))
      .toEqual({ value: { publicKey: K('a'), hashBytes: 'auto', intervalMinutes: 10 } });
  });

  it('rejects a bad key, width or interval', () => {
    expect(parseTracePathEntry({ publicKey: 'abc', intervalMinutes: 10 })).toHaveProperty('error');
    expect(parseTracePathEntry({ publicKey: K('a'), hashBytes: 3, intervalMinutes: 10 })).toHaveProperty('error');
    expect(parseTracePathEntry({ publicKey: K('a'), intervalMinutes: 9 })).toHaveProperty('error');
    expect(parseTracePathEntry({ publicKey: K('a'), intervalMinutes: 10.5 })).toHaveProperty('error');
    expect(parseTracePathEntry({ publicKey: K('a'), intervalMinutes: '' })).toHaveProperty('error');
    expect(parseTracePathEntry({ publicKey: K('a'), intervalMinutes: 999999 })).toHaveProperty('error');
  });
});

describe('tracePathScheduleParamErrors (#5723)', () => {
  it('needs at least one path, no duplicates, and at most the cap', () => {
    expect(tracePathScheduleParamErrors('a', {})).toHaveLength(1);
    expect(tracePathScheduleParamErrors('a', { paths: [] })).toHaveLength(1);
    expect(tracePathScheduleParamErrors('a', { paths: [{ publicKey: K('a'), intervalMinutes: 10 }] })).toEqual([]);
    expect(tracePathScheduleParamErrors('a', { paths: [
      { publicKey: K('a'), intervalMinutes: 10 }, { publicKey: K('A'), intervalMinutes: 60 },
    ] }).join()).toMatch(/listed twice/);
    const many = Array.from({ length: TRACE_SCHEDULE_MAX_PATHS + 1 }, (_, i) => ({ publicKey: i.toString(16).padStart(64, '0'), intervalMinutes: 10 }));
    expect(tracePathScheduleParamErrors('a', { paths: many }).join()).toMatch(/at most/);
  });

  it('the graph validator refuses an interval under the floor', () => {
    const graph = (intervalMinutes: number) => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '* * * * *' } },
        { id: 'a', type: 'action.tracePathSchedule', params: { paths: [{ publicKey: K('a'), intervalMinutes }], sourceIds: ['mc'] } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(validateAutomationGraph(graph(10)).valid).toBe(true);
    const bad = validateAutomationGraph(graph(5));
    expect(bad.valid).toBe(false);
    expect(bad.errors.join()).toMatch(/intervalMinutes/);
  });
});

describe('rewidthPathHops (#5723)', () => {
  const keys = ['a3f2' + '0'.repeat(60), '7f01' + '0'.repeat(60), '7fee' + '0'.repeat(60)];

  it('narrows by truncating and leaves a matching width alone', () => {
    expect(rewidthPathHops(['a3f2', '7f01'], 1, keys)).toEqual(['a3', '7f']);
    expect(rewidthPathHops(['a3', '7f'], 1, keys)).toEqual(['a3', '7f']);
  });

  it('widens only when every hop matches exactly one contact', () => {
    expect(rewidthPathHops(['a3'], 2, keys)).toEqual(['a3f2']);
    expect(rewidthPathHops(['a3', '7f'], 2, keys)).toBeNull(); // 7f is shared by two contacts
    expect(rewidthPathHops(['ee'], 2, keys)).toBeNull();        // unknown hop
  });
});
