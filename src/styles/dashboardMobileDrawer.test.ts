/**
 * Regression tests for the Sources drawer close control (#5053).
 *
 * Reported on v4.16.0-rc2: in landscape on a phone the Sources menu could not
 * be dismissed. The close (X) is `.dashboard-topbar-hamburger`, rendered by
 * `DashboardPage` and toggled to the `close` icon while the drawer is open.
 * Its entire mobile treatment lived behind `@media (max-width: 768px)` — but a
 * phone in landscape is *wider* than 768px (iPhone 13 → 844, Pixel 7 → 915), so
 * on rotation the button reverted to `display: none` and the only way to close
 * the drawer disappeared.
 *
 * jsdom implements neither layout nor media queries, so a render test cannot
 * see this. Instead of grepping the sheet for substrings, these tests run the
 * real declarations through a miniature cascade resolver for the handful of
 * selectors involved, and assert the resolved geometry at concrete viewports:
 * the button is displayed, and the drawer and its backdrop start exactly at the
 * bottom of the top bar. A drawer or backdrop that starts any higher covers the
 * button and eats the tap, which is the other half of the report ("the X is
 * already partly tucked under the top bar").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve('src/styles/dashboard.css'), 'utf-8');

interface Viewport {
  width: number;
  height: number;
}

/** Evaluates the small media-feature grammar these sheets actually use. */
function mediaMatches(condition: string, vp: Viewport): boolean {
  // A comma-separated list is an OR of conjunctions.
  return condition.split(',').some((clause) => {
    const features = clause.split(/\s+and\s+/).map((f) => f.trim());
    return features.every((feature) => {
      const m = feature.match(/\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/);
      if (!m) throw new Error(`unsupported media feature: ${feature}`);
      const [, name, value] = m;
      switch (name) {
        case 'max-width':
          return vp.width <= Number(value.replace('px', ''));
        case 'min-width':
          return vp.width >= Number(value.replace('px', ''));
        case 'max-height':
          return vp.height <= Number(value.replace('px', ''));
        case 'min-height':
          return vp.height >= Number(value.replace('px', ''));
        case 'orientation':
          // CSS counts a square viewport as landscape.
          return value === 'landscape' ? vp.width >= vp.height : vp.height > vp.width;
        default:
          throw new Error(`unsupported media feature: ${name}`);
      }
    });
  });
}

/** Strips comments and splits the sheet into (mediaCondition | null, body) blocks. */
function topLevelBlocks(source: string): Array<{ condition: string | null; body: string }> {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Array<{ condition: string | null; body: string }> = [];
  let i = 0;
  while (i < clean.length) {
    const braceAt = clean.indexOf('{', i);
    if (braceAt === -1) break;
    const prelude = clean.slice(i, braceAt).trim();
    // Walk to the matching close brace.
    let depth = 0;
    let j = braceAt;
    for (; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}' && --depth === 0) break;
    }
    const body = clean.slice(braceAt + 1, j);
    if (prelude.startsWith('@media')) {
      blocks.push({ condition: prelude.slice('@media'.length).trim(), body });
    } else if (prelude.startsWith('@')) {
      // Other at-rules (@keyframes, @supports) are not needed by these tests.
    } else {
      blocks.push({ condition: null, body: `${prelude} {${body}}` });
    }
    i = j + 1;
  }
  return blocks;
}

/**
 * Resolved value of one property for one selector at one viewport.
 *
 * Deliberately simple: every rule in this sheet that touches these selectors
 * has the same specificity, so source order alone decides the winner.
 */
function resolve_(selector: string, property: string, vp: Viewport): string | null {
  let winner: string | null = null;
  const wanted = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.\\[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'g'
  );
  for (const block of topLevelBlocks(css)) {
    if (block.condition !== null && !mediaMatches(block.condition, vp)) continue;
    const scope = block.condition === null ? block.body : block.body;
    wanted.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wanted.exec(scope)) !== null) {
      const decl = m[2].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
      if (decl) winner = decl[1].trim();
    }
  }
  return winner;
}

