/**
 * Regression tests for the non-scrollable-page rule in `App.css`.
 *
 * `@media (max-width: 768px)` carried a bare
 * `.tab-content { overflow: hidden }` labelled "Make entire page
 * non-scrollable on mobile". It arrived in #754 ("Improve mobile layout for
 * Channels and Messages tabs"), written among that PR's channel declarations:
 * the intent was the chat view, whose message list scrolls internally and
 * whose page therefore must not scroll behind it. The selector was wider than
 * the intent — `.tab-content` is also rendered by Settings, Notifications,
 * Device config, Admin Commands and Info.
 *
 * `overflow: hidden` makes an element a scroll container, and a scroll
 * container is the scrollport every `position: sticky` descendant is measured
 * against. Those pages are `height: auto`, so the box grows with its content,
 * its scrollTop never leaves 0, and sticky silently never engages. Measured on
 * the real page at 393x852, `.section-nav` left the viewport (top -931 at
 * scrollTop 1200) instead of parking at the header's 40px.
 *
 * Only PORTRAIT was affected, because the block is `max-width: 768px` and a
 * landscape phone is wider than that — the same defect family as #5051 /
 * #5053 / #5054 / #5060 / #5069 / #5070, but inverted: here the over-narrow
 * gate is what *limited* the damage, and landscape was the correct behaviour
 * all along. So these tests assert the two orientations AGREE, rather than
 * asserting a value for one of them.
 *
 * What is asserted is the relationship, not a literal: the surfaces whose
 * descendants rely on sticky must not sit inside a `.tab-content` that has
 * been turned into a scroll container, while the channels surface — which
 * genuinely needs the containment — keeps it.
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
const resolveApp = createResolver(appCss);

const moduleCss = readFileSync(resolve('src/components/ConfigurationTab.module.css'), 'utf-8');
const resolveModule = createResolver(moduleCss);

/**
 * The `overflow` values that create a scroll container, and so become the
 * scrollport of every `position: sticky` descendant. `visible` (and an absent
 * declaration, which resolves to it) is the only value that lets a descendant
 * stick to the viewport.
 */
const SCROLL_CONTAINER_VALUES = ['hidden', 'auto', 'scroll', 'clip'];

/** True when the resolved declaration would trap a sticky descendant. */
function trapsSticky(declaration: string | null): boolean {
  if (declaration === null) return false;
  return SCROLL_CONTAINER_VALUES.some((v) => declaration.split(/\s+/).includes(v));
}

const ALL_VIEWPORTS: Array<[string, Viewport]> = [
  ['portrait phone', PORTRAIT_PHONE],
  ['landscape phone', LANDSCAPE_PHONE],
  ['landscape big phone', LANDSCAPE_BIG_PHONE],
  ['landscape small phone', LANDSCAPE_SMALL_PHONE],
  ['desktop', DESKTOP],
];

describe('.tab-content does not trap its sticky descendants', () => {
  it.each(ALL_VIEWPORTS)('leaves the shared surface scrollable on a %s', (_name, vp) => {
    // The bug in one assertion. Settings, Notifications, Device config, Admin
    // Commands and Info all render a bare `.tab-content`; whatever this
    // resolves to must not make it a scroll container, or their `.section-nav`
    // has a scrollport it can never scroll within.
    expect(trapsSticky(resolveApp('.tab-content', 'overflow', vp))).toBe(false);
    expect(trapsSticky(resolveApp('.tab-content', 'overflow-y', vp))).toBe(false);
  });

  it('behaves identically in portrait and landscape', () => {
    // The reported symptom was an orientation split: the chip row stuck at
    // 852x393 and did not at 393x852, purely because the rule was gated on
    // `max-width: 768px`. Stating the parity directly means a future rule
    // re-introduced behind either arm of the union breakpoint fails here.
    const portrait = resolveApp('.tab-content', 'overflow', PORTRAIT_PHONE);
    for (const [, vp] of ALL_VIEWPORTS) {
      expect(resolveApp('.tab-content', 'overflow', vp)).toBe(portrait);
    }
  });

  it('keeps the chip row sticky and parked below the measured header', () => {
    // The other half of the relationship: the rule above is only worth
    // scoping because `.section-nav` is sticky. If it stops being sticky this
    // test says so instead of the scoping quietly becoming pointless.
    // `--app-header-height` (measured, #5075) not `--header-height` (the
    // design constant) — the split #5070 exists to keep straight.
    for (const [, vp] of ALL_VIEWPORTS) {
      expect(resolveApp('.section-nav', 'position', vp)).toBe('sticky');
      expect(resolveApp('.section-nav', 'top', vp)).toBe('var(--app-header-height)');
    }
  });
});

describe('the channels tab keeps the non-scrollable treatment', () => {
  const SMALL: Array<[string, Viewport]> = [['portrait phone', PORTRAIT_PHONE]];

  it.each(SMALL)('contains the chat view on a %s', (_name, vp) => {
    // The intent of #754, preserved. The chat view is a fixed-height layout
    // whose message list scrolls internally; without containment the page
    // scrolls behind the conversation and the send bar is pushed off screen
    // (the #3307 / #3336 failure mode).
    expect(resolveApp('.tab-content.channels-tab-content', 'overflow', vp)).toBe('hidden');
  });

  it.each(SMALL)('does not lean on the shared rule for it on a %s', (_name, vp) => {
    // The channel-scoped block declares its own containment alongside the flex
    // chain, so removing the shared rule changed nothing here — verified in
    // the browser by deleting the rule via CSSOM and re-measuring. Asserted so
    // that "the shared rule was redundant for channels" stays true.
    expect(resolveApp('.channels-tab-content', 'overflow', vp)).toBe('hidden');
    expect(resolveApp('.channels-tab-content', 'min-height', vp)).toBe('0');
    expect(resolveApp('.channels-tab-content', 'overscroll-behavior', vp)).toBe('contain');
  });

  it('is scoped by the compound selector, never by `.tab-content` alone', () => {
    // Source-level guard on the selector itself. The compound form is what
    // keeps Settings and friends out of it; widening it back is the exact
    // regression this file exists to catch, and it would read as a one-word
    // diff. Comments are stripped first — the rule this replaced sat directly
    // behind one, so a raw-text scan silently matches nothing.
    expect(appCss).toContain('.tab-content.channels-tab-content');
    const withoutComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/(^|\})\s*\.tab-content\s*\{[^}]*overflow\s*:/);
  });
});

describe('the config rail is untouched (#5069/#5073)', () => {
  it('still owns the landscape picker, and still leaves portrait alone', () => {
    // The rail is a sticky element too, so it shares the failure mode — but it
    // lives in landscape, where `.tab-content` never carried the rule. Pinned
    // here so scoping the portrait rule cannot be blamed for, or accidentally
    // reach, the rail.
    expect(resolveModule('.configShell', 'display', LANDSCAPE_PHONE)).toBe('flex');
    expect(resolveModule('.configNav.configNav', 'width', LANDSCAPE_PHONE)).toBe('160px');
    expect(resolveModule('.configShell', 'display', PORTRAIT_PHONE)).toBeNull();
    expect(resolveModule('.configNav.configNav', 'width', PORTRAIT_PHONE)).toBeNull();
  });
});
