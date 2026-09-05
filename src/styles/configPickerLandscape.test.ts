/**
 * Regression tests for the Device-tab config category picker in landscape
 * (#5069).
 *
 * Reported on v4.16.0-rc3: the picker is a sticky wrapping button grid, and the
 * only small-screen treatment for `.section-nav` lives in `App.css` behind
 * `@media (max-width: 768px)`. A phone in landscape is *wider* than 768px
 * (iPhone 13 -> 844, Pixel 7 -> 915), so that block switched itself off and the
 * desktop wrapping grid stood: 208px of picker inside 302px of usable height,
 * leaving a 94px strip for the form.
 *
 * Same defect class as #5051 / #5053 / #5054 / #5060.
 *
 * The fix turns the picker into a left rail on a landscape phone, so it costs
 * zero pixels on the scarce (vertical) axis. These tests run the real
 * declarations through the shared cascade resolver, because "the rule is in the
 * file" and "the rule wins" are different claims and every bug in this family
 * was the second one failing.
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

const moduleCss = readFileSync(resolve('src/components/ConfigurationTab.module.css'), 'utf-8');
const resolveModule = createResolver(moduleCss);

const activeCss = readFileSync(resolve('src/components/SectionNav.module.css'), 'utf-8');
const resolveActive = createResolver(activeCss);

const LANDSCAPE_VIEWPORTS: Array<[string, Viewport]> = [
  ['landscape phone', LANDSCAPE_PHONE],
  ['landscape big phone', LANDSCAPE_BIG_PHONE],
  ['landscape small phone', LANDSCAPE_SMALL_PHONE],
];

describe('config picker becomes a left rail in landscape (#5069)', () => {
  it.each(LANDSCAPE_VIEWPORTS)('puts picker and form side by side on a %s', (_name, vp) => {
    // The whole fix in one assertion: the picker stops being a block above the
    // form and becomes a column beside it.
    expect(resolveModule('.configShell', 'display', vp)).toBe('flex');
    // A stretched flex item cannot stick — without this the rail is pinned to
    // the top of a full-height box and never follows the scroll.
    expect(resolveModule('.configShell', 'align-items', vp)).toBe('flex-start');
  });

  it.each(LANDSCAPE_VIEWPORTS)('gives the rail a fixed narrow width on a %s', (_name, vp) => {
    // 160px of the abundant axis. At 844px wide that leaves ~660px for the
    // form — more than the desktop content column ever uses.
    expect(resolveModule('.configNav.configNav', 'width', vp)).toBe('160px');
    expect(resolveModule('.configNav.configNav', 'flex', vp)).toBe('0 0 160px');
    expect(resolveModule('.configNav.configNav', 'flex-direction', vp)).toBe('column');
  });

  it.each(LANDSCAPE_VIEWPORTS)('lets the rail scroll itself on a %s', (_name, vp) => {
    // With 28 categories the rail overflows. It must scroll independently —
    // a rail that grows the page is just the old grid rotated.
    expect(resolveModule('.configNav.configNav', 'overflow-y', vp)).toBe('auto');
    expect(resolveModule('.configNav.configNav', 'overflow-x', vp)).toBe('hidden');
    // Derived from the shell's own variables, never a magic pixel count, so it
    // stays correct if the header or bottom bar is re-measured (#5070/#5053).
    expect(resolveModule('.configNav.configNav', 'max-height', vp)).toBe(
      'calc(100dvh - var(--header-height) - var(--app-nav-bar-height) - 0.5rem)'
    );
  });

  it.each(LANDSCAPE_VIEWPORTS)('lets the form take the remaining width on a %s', (_name, vp) => {
    expect(resolveModule('.configBody', 'flex', vp)).toBe('1 1 auto');
    // Without min-width:0 a wide child (the channel table) would refuse to
    // shrink and push the rail off screen.
    expect(resolveModule('.configBody', 'min-width', vp)).toBe('0');
  });

  it('leaves portrait alone', () => {
    // 160px out of a 390px-wide phone is not spare width. Portrait keeps the
    // App.css chip row, so every rail declaration must resolve to nothing.
    expect(resolveModule('.configShell', 'display', PORTRAIT_PHONE)).toBeNull();
    expect(resolveModule('.configNav.configNav', 'width', PORTRAIT_PHONE)).toBeNull();
    expect(resolveModule('.configBody', 'flex', PORTRAIT_PHONE)).toBeNull();
  });

  it('leaves desktop alone', () => {
    // Desktop is tall enough that the wrapping grid costs nothing worth
    // reclaiming, and the two-column GPIO layout already owns the width.
    expect(resolveModule('.configShell', 'display', DESKTOP)).toBeNull();
    expect(resolveModule('.configNav.configNav', 'width', DESKTOP)).toBeNull();
    expect(resolveModule('.configBody', 'flex', DESKTOP)).toBeNull();
  });

  it('is gated on the landscape arm only, never on max-width alone', () => {
    // The bug this file exists to prevent. `max-width: 768px` is false on both
    // landscape phones in the report, which is precisely why the existing
    // small-screen block never applied there.
    expect(mediaMatches('(max-width: 768px)', LANDSCAPE_PHONE)).toBe(false);
    expect(mediaMatches('(max-width: 768px)', LANDSCAPE_BIG_PHONE)).toBe(false);
    expect(
      mediaMatches('(max-height: 500px) and (orientation: landscape)', LANDSCAPE_PHONE)
    ).toBe(true);
    expect(
      mediaMatches('(max-height: 500px) and (orientation: landscape)', LANDSCAPE_BIG_PHONE)
    ).toBe(true);
  });

  it('beats the App.css chip row where both blocks match', () => {
    // An iPhone SE rotated (667x375) is narrow AND short, so App.css's
    // `.section-nav { flex-wrap: nowrap; overflow-x: auto }` also applies.
    // Source order across two sheets is not something this component controls,
    // so the rail wins on specificity instead: `.configNav.configNav` is 0,2,0
    // against `.section-nav`'s 0,1,0. If someone un-doubles the class, the
    // small landscape phone silently reverts to a chip row.
    expect(mediaMatches('(max-width: 768px)', LANDSCAPE_SMALL_PHONE)).toBe(true);
    expect(moduleCss).toContain('.configNav.configNav');
    expect(resolveModule('.configNav.configNav', 'flex-wrap', LANDSCAPE_SMALL_PHONE)).toBe(
      'nowrap'
    );
    expect(resolveModule('.configNav.configNav', 'flex-direction', LANDSCAPE_SMALL_PHONE)).toBe(
      'column'
    );
  });
});

describe('selected category stays visible (#5069)', () => {
  it('highlights the active button at every viewport', () => {
    // Unconditional on purpose: a scrolling picker needs the highlight, and a
    // static one is no worse for having it.
    for (const vp of [PORTRAIT_PHONE, LANDSCAPE_PHONE, DESKTOP]) {
      expect(resolveActive('.active.active', 'background', vp)).toBe('var(--color-accent)');
      expect(resolveActive('.active.active', 'color', vp)).toBe('var(--color-accent-text)');
    }
  });

  it('doubles the class so it beats .section-nav-item in App.css', () => {
    expect(activeCss).toContain('.active.active');
  });
});