const PORTRAIT_PHONE: Viewport = { width: 390, height: 844 }; // iPhone 13
const LANDSCAPE_PHONE: Viewport = { width: 844, height: 390 }; // iPhone 13, rotated
const LANDSCAPE_BIG_PHONE: Viewport = { width: 915, height: 412 }; // Pixel 7, rotated
const LANDSCAPE_SMALL_PHONE: Viewport = { width: 667, height: 375 }; // iPhone SE, rotated
const DESKTOP: Viewport = { width: 1440, height: 900 };

describe('Sources drawer close control (#5053)', () => {
  const mobileViewports: Array<[string, Viewport]> = [
    ['portrait phone', PORTRAIT_PHONE],
    ['landscape phone', LANDSCAPE_PHONE],
    ['landscape big phone', LANDSCAPE_BIG_PHONE],
    ['landscape small phone', LANDSCAPE_SMALL_PHONE],
  ];

  it.each(mobileViewports)('renders the close control on a %s', (_name, vp) => {
    // This is the whole bug: `display: none` means the button has no box, so it
    // cannot be hit at any coordinate.
    expect(resolve_('.dashboard-topbar-hamburger', 'display', vp)).not.toBe('none');
  });

  it.each(mobileViewports)('overlays the drawer rather than reflowing it on a %s', (_name, vp) => {
    // A static drawer is the desktop sidebar: it takes layout space and there is
    // nothing to dismiss, which is what "the menu stays open" looked like.
    expect(resolve_('.dashboard-sidebar', 'position', vp)).toBe('fixed');
  });

  it.each(mobileViewports)(
    'starts the drawer and backdrop exactly at the bottom of the top bar on a %s',
    (_name, vp) => {
      const topbarHeight = resolve_('.dashboard-topbar', 'height', vp);
      expect(topbarHeight).toBe('var(--dashboard-topbar-height)');
      // Same expression, so the drawer can never ride up over the close control
      // however tall the notch inset makes the bar at runtime.
      expect(resolve_('.dashboard-sidebar', 'top', vp)).toBe(topbarHeight);
      expect(resolve_('.dashboard-sidebar-backdrop', 'top', vp)).toBe(topbarHeight);
    }
  );

  it('keeps the desktop layout untouched', () => {
    expect(resolve_('.dashboard-topbar-hamburger', 'display', DESKTOP)).toBe('none');
    expect(resolve_('.dashboard-sidebar', 'position', DESKTOP)).toBeNull();
    expect(resolve_('.dashboard-sidebar-backdrop', 'display', DESKTOP)).toBe('none');
  });

  it('pads the top bar by the notch inset so the control is not under the status bar', () => {
    // index.html ships viewport-fit=cover, so without this the page — and the
    // close control with it — starts under the status bar.
    const padding = resolve_('.dashboard-topbar', 'padding', PORTRAIT_PHONE);
    expect(padding).toMatch(/env\(safe-area-inset-top/);
    // ...and the declared height has to include that padding, or the bar
    // overlaps the content below it.
    expect(css).toMatch(
      /--dashboard-topbar-height:\s*calc\(var\(--header-height[^)]*\)\s*\+\s*env\(safe-area-inset-top/
    );
  });

  it('clears the side notch in landscape', () => {
    // safe-area-inset-left is non-zero on a notched phone held sideways; a flat
    // `padding: 0 24px` / `left: 0` puts the close control under the notch.
    expect(resolve_('.dashboard-topbar', 'padding', LANDSCAPE_PHONE)).toMatch(
      /env\(safe-area-inset-left/
    );
    expect(resolve_('.dashboard-sidebar', 'left', LANDSCAPE_PHONE)).toMatch(
      /env\(safe-area-inset-left/
    );
  });
});

describe('Sources drawer stacks above the Leaflet control layer (#5052)', () => {
  /**
   * Leaflet's *panes* top out at 700, but `.leaflet-top` / `.leaflet-bottom` —
   * the containers holding the zoom buttons and the attribution — ship 1000.
   * The drawer sat at 999, one below, so the zoom control painted over the
   * first source card. Read the vendor value rather than hardcoding it, so a
   * Leaflet upgrade that moves the number fails here instead of in the field.
   */
  const leafletCss = readFileSync(resolve('node_modules/leaflet/dist/leaflet.css'), 'utf-8');
  const LEAFLET_CONTROL_Z = (() => {
    const block = leafletCss.match(
      /\.leaflet-top,\s*\n?\s*\.leaflet-bottom\s*\{([^}]*)\}/
    )?.[1];
    const z = block?.match(/z-index:\s*(\d+)/)?.[1];
    return Number(z);
  })();

  const z = (selector: string, vp: Viewport) => Number(resolve_(selector, 'z-index', vp));

  it('reads a usable z-index off Leaflet itself', () => {
    expect(Number.isFinite(LEAFLET_CONTROL_Z)).toBe(true);
    expect(LEAFLET_CONTROL_Z).toBe(1000);
  });

  it.each([
    ['portrait phone', PORTRAIT_PHONE],
    ['landscape phone', LANDSCAPE_PHONE],
  ] as Array<[string, Viewport]>)(
    'puts the drawer and its backdrop above Leaflet\'s controls on a %s',
    (_name, vp) => {
      expect(z('.dashboard-sidebar', vp)).toBeGreaterThan(LEAFLET_CONTROL_Z);
      expect(z('.dashboard-sidebar-backdrop', vp)).toBeGreaterThan(LEAFLET_CONTROL_Z);
      // The drawer still sits above its own backdrop.
      expect(z('.dashboard-sidebar', vp)).toBeGreaterThan(z('.dashboard-sidebar-backdrop', vp));
    }
  );

  it('keeps the map-controls panel yielding to the drawer', () => {
    // The documented 997 relationship (nodes.css) must survive the raise.
    const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');
    const mobileBlock = nodesCss.slice(nodesCss.lastIndexOf('Map Controls (mobile override)'));
    const rule = mobileBlock.match(/\.map-controls\s*\{([^}]*)\}/)?.[1] ?? '';
    const panelZ = Number(rule.match(/z-index:\s*(\d+)/)?.[1]);
    expect(panelZ).toBe(997);
    expect(panelZ).toBeLessThan(z('.dashboard-sidebar-backdrop', PORTRAIT_PHONE));
  });

  it('applies the map-controls mobile override in landscape too', () => {
    // Same width-only-query defect as #5053: without the landscape clause the
    // Features panel keeps its desktop z-index and does not yield.
    const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');
    const idx = nodesCss.lastIndexOf('Map Controls (mobile override)');
    const query = nodesCss.slice(idx).match(/@media([^{]*)\{/)?.[1] ?? '';
    expect(query).toMatch(/max-width:\s*768px/);
    expect(query).toMatch(/max-height:\s*500px\)\s*and\s*\(orientation:\s*landscape/);
  });

  it('lifts .map-sidebar clear of the tie with Leaflet\'s controls', () => {
    const mapSidebarCss = readFileSync(resolve('src/components/map/MapSidebar.css'), 'utf-8');
    const rule = mapSidebarCss.match(/\.map-sidebar\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const value = Number(rule.match(/z-index:\s*(\d+)/)?.[1]);
    expect(value).toBeGreaterThan(LEAFLET_CONTROL_Z);
    // ...but still under the Sources drawer.
    expect(value).toBeLessThan(z('.dashboard-sidebar', PORTRAIT_PHONE));
  });
});

describe('compact-landscape queries do not straddle rail and bottom bar (#5053)', () => {
  /**
   * The shell had two competing definitions of "compact landscape" — 500px in
   * App.css/AppHeader.css/SourceNav/SaveBar and 700px in Sidebar.css and
   * SidebarFooter.module.css.
   *
   * The 700px pair are RAIL rules: they compact the vertical nav on a short
   * landscape screen. Below the shell's own thresholds SourceNav is a
   * horizontal bottom BAR instead, and a rail rule landing on a bar is not
   * cosmetic — #5054 traced an unreachable bottom nav to
   * `.sidebar.collapsed { width: 48px !important }` from one of these blocks
   * beating `.mobileBottomBar.collapsed { width: 100% }`.
   *
   * So the invariant is not "one number". It is: a landscape query either uses
   * the shell threshold (500px, the one `sidebarWidth.ts` mirrors), or it is a
   * rail block that explicitly subtracts the bar's territory.
   */
  const SHELL_MAX_HEIGHT = 500;
  const SHELL_MAX_WIDTH = 768;

  const sheets = [
    'src/App.css',
    'src/styles/dashboard.css',
    'src/styles/nodes.css',
    'src/components/Sidebar.css',
    'src/components/SidebarFooter.module.css',
    'src/components/AppHeader/AppHeader.css',
    'src/components/nav/SourceNav.module.css',
    'src/components/SaveBar/SaveBar.css',
  ];

  it.each(sheets)('%s: every landscape query is shell-scoped or rail-scoped', (sheet) => {
    const text = readFileSync(resolve(sheet), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const queries = [...text.matchAll(/@media([^{]*orientation:\s*landscape[^{]*)\{/g)].map(
      (m) => m[1]
    );
    expect(queries.length).toBeGreaterThan(0);

    for (const q of queries) {
      const maxHeights = [...q.matchAll(/max-height:\s*(\d+)px/g)].map((m) => Number(m[1]));
      if (maxHeights.length === 0) continue; // orientation-only query — nothing to reconcile
      if (maxHeights.every((h) => h === SHELL_MAX_HEIGHT)) continue; // shell-scoped

      // Anything else is a rail block and must exclude the bottom bar on both
      // axes, or it will fire on viewports where no rail exists.
      const minWidth = Number(q.match(/min-width:\s*(\d+)px/)?.[1]);
      const minHeight = Number(q.match(/min-height:\s*(\d+)px/)?.[1]);
      expect(minWidth, `${sheet}: @media${q} lacks a min-width guard`).toBeGreaterThan(
        SHELL_MAX_WIDTH
      );
      expect(minHeight, `${sheet}: @media${q} lacks a min-height guard`).toBeGreaterThan(
        SHELL_MAX_HEIGHT
      );
    }
  });

  it('leaves no rail rule matching a bottom-bar viewport', () => {
    // The concrete regression: a landscape phone must not pick up the rail's
    // collapsed width, which is what stubbed the bottom nav in #5054.
    const sidebarCss = readFileSync(resolve('src/components/Sidebar.css'), 'utf-8');
    const clean = sidebarCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const railBlocks = [...clean.matchAll(/@media([^{]*orientation:\s*landscape[^{]*)\{/g)].filter(
      (m) => /max-height:\s*700px/.test(m[1])
    );
    // Sidebar.css carries exactly two of these — the padding/controls block and
    // the header/logo/collapsed-rail block. Pinning the count is deliberate: a
    // third one added later is a new place for a rail rule to leak into the bar,
    // and the author should have to come here and confirm it is guarded rather
    // than have the loop silently skip it.
    expect(railBlocks.length).toBe(2);
    for (const m of railBlocks) {
      expect(mediaMatches(m[1].trim(), LANDSCAPE_PHONE)).toBe(false);
      expect(mediaMatches(m[1].trim(), LANDSCAPE_SMALL_PHONE)).toBe(false);
      // ...but still active where a rail genuinely exists.
      expect(mediaMatches(m[1].trim(), { width: 1024, height: 600 })).toBe(true);
    }
  });

  it('matches the threshold the JS mirror uses', async () => {
    const { MOBILE_LANDSCAPE_MAX_HEIGHT_PX, MOBILE_BREAKPOINT_PX } = await import(
      '../utils/sidebarWidth.js'
    );
    expect(MOBILE_LANDSCAPE_MAX_HEIGHT_PX).toBe(SHELL_MAX_HEIGHT);
    expect(MOBILE_BREAKPOINT_PX).toBe(SHELL_MAX_WIDTH);
  });
});
