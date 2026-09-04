/**
 * Regression tests for the MapSidebar small-screen sheet (#5060).
 *
 * Reported on v4.16.0-rc2: `MapSidebar.css` carried exactly one media query,
 * `@media (max-width: 768px)`. A phone in landscape is *wider* than 768px
 * (iPhone 13 → 844, Pixel 7 → 915), so the small-screen sheet never applied on
 * a rotated phone and the desktop base rule stood — a 300px panel floating
 * 10px off every edge of a pane only ~350px tall, sitting on top of a map that
 * on the Nodes split view is only ~464px wide to begin with.
 *
 * Same defect class as #5053 (`dashboard.css`) and #5054: a mobile-only block
 * gated on `max-width` alone silently switches off when the phone rotates.
 *
 * These tests run the real declarations through the shared cascade resolver and
 * assert the resolved geometry at concrete viewports, because that is the only
 * thing that distinguishes "the rule is in the file" from "the rule wins".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createResolver,
  mediaMatches,
  type Viewport,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  LANDSCAPE_BIG_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
} from './cssCascadeResolver';

const css = readFileSync(resolve('src/components/map/MapSidebar.css'), 'utf-8');
const resolve_ = createResolver(css);

const LANDSCAPE_VIEWPORTS: Array<[string, Viewport]> = [
  ['landscape phone', LANDSCAPE_PHONE],
  ['landscape big phone', LANDSCAPE_BIG_PHONE],
  ['landscape small phone', LANDSCAPE_SMALL_PHONE],
];

describe('MapSidebar small-screen sheet applies in landscape (#5060)', () => {
  it.each(LANDSCAPE_VIEWPORTS)('drops the floating inset on a %s', (_name, vp) => {
    // The bug in one assertion: the base rule's 10px inset survived rotation,
    // so the sheet never reached the edges of the map pane.
    expect(resolve_('.map-sidebar', 'top', vp)).toBe('0');
    expect(resolve_('.map-sidebar', 'bottom', vp)).toBe('0');
    expect(resolve_('.map-sidebar', 'right', vp)).toBe('0');
  });

  it.each(LANDSCAPE_VIEWPORTS)('anchors the sheet to the right edge on a %s', (_name, vp) => {
    // `left: auto` matters only where BOTH blocks match (the small landscape
    // phone), but asserting it everywhere pins the intent: this is a right-edge
    // sheet in landscape, never a full-bleed one.
    expect(resolve_('.map-sidebar', 'left', vp)).toBe('auto');
  });

  it.each(LANDSCAPE_VIEWPORTS)('keeps the map visible beside the sheet on a %s', (_name, vp) => {
    // The design call: a full sheet would hide the map entirely at 390px tall,
    // and these are controls whose effect you watch on the map. 60% is the cap
    // that guarantees at least 40% of the pane stays on screen.
    expect(resolve_('.map-sidebar', 'max-width', vp)).toBe('60%');
    // Width is not the scarce axis in landscape — the desktop column already
    // fits every control — so the sheet spends the win on height, not width.
    expect(resolve_('.map-sidebar', 'width', vp)).toBe('300px');
  });

  it('still gives portrait the full-pane sheet', () => {
    expect(resolve_('.map-sidebar', 'width', PORTRAIT_PHONE)).toBe('100%');
    expect(resolve_('.map-sidebar', 'max-width', PORTRAIT_PHONE)).toBe('100%');
    expect(resolve_('.map-sidebar', 'left', PORTRAIT_PHONE)).toBe('0');
  });

  it('leaves the desktop floating panel untouched', () => {
    expect(resolve_('.map-sidebar', 'top', DESKTOP)).toBe('10px');
    expect(resolve_('.map-sidebar', 'bottom', DESKTOP)).toBe('10px');
    expect(resolve_('.map-sidebar', 'width', DESKTOP)).toBe('300px');
    expect(resolve_('.map-sidebar', 'max-width', DESKTOP)).toBe('calc(100% - 20px)');
  });

  it('lets the landscape block win where both blocks match', () => {
    // An iPhone SE in landscape (667x375) is narrow AND short, so it matches
    // `max-width: 768px` and `(max-height: 500px) and (orientation: landscape)`
    // at equal specificity. Source order is the only tiebreak — the cascade
    // trap documented in src/styles/nodes.css (#3532). If someone moves the
    // landscape block above the portrait one, this fails.
    expect(mediaMatches('(max-width: 768px)', LANDSCAPE_SMALL_PHONE)).toBe(true);
    expect(
      mediaMatches('(max-height: 500px) and (orientation: landscape)', LANDSCAPE_SMALL_PHONE)
    ).toBe(true);
    expect(resolve_('.map-sidebar', 'max-width', LANDSCAPE_SMALL_PHONE)).toBe('60%');
    // ...and the border the portrait block erases is put back, so the sheet has
    // an edge against the map on every landscape phone, not just the wide ones.
    expect(resolve_('.map-sidebar', 'border-left', LANDSCAPE_SMALL_PHONE)).toBe(
      '1px solid var(--color-surface-hover)'
    );
    expect(resolve_('.map-sidebar', 'border-left', LANDSCAPE_PHONE)).toBe(
      '1px solid var(--color-surface-hover)'
    );
  });

  it('keeps the close affordance clear of a side notch in landscape', () => {
    // A rotated phone puts the cutout on one long edge; the sheet is flush to
    // the right one. Without the inset the ✕ can sit under it and eat the tap —
    // the reachability half of #5053/#5054.
    for (const [, vp] of LANDSCAPE_VIEWPORTS) {
      expect(resolve_('.map-sidebar-header', 'padding-right', vp)).toMatch(
        /env\(safe-area-inset-right/
      );
      expect(resolve_('.map-sidebar-toggle', 'right', vp)).toMatch(/env\(safe-area-inset-right/);
    }
    // Desktop keeps the plain values.
    expect(resolve_('.map-sidebar-toggle', 'right', DESKTOP)).toBe('10px');
  });

  it('holds the #5052 stacking order in every orientation', () => {
    // The z-index raise above Leaflet's control containers must survive the new
    // blocks — neither of them may reintroduce a lower value.
    const leafletCss = readFileSync(resolve('node_modules/leaflet/dist/leaflet.css'), 'utf-8');
    const controlZ = Number(
      leafletCss
        .match(/\.leaflet-top,\s*\n?\s*\.leaflet-bottom\s*\{([^}]*)\}/)?.[1]
        ?.match(/z-index:\s*(\d+)/)?.[1]
    );
    expect(controlZ).toBe(1000);
    for (const vp of [DESKTOP, PORTRAIT_PHONE, ...LANDSCAPE_VIEWPORTS.map(([, v]) => v)]) {
      expect(Number(resolve_('.map-sidebar', 'z-index', vp))).toBeGreaterThan(controlZ);
      expect(Number(resolve_('.map-sidebar-toggle', 'z-index', vp))).toBeGreaterThan(controlZ);
    }
  });
});

describe('MapSidebar JS and CSS agree on "mobile" (#5060)', () => {
  /**
   * The collapsed-by-default rule is a JS decision (`useState` initializer) and
   * the sheet treatment is a CSS one. When they disagreed, a landscape phone
   * got the worst of both: the panel opened by default *and* kept the desktop
   * floating geometry, so it covered a map pane it was never sized for.
   */
  it('derives the JS query from the same constants the sheet spells out', async () => {
    const { MOBILE_LAYOUT_MEDIA_QUERY, MOBILE_BREAKPOINT_PX, MOBILE_LANDSCAPE_MAX_HEIGHT_PX } =
      await import('../utils/sidebarWidth.js');

    expect(MOBILE_BREAKPOINT_PX).toBe(768);
    expect(MOBILE_LANDSCAPE_MAX_HEIGHT_PX).toBe(500);

    // Same verdict as the sheet at every viewport that matters.
    const sheetSaysMobile = (vp: Viewport) =>
      resolve_('.map-sidebar', 'border-radius', vp) === '0';
    for (const vp of [PORTRAIT_PHONE, ...LANDSCAPE_VIEWPORTS.map(([, v]) => v)]) {
      expect(mediaMatches(MOBILE_LAYOUT_MEDIA_QUERY, vp)).toBe(true);
      expect(sheetSaysMobile(vp)).toBe(true);
    }
    expect(mediaMatches(MOBILE_LAYOUT_MEDIA_QUERY, DESKTOP)).toBe(false);
    expect(sheetSaysMobile(DESKTOP)).toBe(false);
  });

  it('has MapSidebar read the layout query, not the width-only one', () => {
    // A grep, deliberately: the import is the whole fix on the JS side, and
    // swapping it back is a silent regression no render test can see.
    const tsx = readFileSync(resolve('src/components/map/MapSidebar.tsx'), 'utf-8');
    expect(tsx).toMatch(/useIsMobileLayoutViewport/);
    expect(tsx).not.toMatch(/useIsMobileViewport\(\)/);
  });
});
