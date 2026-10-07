import { describe, it, expect } from 'vitest';
import {
  floorKeepingZero,
  isIntervalBelowFloor,
  NODE_INFO_BROADCAST_FLOOR_SECS,
  POSITION_BROADCAST_FLOOR_SECS,
} from './broadcastIntervalFloor';

describe('broadcast interval floors', () => {
  it('holds the floors the UI names', () => {
    expect(POSITION_BROADCAST_FLOOR_SECS).toBe(32);
    expect(NODE_INFO_BROADCAST_FLOOR_SECS).toBe(3600);
  });

  it('a stored 0 is sent as 0', () => {
    expect(floorKeepingZero(0, POSITION_BROADCAST_FLOOR_SECS)).toBe(0);
    expect(floorKeepingZero(0, NODE_INFO_BROADCAST_FLOOR_SECS)).toBe(0);
  });

  it('any other value under the floor is still raised to it', () => {
    expect(floorKeepingZero(1, 32)).toBe(32);
    expect(floorKeepingZero(5, 32)).toBe(32);
    expect(floorKeepingZero(31, 32)).toBe(32);
    expect(floorKeepingZero(-1, 32)).toBe(32);
    expect(floorKeepingZero(3599, 3600)).toBe(3600);
  });

  it('a value at or over the floor is sent as typed', () => {
    expect(floorKeepingZero(32, 32)).toBe(32);
    expect(floorKeepingZero(900, 32)).toBe(900);
    expect(floorKeepingZero(10800, 3600)).toBe(10800);
  });

  it.each([1, 5, 31, -1, 31.5, 60.5, Number.NaN, 'abc', '5', true])('refuses %s', (value) => {
    expect(isIntervalBelowFloor(value, 32)).toBe(true);
  });

  it.each([0, '0', 32, '32', 900, undefined, null])('accepts %s', (value) => {
    expect(isIntervalBelowFloor(value, 32)).toBe(false);
  });
});
