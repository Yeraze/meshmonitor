/**
 * @vitest-environment jsdom
 *
 * #5578: the shared "latest advert had no position" helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HIDE_POSITIONLESS_ADVERT_STORAGE_KEY,
  advertHasPosition,
  isHiddenByPositionlessAdvert,
  readHidePositionlessAdverts,
  writeHidePositionlessAdverts,
} from './meshcoreAdvertPosition';

describe('advertHasPosition', () => {
  it('is true for a real coordinate pair', () => {
    expect(advertHasPosition(45.5, -75.5)).toBe(true);
  });

  it('is false when either coordinate is absent', () => {
    expect(advertHasPosition(undefined, undefined)).toBe(false);
    expect(advertHasPosition(null, null)).toBe(false);
    expect(advertHasPosition(45.5, undefined)).toBe(false);
  });

  it('treats the firmware 0/0 "no position" value as no position', () => {
    expect(advertHasPosition(0, 0)).toBe(false);
  });

  it('is false for out-of-range or non-finite junk', () => {
    expect(advertHasPosition(1853.45, -1598.75)).toBe(false);
    expect(advertHasPosition(Number.NaN, 10)).toBe(false);
  });
});

describe('isHiddenByPositionlessAdvert', () => {
  it('never hides while the toggle is off', () => {
    expect(isHiddenByPositionlessAdvert({ lastAdvertHadPosition: false }, false)).toBe(false);
  });

  it('hides a node whose latest advert had no position', () => {
    expect(isHiddenByPositionlessAdvert({ lastAdvertHadPosition: false }, true)).toBe(true);
    expect(isHiddenByPositionlessAdvert({ lastAdvertHadPosition: false, positionSource: 'contact' }, true)).toBe(true);
  });

  it('shows a node whose latest advert had a position', () => {
    expect(isHiddenByPositionlessAdvert({ lastAdvertHadPosition: true }, true)).toBe(false);
  });

  it('shows unknown (null / undefined / missing node)', () => {
    expect(isHiddenByPositionlessAdvert({ lastAdvertHadPosition: null }, true)).toBe(false);
    expect(isHiddenByPositionlessAdvert({}, true)).toBe(false);
    expect(isHiddenByPositionlessAdvert(null, true)).toBe(false);
    expect(isHiddenByPositionlessAdvert(undefined, true)).toBe(false);
  });

  it('never hides a telemetry-sourced position', () => {
    expect(isHiddenByPositionlessAdvert({ lastAdvertHadPosition: false, positionSource: 'telemetry' }, true)).toBe(false);
  });
});

describe('hide toggle persistence', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to off', () => {
    expect(readHidePositionlessAdverts()).toBe(false);
  });

  it('round-trips through localStorage under the meshcore key family', () => {
    writeHidePositionlessAdverts(true);
    expect(localStorage.getItem(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY)).toBe('true');
    expect(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY.startsWith('meshmonitor-meshcore-')).toBe(true);
    expect(readHidePositionlessAdverts()).toBe(true);
    writeHidePositionlessAdverts(false);
    expect(readHidePositionlessAdverts()).toBe(false);
  });
});
