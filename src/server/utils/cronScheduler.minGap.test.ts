import { describe, expect, it } from 'vitest';
import { cronMinGapMs } from './cronScheduler.js';

const MIN = 60_000;

describe('cronMinGapMs', () => {
  it('measures an even interval', () => {
    expect(cronMinGapMs('*/5 * * * *')).toBe(5 * MIN);
    expect(cronMinGapMs('*/30 * * * *')).toBe(30 * MIN);
    expect(cronMinGapMs('0 * * * *')).toBe(60 * MIN);
    expect(cronMinGapMs('* * * * *')).toBe(MIN);
  });

  it('finds the shortest gap in an uneven pattern', () => {
    // Twice a day, one minute apart.
    expect(cronMinGapMs('0,1 8 * * *')).toBe(MIN);
    // Fine most of the hour, then two fires 2 minutes apart.
    expect(cronMinGapMs('0,30,32 * * * *')).toBe(2 * MIN);
    // A range inside one hour of one day.
    expect(cronMinGapMs('*/30 8-11 3 10 *')).toBe(30 * MIN);
  });

  it('reads a seconds-level cron', () => {
    expect(cronMinGapMs('*/10 * * * * *')).toBe(10_000);
  });

  it('returns null for an invalid cron', () => {
    expect(cronMinGapMs('not a cron')).toBeNull();
  });

  it('the result does not depend on the time zone', () => {
    expect(cronMinGapMs('*/15 * * * *', { timezone: 'Asia/Kolkata' })).toBe(15 * MIN);
  });
});
