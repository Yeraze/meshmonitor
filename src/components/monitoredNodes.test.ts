import { describe, it, expect } from 'vitest';
import {
  reconcileMonitoredNodes,
  selectAllMonitoredNodes,
  deselectAllMonitoredNodes,
} from './monitoredNodes';

// Regression tests for issue #3486: stale per-source node IDs (saved under
// another source / for deleted nodes) lingered in the monitored-nodes selection
// because the picker only ever operates on the current source's visible list.

describe('reconcileMonitoredNodes', () => {
  it('drops IDs that do not resolve under the active source', () => {
    const selected = ['!aaaa1111', '!bbbb2222', '!cccc3333'];
    const available = ['!aaaa1111', '!cccc3333']; // bbbb is stale
    expect(reconcileMonitoredNodes(selected, available)).toEqual(['!aaaa1111', '!cccc3333']);
  });

  it('removes ALL stale IDs when none resolve (the "11 stuck" case)', () => {
    const selected = Array.from({ length: 11 }, (_, i) => `!stale${i}`);
    expect(reconcileMonitoredNodes(selected, ['!real1', '!real2'])).toEqual([]);
  });

  it('keeps everything when all IDs resolve', () => {
    const selected = ['!a', '!b'];
    expect(reconcileMonitoredNodes(selected, new Set(['!a', '!b', '!c']))).toEqual(['!a', '!b']);
  });

  it('accepts a Set or any iterable for availableIds', () => {
    expect(reconcileMonitoredNodes(['!a', '!x'], new Set(['!a']))).toEqual(['!a']);
  });
});

describe('selectAllMonitoredNodes', () => {
  const available = ['!a', '!b', '!c'];

  it('no search: selects the entire current source (replace), ignoring stale prior selection', () => {
    const result = selectAllMonitoredNodes(['!stale'], available, available, false);
    expect(result.sort()).toEqual(['!a', '!b', '!c']);
    expect(result).not.toContain('!stale');
  });

  it('search active: adds only the filtered subset to the existing selection', () => {
    const result = selectAllMonitoredNodes(['!a'], available, ['!b'], true);
    expect(result.sort()).toEqual(['!a', '!b']);
  });

  it('search active: does not duplicate already-selected IDs', () => {
    const result = selectAllMonitoredNodes(['!a', '!b'], available, ['!b', '!c'], true);
    expect(result.sort()).toEqual(['!a', '!b', '!c']);
  });
});

describe('deselectAllMonitoredNodes', () => {
  it('no search: clears the entire selection including stale IDs (#3486 fix)', () => {
    expect(deselectAllMonitoredNodes(['!a', '!b', '!stale'], ['!a', '!b'], false)).toEqual([]);
  });

  it('search active: removes only the filtered subset, leaving the rest', () => {
    const result = deselectAllMonitoredNodes(['!a', '!b', '!c'], ['!b'], true);
    expect(result.sort()).toEqual(['!a', '!c']);
  });

  it('search active: leaves stale (non-visible) IDs untouched', () => {
    // While filtering, deselect-all must not silently wipe IDs outside the filter.
    const result = deselectAllMonitoredNodes(['!a', '!stale'], ['!a'], true);
    expect(result).toEqual(['!stale']);
  });
});
