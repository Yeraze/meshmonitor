import { describe, it, expect } from 'vitest';
import { findSplitTimerTooFrequent, findTimerTooManyChannels } from './timerSplitGuard.js';

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
  it('reads a Meshtastic timer (cron, no scheduleType) as cron (#6330)', () => {
    expect(findSplitTimerTooFrequent([{ id: 'm', multiline: true, cronExpression: '*/2 * * * *', responseType: 'text' }])).toEqual({ id: 'm', minutes: 2 });
    expect(findSplitTimerTooFrequent([{ id: 'm', multiline: true, cronExpression: '0 * * * *', responseType: 'script' }])).toBeUndefined();
    expect(findSplitTimerTooFrequent([{ id: 'm', cronExpression: '* * * * *', responseType: 'text' }])).toBeUndefined();
  });
});

describe('findTimerTooManyChannels (4.17.3 review M5)', () => {
  it('flags a channel timer with more than 4 distinct channels', () => {
    expect(findTimerTooManyChannels([{ id: 'a', channelIndexes: [0, 1, 2, 3, 4] }])).toEqual({ id: 'a', channels: 5 });
  });
  it('allows 4 channels, duplicates, and DM timers', () => {
    expect(findTimerTooManyChannels([
      { id: 'a', channelIndexes: [0, 1, 2, 3] },
      { id: 'b', channelIndexes: [0, 0, 1, 1, 2] },
      { id: 'c', destination: 'dm', channelIndexes: [0, 1, 2, 3, 4] },
      { id: 'd', channelIndex: 7 },
      null,
    ])).toBeUndefined();
  });
});
