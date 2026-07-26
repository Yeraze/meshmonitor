/**
 * The Map view's node list is drag-resizable, but its ceiling was a flat
 * `innerWidth * 0.5` on every viewport. On a phone that stops the list — the
 * pane you are actually reading, with the map behind a toggle — at half the
 * screen, and on a narrow phone the ceiling fell below the floor.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveNodeSidebarMaxWidth,
  isMobileLayout,
  MOBILE_BREAKPOINT_PX,
  MOBILE_LANDSCAPE_MAX_HEIGHT_PX,
  NODE_SIDEBAR_MIN_WIDTH_PX,
} from './sidebarWidth';

describe('isMobileLayout', () => {
  it.each([
    ['iPhone SE portrait', 375, 667],
    ['iPhone 14 portrait', 390, 844],
    ['Pixel portrait', 412, 915],
    ['iPad portrait (at the breakpoint)', MOBILE_BREAKPOINT_PX, 1024],
  ])('%s (%ix%i) is mobile via the width rule', (_l, w, h) => {
    expect(isMobileLayout(w, h)).toBe(true);
  });

  it.each([
    ['iPhone 14 landscape', 844, 390],
    ['iPhone SE landscape', 667, 375],
    ['landscape at the height limit', 900, MOBILE_LANDSCAPE_MAX_HEIGHT_PX],
  ])('%s (%ix%i) is mobile via the landscape rule', (_l, w, h) => {
    // This is the case a width-only test misclassifies: 844 > 768, yet App.css
    // still collapses the rail to 48px, so it IS the mobile layout.
    expect(isMobileLayout(w, h)).toBe(true);
  });

  it.each([
    ['1080p desktop', 1920, 1080],
    ['laptop', 1366, 768],
    ['small desktop window', 1000, 700],
    ['tall narrow-ish desktop', 1200, 1000],
  ])('%s (%ix%i) is NOT mobile', (_l, w, h) => {
    expect(isMobileLayout(w, h)).toBe(false);
  });

  it('treats a wide, short viewport as mobile landscape', () => {
    expect(isMobileLayout(900, 480)).toBe(true);
  });

  it('falls back to the width rule for a narrow, short viewport', () => {
    // Reaches `true` via `width <= 768`, not via the landscape branch.
    expect(isMobileLayout(480, 400)).toBe(true);
  });

  it('is not mobile for a large square viewport', () => {
    // Square counts as landscape per the CSS, but 1000px height is far past
    // the 500px limit, so the landscape branch does not apply.
    expect(isMobileLayout(1000, 1000)).toBe(false);
  });

  it('matches the CSS treatment of a square viewport as landscape', () => {
    // `orientation: landscape` fires at width === height. Unreachable in
    // practice (a square under the 500px height limit is also under the 768px
    // width rule), but pinned so the "mirrors the CSS" claim stays honest.
    expect(isMobileLayout(400, 400)).toBe(true);
  });
});

describe('resolveNodeSidebarMaxWidth', () => {
  describe('mobile gets the full container width', () => {
    it.each([
      ['iPhone SE portrait', 375 - 48],
      ['iPhone 14 portrait', 390 - 48],
      ['iPhone 14 landscape', 844 - 48],
      ['small tablet portrait', 600],
    ])('%s (%ipx container) → the whole container', (_label, available) => {
      expect(resolveNodeSidebarMaxWidth(available, true)).toBe(available);
    });

    it('is the regression: the old half-width rule capped a phone well short', () => {
      const available = 390 - 48; // 342
      const oldCap = Math.round(available * 0.5); // 171
      expect(resolveNodeSidebarMaxWidth(available, true)).toBeGreaterThan(oldCap);
      expect(resolveNodeSidebarMaxWidth(available, true)).toBe(available);
    });

    it('never returns a max below the min, even for a container under the floor', () => {
      // The old rule produced max=195 < min=200 on a 390px viewport, which
      // pinned the list to exactly one width regardless of drag.
      expect(resolveNodeSidebarMaxWidth(150, true)).toBe(NODE_SIDEBAR_MIN_WIDTH_PX);
      expect(resolveNodeSidebarMaxWidth(NODE_SIDEBAR_MIN_WIDTH_PX, true)).toBe(NODE_SIDEBAR_MIN_WIDTH_PX);
    });
  });

  describe('desktop keeps the 50% split', () => {
    it.each([
      [770, 385],
      [1280 - 60, 610],
      [1920 - 60, 930],
    ])('%ipx container → %ipx', (available, expected) => {
      expect(resolveNodeSidebarMaxWidth(available, false)).toBe(expected);
    });

    it('does not regress desktop: the map always keeps at least half the area', () => {
      const available = 1465;
      expect(resolveNodeSidebarMaxWidth(available, false)).toBeLessThanOrEqual(available / 2 + 1);
    });
  });

  describe('degenerate inputs', () => {
    it.each([0, -100, NaN, Infinity])('%p falls back to the min rather than junk', (v) => {
      expect(resolveNodeSidebarMaxWidth(v, true)).toBe(NODE_SIDEBAR_MIN_WIDTH_PX);
      expect(resolveNodeSidebarMaxWidth(v, false)).toBe(NODE_SIDEBAR_MIN_WIDTH_PX);
    });
  });
});
