/**
 * @vitest-environment jsdom
 *
 * #5100: the GPIO Pin Usage sidebar is sticky beside a sticky, opaque
 * `.section-nav`, so its offset has to clear the nav as well as the fixed bar.
 * The nav is a wrapping chip row, so no constant describes its height and the
 * shell measures it.
 *
 * jsdom has no layout, so these tests drive `publishSectionNavHeight` directly —
 * the rounding and clear-on-zero rules are the whole of the logic, and both
 * decide whether the panel lands under the nav or clear of it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SECTION_NAV_HEIGHT_VAR, publishSectionNavHeight } from './useSectionNavHeightVar';

describe('publishSectionNavHeight (#5100)', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
  });

  it('publishes a measured height in px', () => {
    publishSectionNavHeight(root, 132);
    expect(root.style.getPropertyValue(SECTION_NAV_HEIGHT_VAR)).toBe('132px');
  });

  it('rounds a fractional height UP', () => {
    // Down-rounding leaves a sliver of the panel under the nav — the exact
    // symptom. Device pixel ratios routinely produce fractional heights.
    publishSectionNavHeight(root, 131.2);
    expect(root.style.getPropertyValue(SECTION_NAV_HEIGHT_VAR)).toBe('132px');
  });

  it('clears the variable rather than publishing zero', () => {
    // getBoundingClientRect reports 0 for a display:none element or one read
    // before first layout. Consumers fall back to 0px, which is the same
    // "below the header only" offset they had before this existed.
    publishSectionNavHeight(root, 132);
    publishSectionNavHeight(root, 0);
    expect(root.style.getPropertyValue(SECTION_NAV_HEIGHT_VAR)).toBe('');
  });

  it('ignores a non-finite measurement', () => {
    publishSectionNavHeight(root, 132);
    publishSectionNavHeight(root, Number.NaN);
    expect(root.style.getPropertyValue(SECTION_NAV_HEIGHT_VAR)).toBe('');
  });

  it('overwrites a previous value when the chip row re-wraps', () => {
    // Widening the window drops a chip row. The panel below has to move up with
    // it, which is the point of measuring rather than constanting.
    publishSectionNavHeight(root, 132);
    publishSectionNavHeight(root, 88);
    expect(root.style.getPropertyValue(SECTION_NAV_HEIGHT_VAR)).toBe('88px');
  });
});
