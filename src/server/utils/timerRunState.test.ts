import { describe, it, expect } from 'vitest';
import { keepServerRunState, parseStoredTriggers } from './timerRunState.js';

describe('keepServerRunState (#5827)', () => {
  it('takes run state from the stored trigger with the same id', () => {
    const out = keepServerRunState(
      [{ id: 'a', name: 'edited', lastRun: 1, lastResult: 'success' }],
      [{ id: 'a', name: 'old', lastRun: 5, lastResult: 'error', lastError: 'boom' }],
    );
    expect(out).toEqual([{ id: 'a', name: 'edited', lastRun: 5, lastResult: 'error', lastError: 'boom' }]);
  });

  it('drops client run state for a trigger the server has never seen', () => {
    expect(keepServerRunState([{ id: 'b', lastRun: 9, lastError: 'x' }], [])).toEqual([{ id: 'b' }]);
  });

  it('clears a stale lastError when the stored trigger has none', () => {
    const out = keepServerRunState([{ id: 'a', lastError: 'old' }], [{ id: 'a', lastRun: 3, lastResult: 'success' }]);
    expect(out).toEqual([{ id: 'a', lastRun: 3, lastResult: 'success' }]);
  });

  it('leaves the rest of each trigger untouched', () => {
    const t = { id: 'a', name: 'n', cronExpression: '* * * * *', enabled: false };
    expect(keepServerRunState([t], null)).toEqual([t]);
  });

  it('parseStoredTriggers treats bad input as empty', () => {
    expect(parseStoredTriggers(null)).toEqual([]);
    expect(parseStoredTriggers('not json')).toEqual([]);
    expect(parseStoredTriggers('{"a":1}')).toEqual([]);
    expect(parseStoredTriggers('[{"id":"a"}]')).toEqual([{ id: 'a' }]);
  });
});
