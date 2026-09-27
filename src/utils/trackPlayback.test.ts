import { describe, it, expect, beforeEach } from 'vitest';
import {
  indexAtOrBefore,
  positionAt,
  timelineGaps,
  fixesUpTo,
  nextFixTime,
  previousFixTime,
  nearestFixIndex,
  isOutsideCentralRegion,
  readStoredPlaybackSpeed,
  writeStoredPlaybackSpeed,
  PLAYBACK_SPEED_STORAGE_KEY,
  DEFAULT_PLAYBACK_SPEED,
  type PlaybackFix,
} from './trackPlayback';

const fix = (timestamp: number, latitude: number, longitude: number, segmentStart?: boolean): PlaybackFix =>
  segmentStart ? { timestamp, latitude, longitude, segmentStart } : { timestamp, latitude, longitude };

// Two segments: 0..2000 then a gap, then 10000..11000.
const track: PlaybackFix[] = [
  fix(0, 0, 0),
  fix(1000, 10, 20),
  fix(2000, 20, 20),
  fix(10000, 50, 50, true),
  fix(11000, 60, 50),
];

describe('indexAtOrBefore', () => {
  it('returns -1 before the first fix and for an empty track', () => {
    expect(indexAtOrBefore(track, -1)).toBe(-1);
    expect(indexAtOrBefore([], 5)).toBe(-1);
  });

  it('returns the exact index on a fix and the one before between fixes', () => {
    expect(indexAtOrBefore(track, 0)).toBe(0);
    expect(indexAtOrBefore(track, 1000)).toBe(1);
    expect(indexAtOrBefore(track, 1999)).toBe(1);
    expect(indexAtOrBefore(track, 5000)).toBe(2);
  });

  it('returns the last index after the end', () => {
    expect(indexAtOrBefore(track, 99999)).toBe(4);
  });

  it('picks the last of a run of equal timestamps', () => {
    const dup = [fix(0, 0, 0), fix(5, 1, 1), fix(5, 2, 2), fix(9, 3, 3)];
    expect(indexAtOrBefore(dup, 5)).toBe(2);
  });

  it('handles a single fix', () => {
    const one = [fix(100, 1, 1)];
    expect(indexAtOrBefore(one, 99)).toBe(-1);
    expect(indexAtOrBefore(one, 100)).toBe(0);
  });
});

describe('positionAt', () => {
  it('returns null for an empty track', () => {
    expect(positionAt([], 0)).toBeNull();
  });

  it('interpolates linearly by time inside a segment', () => {
    expect(positionAt(track, 500)).toEqual({ lat: 5, lon: 10, index: 0, inGap: false });
    expect(positionAt(track, 1250)).toEqual({ lat: 12.5, lon: 20, index: 1, inGap: false });
  });

  it('lands exactly on a fix', () => {
    expect(positionAt(track, 1000)).toEqual({ lat: 10, lon: 20, index: 1, inGap: false });
  });

  it('clamps before the first and after the last fix', () => {
    expect(positionAt(track, -500)).toEqual({ lat: 0, lon: 0, index: 0, inGap: false });
    expect(positionAt(track, 50000)).toEqual({ lat: 60, lon: 50, index: 4, inGap: false });
  });

  it('holds at the last fix of the previous segment inside a gap, and flags it', () => {
    expect(positionAt(track, 6000)).toEqual({ lat: 20, lon: 20, index: 2, inGap: true });
  });

  it('is at the next segment start once the gap ends', () => {
    expect(positionAt(track, 10000)).toEqual({ lat: 50, lon: 50, index: 3, inGap: false });
  });
});

describe('timelineGaps', () => {
  it('returns one range per segment boundary', () => {
    expect(timelineGaps(track)).toEqual([{ start: 2000, end: 10000 }]);
  });

  it('ignores a segmentStart on the first fix (the filter cut the track there)', () => {
    expect(timelineGaps([fix(0, 0, 0, true), fix(1, 1, 1)])).toEqual([]);
  });

  it('returns nothing for a gapless or empty track', () => {
    expect(timelineGaps(track.slice(0, 3))).toEqual([]);
    expect(timelineGaps([])).toEqual([]);
  });
});

describe('fixesUpTo', () => {
  it('keeps fixes at or before the cursor', () => {
    expect(fixesUpTo(track, 1000).map(f => f.timestamp)).toEqual([0, 1000]);
    expect(fixesUpTo(track, -1)).toEqual([]);
  });

  it('returns the input untouched for a null cursor', () => {
    expect(fixesUpTo(track, null)).toBe(track);
  });
});

describe('step helpers', () => {
  it('nextFixTime moves to the next fix, or stays at the end', () => {
    expect(nextFixTime(track, 0)).toBe(1000);
    expect(nextFixTime(track, 1500)).toBe(2000);
    expect(nextFixTime(track, -10)).toBe(0);
    expect(nextFixTime(track, 11000)).toBe(11000);
  });

  it('previousFixTime moves to the fix strictly before, or stays at the start', () => {
    expect(previousFixTime(track, 1000)).toBe(0);
    expect(previousFixTime(track, 1000.5)).toBe(1000);
    expect(previousFixTime(track, 6000)).toBe(2000);
    expect(previousFixTime(track, 0)).toBe(0);
  });

  it('nearestFixIndex picks the closer fix', () => {
    expect(nearestFixIndex(track, 400)).toBe(0);
    expect(nearestFixIndex(track, 600)).toBe(1);
    expect(nearestFixIndex(track, -5)).toBe(0);
    expect(nearestFixIndex(track, 99999)).toBe(4);
    expect(nearestFixIndex([], 1)).toBe(-1);
  });
});

describe('isOutsideCentralRegion', () => {
  const size = { x: 1000, y: 500 };
  it('is false in the middle 70 %', () => {
    expect(isOutsideCentralRegion({ x: 500, y: 250 }, size)).toBe(false);
    expect(isOutsideCentralRegion({ x: 151, y: 76 }, size)).toBe(false);
  });
  it('is true near any edge', () => {
    expect(isOutsideCentralRegion({ x: 100, y: 250 }, size)).toBe(true);
    expect(isOutsideCentralRegion({ x: 900, y: 250 }, size)).toBe(true);
    expect(isOutsideCentralRegion({ x: 500, y: 50 }, size)).toBe(true);
    expect(isOutsideCentralRegion({ x: 500, y: 480 }, size)).toBe(true);
  });
});

describe('stored playback speed', () => {
  beforeEach(() => localStorage.removeItem(PLAYBACK_SPEED_STORAGE_KEY));

  it('round-trips a valid speed', () => {
    writeStoredPlaybackSpeed(3600);
    expect(readStoredPlaybackSpeed()).toBe(3600);
  });

  it('falls back to the default for missing or invalid values', () => {
    expect(readStoredPlaybackSpeed()).toBe(DEFAULT_PLAYBACK_SPEED);
    localStorage.setItem(PLAYBACK_SPEED_STORAGE_KEY, '42');
    expect(readStoredPlaybackSpeed()).toBe(DEFAULT_PLAYBACK_SPEED);
  });
});
