/**
 * Regression tests for the app-wide header offset (#5070, #5053).
 *
 * The bug, measured on v4.16.0-rc3 at 852x393 (iPhone-class phone, rotated):
 *
 *   .app-header      rendered 0 -> 60px   (height:auto in the landscape block)
 *   --header-height  40px
 *   .app-main        padding-top 44px
 *   .nodes-split-view top 40px
 *   document.elementFromPoint(<Info heading top-left>)  -> .app-header
 *   document.elementFromPoint(<collapse control centre>) -> .app-header
 *
 * So the fixed bar occupied 20px more than the constant every surface below it
 * offset by, and the first screenful of content was painted underneath it and
 * could not be tapped. `--app-header-height` is the corrected notion; these
 * tests assert that the offsets consume it and that the bar's own box actually
 * accounts for the safe-area inset.
 *
 * Grepping for the variable name would prove only that a rule was written.
 * These run the real declarations through the shared cascade resolver at
 * concrete viewports, so a later edit that reintroduces the bare constant — or
 * reorders two same-specificity blocks — fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createResolver,
  type Viewport,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  LANDSCAPE_BIG_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
} from './cssCascadeResolver';

const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
const headerCss = readFileSync(resolve('src/components/AppHeader/AppHeader.css'), 'utf-8');
const bannersCss = readFileSync(resolve('src/components/AppBanners/AppBanners.css'), 'utf-8');
const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');
const dashboardCss = readFileSync(resolve('src/styles/dashboard.css'), 'utf-8');

const app = createResolver(appCss);
const header = createResolver(headerCss);
const banners = createResolver(bannersCss);
const nodes = createResolver(nodesCss);

const ALL_VIEWPORTS: Array<[string, Viewport]> = [
  ['portrait phone', PORTRAIT_PHONE],
  ['landscape phone', LANDSCAPE_PHONE],
  ['landscape big phone', LANDSCAPE_BIG_PHONE],
  ['landscape small phone', LANDSCAPE_SMALL_PHONE],
  ['desktop', DESKTOP],
];

/** The two variables must never be confused; this is the corrected one. */
const CORRECTED = /var\(--app-header-height/;
/** ...and this is the bare design constant that must not appear in an offset. */
const BARE = /var\(--header-height\b/;

describe('the corrected header height exists and is derived, not guessed (#5070)', () => {
  it('defines --app-header-height as the constant plus the top inset', () => {
    const value = app(':root', '--app-header-height', DESKTOP);
    expect(value).not.toBeNull();
    // Derived from --header-height so the landscape/mobile overrides of that
    // constant keep flowing through, and inset-aware so viewport-fit=cover
    // does not bury the first row of content.
    expect(value).toMatch(BARE);
    expect(value).toMatch(/env\(safe-area-inset-top/);
  });

  it('keeps --header-height itself a plain constant', () => {
    // The two are allowed to differ and must: `.app-header` sizes its control
    // strip from the constant, everything below the bar offsets by the real
    // height. Folding the inset into the constant would double-count it.
    expect(app(':root', '--header-height', DESKTOP)).toBe('60px');
    expect(app(':root', '--header-height', LANDSCAPE_PHONE)).toBe('40px !important');
  });
});

describe('the header bar accounts for the safe-area inset in its own box (#5053)', () => {
  it('adds the inset to its height rather than eating it as padding', () => {
    // `box-sizing: border-box` + a fixed `height` means padding does NOT grow
    // the box; it shrinks the content box, floored at zero. The old
    // `padding-top: max(1.5rem, env(...))` therefore laid the header contents
    // out *below* a bar that stayed --header-height tall.
    const height = header('.app-header', 'height', PORTRAIT_PHONE);
    expect(height).toMatch(/env\(safe-area-inset-top/);
    expect(header('.app-header', 'box-sizing', PORTRAIT_PHONE)).toBe('border-box');
  });

  it.each(ALL_VIEWPORTS)('never max()es the inset against the padding on a %s', (_n, vp) => {
    const padding = header('.app-header', 'padding-top', vp);
    expect(padding).toMatch(/env\(safe-area-inset-top/);
    expect(padding).not.toMatch(/max\(/);
  });

  it('lets the bar grow to its content in compact landscape, with an inset-aware floor', () => {
    // The 768px compaction block cannot reach a landscape phone (which is
    // wider than 768px), so the bar carries desktop-sized content there and
    // genuinely needs ~57-60px. That is allowed *because* the measured height
    // is what gets published — see useAppHeaderHeightVar.
    expect(header('.app-header', 'height', LANDSCAPE_PHONE)).toBe('auto');
    expect(header('.app-header', 'min-height', LANDSCAPE_PHONE)).toMatch(BARE);
    expect(header('.app-header', 'min-height', LANDSCAPE_PHONE)).toMatch(
      /env\(safe-area-inset-top/
    );
  });
});

describe('every "content starts below the header" offset uses the corrected height', () => {
  it.each(ALL_VIEWPORTS)('.app-main clears the whole bar on a %s', (_n, vp) => {
    const padding = app('.app-main', 'padding-top', vp);
    expect(padding).toMatch(CORRECTED);
    expect(padding).not.toMatch(BARE);
  });

  it.each(ALL_VIEWPORTS)('.nodes-split-view starts below the whole bar on a %s', (_n, vp) => {
    // #5053 item 1 in one assertion: this pane holds `.collapse-nodes-btn` at
    // `top: 8px`, an 18px control. 20px of error buried it completely.
    const top = nodes('.nodes-split-view', 'top', vp);
    expect(top).toMatch(CORRECTED);
    expect(top).not.toMatch(BARE);
  });

  it.each(ALL_VIEWPORTS)('.warning-banner stacks below the whole bar on a %s', (_n, vp) => {
    const top = banners('.warning-banner', 'top', vp);
    expect(top).toMatch(CORRECTED);
    expect(top).not.toMatch(BARE);
  });

  it('the sticky section nav parks against the bottom of the bar', () => {
    const top = app('.section-nav', 'top', DESKTOP);
    expect(top).toMatch(CORRECTED);
    expect(top).not.toMatch(BARE);
  });

  it.each(ALL_VIEWPORTS)('viewport-height subtractions use the whole bar on a %s', (_n, vp) => {
    // A pane sized `100vh - header` is the same question asked downward: too
    // small a header value overflows the pane past the bottom of the screen.
    for (const [selector, property] of [
      ['.dm-conversation', 'max-height'],
      ['.channels-tab-content', 'height'],
    ] as const) {
      const value = app(selector, property, vp);
      if (value === null) continue; // rule not reached at this viewport
      if (!value.includes('--header-height') && !value.includes('--app-header-height')) continue;
      expect(value).toMatch(CORRECTED);
      expect(value).not.toMatch(BARE);
    }
  });
});

describe('banners do not pad for an inset their offset already cleared (#5070)', () => {
  it.each(ALL_VIEWPORTS)('keeps the banner padding inset-free on a %s', (_n, vp) => {
    // `top` now includes env(safe-area-inset-top). Padding for it a second
    // time put a blank strip inside every banner on a notched phone.
    expect(banners('.warning-banner, .update-banner', 'padding-top', vp) ?? '').not.toMatch(
      /env\(safe-area-inset-top/
    );
  });
});

describe('the dashboard topbar keeps its own variable on purpose (#5070)', () => {
  it('derives the same way without aliasing the measured app-header height', () => {
    // `--app-header-height` is overwritten at runtime with the measured height
    // of `.app-header` — an element the Dashboard route never renders. The
    // dashboard topbar is a fixed-height border box, so it needs no
    // measurement; aliasing would only import staleness.
    const decl = dashboardCss.match(/--dashboard-topbar-height:\s*([^;]+);/)?.[1] ?? '';
    expect(decl).toMatch(BARE);
    expect(decl).toMatch(/env\(safe-area-inset-top/);
    expect(decl).not.toMatch(CORRECTED);
  });
});

describe('the node list is an overlay on every mobile viewport (#5053 item 2)', () => {
  const LANDSCAPE: Array<[string, Viewport]> = [
    ['landscape phone', LANDSCAPE_PHONE],
    ['landscape big phone', LANDSCAPE_BIG_PHONE],
    ['landscape small phone', LANDSCAPE_SMALL_PHONE],
  ];

  it.each(LANDSCAPE)('floats the list over the map on a %s', (_n, vp) => {
    // Was `position: relative; width: 380px` in landscape — an in-flow column
    // eating 45% of an 852px screen, because the overlay treatment sat in a
    // `max-width: 768px` block and a rotated phone is wider than that.
    expect(nodes('.nodes-anchored-sidebar', 'position', vp)).toBe('absolute');
    expect(nodes('.nodes-anchored-sidebar', 'z-index', vp)).toBe('1000');
  });

  it.each(LANDSCAPE)('gives the map the whole pane once collapsed on a %s', (_n, vp) => {
    // `!important` because the component sets an inline width while expanded;
    // an important author declaration is what beats a normal inline style.
    expect(nodes('.nodes-anchored-sidebar.collapsed', 'width', vp)).toBe('0 !important');
    expect(nodes('.nodes-anchored-sidebar.collapsed', 'position', vp)).toBe('static');
  });

  it('still behaves the same way in portrait', () => {
    expect(nodes('.nodes-anchored-sidebar', 'position', PORTRAIT_PHONE)).toBe('absolute');
    expect(nodes('.nodes-anchored-sidebar.collapsed', 'width', PORTRAIT_PHONE)).toBe(
      '0 !important'
    );
  });

  it('leaves the desktop split view in flow', () => {
    // Desktop keeps a real two-pane split; the overlay is a small-screen
    // affordance, not the design.
    expect(nodes('.nodes-anchored-sidebar', 'position', DESKTOP)).toBe('relative');
  });
});
