/**
 * Regression tests for the Leaflet credit's clearance on the Nodes map (#5099).
 *
 * Reported by NullVoid in Discord against v4.16.0-rc4: with the Packet Monitor
 * docked on a per-source map, "Leaflet | © OpenStreetMap contributors © CARTO"
 * was pinched — the Map controls panel sliced through the top of the text and
 * the packet monitor's edge sat flush against the bottom of it.
 *
 * Two separate causes, one symptom:
 *
 *   1. `.map-sidebar` is inset from the map pane's bottom, and the credit is
 *      pinned flush to the pane's bottom-RIGHT corner — the same corner. At the
 *      old 10px inset the panel's bottom edge landed inside the ~17px strip. It
 *      is the panel that wins there, not the credit: `.leaflet-bottom` ships
 *      z-index 1000 and the panel sits at 1001 on purpose (#5052), so raising
 *      z-index cannot fix it. Only bounding the panel can — the same remedy as
 *      the mobile `max-height` in #4495.
 *
 *   2. Leaflet pins the credit flush to the pane's bottom edge. Against a
 *      window edge that reads as ordinary chrome; against the hard top edge of
 *      a docked panel it reads as pinched.
 *
 * These assert the resolved geometry rather than grepping for a substring: the
 * whole point is that the two insets have to stay consistent with each other,
 * and a later edit to either sheet alone is exactly how this comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createResolver, DESKTOP } from './cssCascadeResolver';

const sidebarCss = readFileSync(resolve('src/components/map/MapSidebar.css'), 'utf-8');
const appCss = readFileSync(resolve('src/App.css'), 'utf-8');

const resolveSidebar = createResolver(sidebarCss);
const resolveApp = createResolver(appCss);

/**
 * Height of Leaflet's attribution strip, measured in Chrome at the reported
 * viewport (1600x1000, Nodes split view): 16.8px. Rounded up — the constant
 * exists so the arithmetic below is checkable, not to be pixel-exact.
 */
const ATTRIBUTION_STRIP_PX = 17;

const px = (value: string | null): number => {
  expect(value).toMatch(/^\d+(\.\d+)?px$/);
  return Number(value!.replace('px', ''));
};

describe('Leaflet credit clearance on the Nodes map (#5099)', () => {
  it('stops the Map controls panel above the attribution strip', () => {
    // The bug in one assertion: at 10px the panel's bottom edge was inside the
    // strip, cutting the credit in half.
    expect(px(resolveSidebar('.map-sidebar', 'bottom', DESKTOP))).toBeGreaterThan(
      ATTRIBUTION_STRIP_PX
    );
  });

  it('gives the credit room above the docked packet monitor', () => {
    // Scoped to the docked case on purpose — undocked, flush against the window
    // edge is the Leaflet norm and looks right.
    expect(
      px(
        resolveApp(
          '.map-container.with-packet-monitor .leaflet-control-attribution',
          'margin-bottom',
          DESKTOP
        )
      )
    ).toBeGreaterThan(0);
  });

  it('keeps the two insets consistent with each other', () => {
    /*
     * The failure mode this guards: someone raises the credit's margin (fix 2)
     * without raising the panel's inset (fix 1), and the strip walks back up
     * under the panel. The panel has to clear the strip *plus* whatever the
     * margin lifted it by, with air left over.
     */
    const panelInset = px(resolveSidebar('.map-sidebar', 'bottom', DESKTOP));
    const creditMargin = px(
      resolveApp(
        '.map-container.with-packet-monitor .leaflet-control-attribution',
        'margin-bottom',
        DESKTOP
      )
    );

    expect(panelInset).toBeGreaterThanOrEqual(creditMargin + ATTRIBUTION_STRIP_PX + 4);
  });

  it('leaves the mobile sheet alone', () => {
    // On a phone the sheet covers the whole pane and the credit with it; that
    // is the #5060 design, and this fix must not reintroduce a desktop inset
    // there. Asserted via the portrait viewport's own resolved value.
    expect(resolveSidebar('.map-sidebar', 'bottom', { width: 390, height: 844 })).toBe('0');
  });
});
