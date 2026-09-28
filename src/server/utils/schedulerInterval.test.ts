import { describe, it, expect, vi } from 'vitest';

const warn = vi.fn();
vi.mock('../../utils/logger.js', () => ({ logger: { warn: (...a: unknown[]) => warn(...a), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  AUTO_ANNOUNCE_HOURS,
  clampIntervalSetting,
  DISTANCE_DELETE_HOURS,
  GEOFENCE_WHILE_INSIDE_MINUTES,
  MAX_TIMER_DELAY_MS,
  MESHCORE_AUTO_ANNOUNCE_HOURS,
  MESHCORE_PATHFINDING_INTERVAL_MINUTES,
  MESHCORE_PATHFINDING_REPEAT_HOURS,
  NODEINFO_BROADCAST_DELAY_SECONDS,
  REMOTE_ADMIN_SCANNER_MINUTES,
  TIME_SYNC_MINUTES,
  type IntervalRange,
} from './schedulerInterval.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('clampIntervalSetting', () => {
  it('passes an in-range value through without warning', () => {
    warn.mockClear();
    expect(clampIntervalSetting(30, { min: 1, max: 60 }, 'x')).toBe(30);
    expect(warn).not.toHaveBeenCalled();
  });

  it('clamps high and low with a warning', () => {
    warn.mockClear();
    expect(clampIntervalSetting(999999, GEOFENCE_WHILE_INSIDE_MINUTES, 'geo')).toBe(1440);
    expect(clampIntervalSetting(0, GEOFENCE_WHILE_INSIDE_MINUTES, 'geo')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('999999');
  });

  it('falls back on NaN', () => {
    expect(clampIntervalSetting(NaN, AUTO_ANNOUNCE_HOURS, 'a', 6)).toBe(6);
    expect(clampIntervalSetting(NaN, AUTO_ANNOUNCE_HOURS, 'a')).toBe(3);
    expect(clampIntervalSetting(Infinity, AUTO_ANNOUNCE_HOURS, 'a')).toBe(3);
  });

  // Every range's ceiling, in milliseconds, must fit a Node timer.
  it.each<[string, IntervalRange, number]>([
    ['geofence minutes', GEOFENCE_WHILE_INSIDE_MINUTES, MIN],
    ['auto-announce hours', AUTO_ANNOUNCE_HOURS, HOUR],
    ['nodeinfo delay seconds', NODEINFO_BROADCAST_DELAY_SECONDS, 1000],
    ['remote admin minutes', REMOTE_ADMIN_SCANNER_MINUTES, MIN],
    ['time sync minutes', TIME_SYNC_MINUTES, MIN],
    ['distance delete hours', DISTANCE_DELETE_HOURS, HOUR],
    ['meshcore announce hours', MESHCORE_AUTO_ANNOUNCE_HOURS, HOUR],
    ['meshcore pathfinding minutes', MESHCORE_PATHFINDING_INTERVAL_MINUTES, MIN],
    ['meshcore pathfinding hours', MESHCORE_PATHFINDING_REPEAT_HOURS, HOUR],
  ])('%s ceiling stays under the timer limit', (_name, range, unit) => {
    expect(range.min).toBeGreaterThan(0);
    expect(range.max * unit).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  });
});
