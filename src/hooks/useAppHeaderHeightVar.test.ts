/**
 * @vitest-environment jsdom
 *
 * #5070 / #5053: the CSS fallback for `--app-header-height` cannot describe a
 * `height: auto` bar, so the shell measures the real one and publishes it.
 *
 * jsdom has no layout, so these tests drive `publishAppHeaderHeight` directly —
 * the rounding and clear-on-zero rules are the whole of the logic, and both
 * decide whether content lands under the bar or clear of it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { APP_HEADER_HEIGHT_VAR, publishAppHeaderHeight } from './useAppHeaderHeightVar';

describe('publishAppHeaderHeight (#5070)', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
  });

  it('publishes a measured height in px', () => {
    publishAppHeaderHeight(root, 60);
    expect(root.style.getPropertyValue(APP_HEADER_HEIGHT_VAR)).toBe('60px');
  });

  it('rounds a fractional height UP', () => {
    // Down-rounding leaves a sliver of content under the bar — the exact
    // symptom. Device pixel ratios routinely produce 57.33px.
    publishAppHeaderHeight(root, 57.33);
    expect(root.style.getPropertyValue(APP_HEADER_HEIGHT_VAR)).toBe('58px');
  });

  it('falls back to the CSS expression rather than publishing zero', () => {
    // getBoundingClientRect reports 0 for a display:none element or one read
    // before first layout. Pinning the offset to 0 would slide every page up
    // under the bar.
    publishAppHeaderHeight(root, 60);
    publishAppHeaderHeight(root, 0);
    expect(root.style.getPropertyValue(APP_HEADER_HEIGHT_VAR)).toBe('');
  });

  it('ignores a non-finite measurement', () => {
    publishAppHeaderHeight(root, 60);
    publishAppHeaderHeight(root, Number.NaN);
    expect(root.style.getPropertyValue(APP_HEADER_HEIGHT_VAR)).toBe('');
  });

  it('overwrites a previous value when the bar changes size', () => {
    // A rotation, or the header contents being compacted, must move every
    // offset with it — that is the point of measuring rather than constanting.
    publishAppHeaderHeight(root, 60);
    publishAppHeaderHeight(root, 41);
    expect(root.style.getPropertyValue(APP_HEADER_HEIGHT_VAR)).toBe('41px');
  });
});
