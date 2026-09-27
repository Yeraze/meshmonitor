/**
 * Asset trail segments on the client (#5354 Phase 2): flattening the
 * server's gap segments into the map's single history array, and knowing
 * which drawn pairs span a gap so no line joins them.
 */
import { describe, it, expect } from 'vitest';
import {
  flattenAssetTrack,
  segmentBreaks,
  downsamplePositionHistory,
  MAX_RENDERED_ASSET_POSITION_POINTS,
  MAX_RENDERED_POSITION_POINTS,
} from './positionHistoryDownsample';


const fix = (timestamp: number, segmentStart?: boolean) => ({
  latitude: 40,
  longitude: -75,
  timestamp,
  ...(segmentStart ? { segmentStart: true } : {}),
});

describe('flattenAssetTrack', () => {
  it('marks the first fix of every segment after the first', () => {
    const out = flattenAssetTrack([[fix(1), fix(2)], [fix(3), fix(4)], [fix(5)]]);
    expect(out.map((f) => f.timestamp)).toEqual([1, 2, 3, 4, 5]);
    expect(out.map((f) => f.segmentStart === true)).toEqual([false, false, true, false, true]);
  });

  it('handles no segments', () => {
    expect(flattenAssetTrack([])).toEqual([]);
  });
});

describe('segmentBreaks', () => {
  it('flags the pair that crosses a segment start', () => {
    const src = [fix(1), fix(2), fix(3, true), fix(4)];
    expect(segmentBreaks(src, src)).toEqual([false, true, false]);
  });

  it('still breaks a pair whose boundary fix was sampled away', () => {
    const src = [fix(1), fix(2), fix(3, true), fix(4), fix(5)];
    const rendered = [src[0], src[1], src[3], src[4]];
    expect(segmentBreaks(src, rendered)).toEqual([false, true, false]);
  });

  it('never breaks a history without markers (non-asset trail unchanged)', () => {
    const src = Array.from({ length: 50 }, (_, i) => fix(i));
    const rendered = downsamplePositionHistory(src, 10);
    expect(segmentBreaks(src, rendered).every((b) => !b)).toBe(true);
  });

  it('returns nothing for fewer than two points', () => {
    expect(segmentBreaks([fix(1)], [fix(1)])).toEqual([]);
  });

  it('draws a full 2,000-point asset track without resampling it', () => {
    const src = Array.from({ length: 2000 }, (_, i) => fix(i, i === 1000));
    const rendered = downsamplePositionHistory(src, MAX_RENDERED_ASSET_POSITION_POINTS);
    expect(rendered).toHaveLength(2000);
    expect(MAX_RENDERED_ASSET_POSITION_POINTS).toBeGreaterThan(MAX_RENDERED_POSITION_POINTS);
    expect(segmentBreaks(src, rendered).filter(Boolean)).toHaveLength(1);
  });
});
