/**
 * Regression tests for content sitting UNDER the fixed header on an iOS
 * standalone PWA (#4772) — the top-edge counterpart to bottomBarClearance.test.ts
 * (#4473) and the bottom-bar inset fixes in SourceNav.mobile.test.ts (#4497).
 *
 * With `viewport-fit=cover` and `display: standalone`, iOS reports a
 * ~47-59px `env(safe-area-inset-top)` that the browser absorbs in a normal tab
 * and the app must absorb itself when installed. Two failures compounded:
 *
 *   1. `.app-header` added the inset to its padding only. With a fixed `height`
 *      and `box-sizing: border-box`, padding cannot grow the box — the inset
 *      just ate the content box, so the header's contents rendered below its
 *      background band.
 *   2. Everything anchored below the header offset by `--header-height`, which
 *      excludes that inset — worst of all `.nodes-split-view`, which used a
 *      hardcoded `top: 48px` and covered the shell's chrome on the map view.
 *
 * The contract these assert: the header reserves the inset in its own height,
 * and every offset below it uses `--header-offset` (height + inset), never a
 * bare `--header-height` or a constant. jsdom does no layout and no cascade, so
 * these read the stylesheet source, like the other stylesheet assertions here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
const headerCss = readFileSync(resolve('src/components/AppHeader/AppHeader.css'), 'utf-8');
const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');
const bannersCss = readFileSync(resolve('src/components/AppBanners/AppBanners.css'), 'utf-8');
const bannersTsx = readFileSync(resolve('src/components/AppBanners/AppBanners.tsx'), 'utf-8');
const dashboardCss = readFileSync(resolve('src/styles/dashboard.css'), 'utf-8');

/** Body of a rule, searched by exact selector text at any indent. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

describe('header safe-area clearance (#4772)', () => {
  it('defines the offset token as header height plus the top inset', () => {
    // Indirected through --safe-area-top rather than calling env() inline: env()
    // cannot be set from script, so this is also the seam that lets the
    // standalone-PWA geometry be driven in a desktop browser.
    expect(appCss).toMatch(/--safe-area-top:\s*env\(safe-area-inset-top,\s*0px\)/);
    expect(appCss).toMatch(
      /--header-offset:\s*calc\(var\(--header-height\)\s*\+\s*var\(--safe-area-top\)\)/
    );
  });

  it('grows the header box by the inset instead of only padding it', () => {
    const body = ruleBody(headerCss, '.app-header');
    expect(body).not.toBeNull();
    // The declaration that failed: max() into padding under a fixed height
    // cannot move the background band down, it only crushes the content box.
    expect(body!).not.toMatch(/padding-top:\s*max\(/);
    expect(body!).toMatch(/padding-top:\s*calc\([^;]*--safe-area-top/);
    expect(body!).toMatch(/height:\s*var\(--header-offset/);
  });

  it('keeps the mobile header padding where it actually wins the cascade', () => {
    // App.css is imported before AppHeader.css, so its `.app-header` rules lose
    // same-specificity ties to AppHeader.css's base rule. The mobile padding
    // therefore has to live in AppHeader.css's own mobile block.
    const headerMobile = headerCss.slice(headerCss.indexOf('@media (max-width: 768px)'));
    expect(ruleBody(headerMobile, '.app-header')).toMatch(
      /padding-top:\s*calc\([^;]*--safe-area-top/
    );

    const appMobile = appCss.slice(appCss.indexOf('@media (max-width: 768px)'));
    // Comments stripped: the redirect note left behind names the selector.
    expect(appMobile.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.app-header\s*\{/);
  });

  it('anchors the map/list split view to the offset, not a constant', () => {
    const body = ruleBody(nodesCss, '.nodes-split-view');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/top:\s*var\(--header-offset\)/);

    // The mobile block must not reintroduce a hardcoded top: it was 48px against
    // a 40px mobile header and could never carry the inset.
    const mobile = nodesCss.slice(nodesCss.indexOf('@media (max-width: 768px)'));
    const mobileBody = ruleBody(mobile, '.nodes-split-view');
    expect(mobileBody).not.toBeNull();
    expect(mobileBody!.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/top:/);
  });

  it('offsets app-main below the header in every orientation', () => {
    const paddings = [...appCss.matchAll(/padding-top:\s*calc\(var\(--header-(\w+)\)/g)].map(
      (m) => m[1]
    );
    expect(paddings.length).toBeGreaterThan(0);
    expect(paddings.every((v) => v === 'offset')).toBe(true);
  });

  it('insets the dashboard page, which is where an installed PWA actually opens', () => {
    // `path="*"` in main.tsx makes DashboardPage the landing route, and
    // staticServing.ts sets the manifest start_url to BASE_URL + '/'. It is a
    // self-contained 100dvh page with its own topbar, so it inherits none of the
    // app-shell offsets above and handled no insets at all: its topbar — with
    // the hamburger that opens the source list — rendered under the status bar.
    const body = ruleBody(dashboardCss, '.dashboard-page');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/padding-top:\s*var\(--safe-area-top/);
    expect(body!).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom/);
  });

  it('lifts the dashboard drawer clear of both insets', () => {
    // The drawer is `position: fixed`, so it is viewport-relative and the page's
    // padding above does not contain it.
    const mobile = dashboardCss.slice(dashboardCss.indexOf('@media (max-width: 768px)'));
    const drawer = ruleBody(mobile, '.dashboard-sidebar');
    expect(drawer).not.toBeNull();
    expect(drawer!).toMatch(/top:\s*var\(--header-offset/);
    expect(drawer!).toMatch(/bottom:\s*env\(safe-area-inset-bottom/);
    expect(ruleBody(mobile, '.dashboard-sidebar-backdrop')).toMatch(/top:\s*var\(--header-offset/);
  });

  it('subtracts the full header footprint from viewport-height math', () => {
    // `calc(100vh - var(--header-height) - …)` overstates the room left below a
    // header that is inset-taller than its nominal height, so the panel runs off
    // the bottom of the screen by exactly the inset.
    const viewportMath = [...appCss.matchAll(/calc\(100d?vh\s*-\s*var\(--header-(\w+)\)/g)].map(
      (m) => m[1]
    );
    expect(viewportMath.length).toBeGreaterThan(0);
    expect(viewportMath.every((v) => v === 'offset')).toBe(true);
  });

  it('hangs the banners off the bottom of the header without re-adding the inset', () => {
    expect(ruleBody(bannersCss, '.warning-banner')).toMatch(/top:\s*var\(--header-offset\)/);
    // Double-counting: the header already reserved the inset above the banner.
    expect(bannersCss).not.toMatch(/padding-top:[^;]*safe-area-inset-top/);
    // The stacked-banner offsets are inline styles on the elements themselves.
    expect(bannersTsx).not.toMatch(/var\(--header-height\)/);
    expect(bannersTsx).toMatch(/var\(--header-offset\)/);
  });
});
