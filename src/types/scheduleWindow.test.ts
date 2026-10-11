import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  readScheduleWindow,
  scheduleHasEnded,
  zonedWallTimeToEpochMs,
  SCHEDULE_MIN_INTERVAL_MS,
} from './scheduleWindow';

describe('zonedWallTimeToEpochMs', () => {
  it('reads a wall-clock time in its zone', () => {
    expect(zonedWallTimeToEpochMs('2026-10-03T08:00', 'UTC')).toBe(Date.UTC(2026, 9, 3, 8, 0));
    // New York is UTC-4 in October (daylight time) and UTC-5 in January.
    expect(zonedWallTimeToEpochMs('2026-10-03T08:00', 'America/New_York')).toBe(Date.UTC(2026, 9, 3, 12, 0));
    expect(zonedWallTimeToEpochMs('2026-01-15T08:00', 'America/New_York')).toBe(Date.UTC(2026, 0, 15, 13, 0));
    // A zone ahead of UTC with a half-hour offset.
    expect(zonedWallTimeToEpochMs('2026-10-03T08:00', 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 3, 2, 30));
  });

  it('handles the day a zone changes its offset', () => {
    // US clocks go back at 02:00 on 2026-11-01; 12:00 that day is UTC-5.
    expect(zonedWallTimeToEpochMs('2026-11-01T12:00', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 17, 0));
    // Clocks go forward on 2026-03-08; 12:00 that day is UTC-4.
    expect(zonedWallTimeToEpochMs('2026-03-08T12:00', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 16, 0));
  });

  it('rejects junk, impossible dates and unknown zones', () => {
    expect(zonedWallTimeToEpochMs('sample', 'UTC')).toBeNull();
    expect(zonedWallTimeToEpochMs('2026-02-31T08:00', 'UTC')).toBeNull();
    expect(zonedWallTimeToEpochMs('2026-10-03T25:00', 'UTC')).toBeNull();
    expect(zonedWallTimeToEpochMs('2026-10-03T08:00', 'Mars/Olympus')).toBeNull();
  });
});

describe('readScheduleWindow', () => {
  it('a rule with no dates has no window and no errors', () => {
    expect(readScheduleWindow({ cron: '0 * * * *' })).toEqual({ timeZone: null, startMs: null, endMs: null, errors: [] });
    expect(readScheduleWindow(undefined).errors).toEqual([]);
  });

  it('a time zone alone is valid: it only moves the cron', () => {
    expect(readScheduleWindow({ timezone: 'Europe/Berlin' })).toEqual({ timeZone: 'Europe/Berlin', startMs: null, endMs: null, errors: [] });
  });

  it('reads start and end', () => {
    const w = readScheduleWindow({ startAt: '2026-10-03T08:00', endAt: '2026-10-03T12:00', timezone: 'UTC' });
    expect(w.errors).toEqual([]);
    expect(w.startMs).toBe(Date.UTC(2026, 9, 3, 8, 0));
    expect(w.endMs).toBe(Date.UTC(2026, 9, 3, 12, 0));
  });

  it('reports each problem', () => {
    expect(readScheduleWindow({ startAt: '2026-10-03T08:00' }).errors).toEqual(['a start or end date needs a time zone']);
    expect(readScheduleWindow({ timezone: 'Nope/Zone' }).errors[0]).toMatch(/not a known IANA zone/);
    expect(readScheduleWindow({ startAt: 'soon', timezone: 'UTC' }).errors[0]).toMatch(/start "soon" is not a date/);
    expect(readScheduleWindow({ endAt: '2026-13-01T00:00', timezone: 'UTC' }).errors[0]).toMatch(/end .* is not a date/);
    expect(readScheduleWindow({ startAt: '2026-10-03T12:00', endAt: '2026-10-03T12:00', timezone: 'UTC' }).errors)
      .toEqual(['the end must be after the start']);
  });
});

describe('scheduleHasEnded', () => {
  const params = { endAt: '2026-10-03T12:00', timezone: 'UTC' };
  const end = Date.UTC(2026, 9, 3, 12, 0);

  it('is true at and after the end, false before it or with no end', () => {
    expect(scheduleHasEnded(params, end - 1)).toBe(false);
    expect(scheduleHasEnded(params, end)).toBe(true);
    expect(scheduleHasEnded({ cron: '0 * * * *' }, end)).toBe(false);
  });
});

describe('constants', () => {
  it('the minimum interval is 5 minutes', () => {
    expect(SCHEDULE_MIN_INTERVAL_MS).toBe(300_000);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone(' ')).toBe(false);
  });
});
