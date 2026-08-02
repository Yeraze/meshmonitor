/**
 * Regression tests for the mobile bottom bar (#4473).
 *
 * The reported defect is a layout failure: the MeshCore bottom bar laid its
 * items out as `flex: 1 1 0` with `min-width: 0`, so 11 entries split a ~390px
 * phone into ~35px each and every label ellipsised down to a few characters
 * ("Configuration" → "Con…"). jsdom implements no layout and no cascade, so a
 * render test cannot catch this; these assertions read the stylesheet source.
 *
 * Uses a root-relative `resolve()` like the other stylesheet assertions under
 * src/components (see NodesTab.test.tsx). `import.meta.url` is not usable here:
 * Vite rewrites it to an http URL for files in this directory, and
 * `fileURLToPath` rejects that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve('src/components/nav/SourceNav.module.css'), 'utf-8');

/** Body of the `.mobileBottomBar .item` rule inside the mobile media query. */
const itemRule = css.match(/\.mobileBottomBar \.item \{([^}]*)\}/)?.[1] ?? '';

describe('SourceNav mobile bottom bar (#4473)', () => {
  it('sizes bottom-bar items to their content rather than splitting the row evenly', () => {
    expect(itemRule).not.toBe('');
    // The exact declaration that crushed the labels.
    expect(itemRule).not.toMatch(/flex:\s*1\s+1\s+0/);
    expect(itemRule).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('gives each item a minimum width so labels stay legible', () => {
    const min = itemRule.match(/min-width:\s*(\d+)px/);
    expect(min).not.toBeNull();
    expect(Number(min![1])).toBeGreaterThanOrEqual(60);
  });

  it('scrolls the bar sideways instead of compressing it', () => {
    const barRule = css.match(/\.mobileBottomBar \{([^}]*)\}/)?.[1] ?? '';
    expect(barRule).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps labels visible on the bar even when the desktop rail is collapsed', () => {
    // An icon-only bottom bar is the other half of the reported complaint.
    expect(css).toMatch(/\.mobileBottomBar \.label \{[^}]*display:\s*block/);
  });

  it('keeps bottom-bar rules one class deep so the landscape block can override them', () => {
    // A `.mobileBottomBar.collapsed .item` rule (specificity 0,3,0) outranks the
    // landscape override (0,2,0) wherever it sits in the file. That is what left
    // the landscape bar 63px tall while the shell reserved 44px for it.
    // Comments are stripped first — the note above this rule in the stylesheet
    // quotes the very selector being banned.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/\.mobileBottomBar\.(collapsed|expanded)\s+\.(item|label)\b/);
  });

  it('reserves a bar height for the app shell in both orientations', () => {
    // App.css reserves --app-nav-bar-height to keep content clear of the bar;
    // these must stay in step or content sits under it.
    expect(css).toMatch(/--source-nav-bar-height:\s*56px/);
    expect(css).toMatch(/--source-nav-bar-height:\s*44px/);
  });

  it('themes through custom properties so consumer stylesheets cannot race it', () => {
    // Overriding background/width from an equal-specificity rule in another
    // stylesheet would make the result depend on bundler emit order — the
    // failure mode behind #4478.
    expect(css).toMatch(/--source-nav-bg:/);
    expect(css).toMatch(/background:\s*var\(--source-nav-bg\)/);
    expect(css).toMatch(/--source-nav-collapsed-width:/);
  });
});

/**
 * iOS PWA bottom-nav regressions (#4497). Reported on an iPhone 14 Pro Max
 * standalone PWA install; all three are stylesheet-level, which jsdom cannot
 * evaluate, so these assert on source the same way the rest of this file does.
 */
describe('iOS PWA bottom bar (#4497)', () => {
  const sidebarCss = readFileSync(resolve('src/components/Sidebar.css'), 'utf-8');

  it('does not flatten the bar padding-bottom to zero, which killed the safe-area inset', () => {
    // `.sidebar` needs !important to beat the landscape-rail blocks, but a flat
    // `0` also beat SourceNav's own env(safe-area-inset-bottom), docking the bar
    // flush to the screen edge inside the iOS home-indicator gesture zone.
    const mobileBlock = sidebarCss.slice(
      sidebarCss.indexOf('@media (max-width: 768px), (max-height: 500px) and (orientation: landscape)')
    );
    const rule = mobileBlock.match(/\.sidebar \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toMatch(/padding-bottom:\s*0\s*!important/);
    expect(rule).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom[^;]*\)\s*!important/);
  });

  it('keeps the safe-area inset on the bar itself too', () => {
    expect(css).toMatch(/\.mobileBottomBar \{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom/);
  });

  it('guards the horizontal scroll against iOS edge-swipe chaining', () => {
    const bar = css.match(/\.mobileBottomBar \{([^}]*)\}/)?.[1] ?? '';
    expect(bar).toMatch(/touch-action:\s*pan-x/);
    expect(bar).toMatch(/overscroll-behavior-x:\s*contain/);
  });

  it('fades whichever edge still has tabs beyond it', () => {
    // mask-image, not an ::after overlay — a pseudo-element inside a scroll
    // container scrolls away with the content.
    expect(css).toMatch(/\.mobileBottomBar\[data-overflow-end='true'\][^}]*mask-image/);
    expect(css).toMatch(/\.mobileBottomBar\[data-overflow-start='true'\][^}]*mask-image/);
    expect(css).not.toMatch(/\.mobileBottomBar[^{]*::after[^}]*linear-gradient/);
  });
});
