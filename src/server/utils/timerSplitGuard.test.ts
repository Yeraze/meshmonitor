import { describe, it, expect } from 'vitest';
import { findSplitTimerTooFrequent } from './timerSplitGuard.js';

describe('findSplitTimerTooFrequent', () => {
  it('flags a split interval timer under 5 minutes', () => {
    expect(findSplitTimerTooFrequent([{ id: 'a', multiline: true, scheduleType: 'interval', intervalMinutes: 4, responseType: 'text' }])).toEqual({ id: 'a', minutes: 4 });
  });
  it('allows 5 minutes and non-split timers', () => {
    expect(findSplitTimerTooFrequent([
      { id: 'a', multiline: true, scheduleType: 'interval', intervalMinutes: 5, responseType: 'text' },
      { id: 'b', scheduleType: 'interval', intervalMinutes: 1, responseType: 'text' },
      { id: 'c', multiline: true, scheduleType: 'interval', intervalMinutes: 1, responseType: 'advert' },
    ])).toBeUndefined();
  });
  it('flags a fast cron and allows a slow one', () => {
    expect(findSplitTimerTooFrequent([{ id: 'a', multiline: true, scheduleType: 'cron', cronExpression: '* * * * *', responseType: 'text' }])?.id).toBe('a');
    expect(findSplitTimerTooFrequent([{ id: 'a', multiline: true, scheduleType: 'cron', cronExpression: '*/10 * * * *', responseType: 'text' }])).toBeUndefined();
  });
});
