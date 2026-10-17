import { describe, it, expect } from 'vitest';
import { mergeNameHistory, NAME_HISTORY_MERGE_WINDOW_MS } from './nodeNameHistoryMerge.js';
import type { NodeNameHistoryRow } from '../../db/repositories/nodeNameHistory.js';

const row = (sourceId: string, from: string, to: string, changedAt: number): NodeNameHistoryRow => ({
  sourceId,
  protocol: 'meshtastic',
  nodeKey: '1',
  oldLongName: from,
  newLongName: to,
  oldShortName: null,
  newShortName: null,
  changedAt,
});

describe('mergeNameHistory (#5862)', () => {
  it('collapses one rename seen on several sources, keeping the earliest time', () => {
    const merged = mergeNameHistory([
      row('b', 'A', 'B', 5_000),
      row('a', 'A', 'B', 1_000),
      row('c', 'A', 'B', 1_000 + NAME_HISTORY_MERGE_WINDOW_MS),
    ]);
    expect(merged).toEqual([
      { oldLongName: 'A', newLongName: 'B', oldShortName: null, newShortName: null, changedAt: 1_000, sourceIds: ['a', 'b', 'c'] },
    ]);
  });

  it('keeps the same change twice when it happens again outside the window', () => {
    const merged = mergeNameHistory([
      row('a', 'A', 'B', 1_000),
      row('a', 'B', 'A', 2_000),
      row('a', 'A', 'B', 1_000 + NAME_HISTORY_MERGE_WINDOW_MS + 1),
    ]);
    expect(merged.map(e => [e.newLongName, e.changedAt])).toEqual([
      ['B', 1_000 + NAME_HISTORY_MERGE_WINDOW_MS + 1],
      ['A', 2_000],
      ['B', 1_000],
    ]);
  });

  it('returns nothing for no rows', () => {
    expect(mergeNameHistory([])).toEqual([]);
  });
});
