/**
 * Regression tests for the SectionNav category picker in landscape.
 *
 * Originally #5069: the Device-tab picker is a sticky wrapping button grid, and
 * the only small-screen treatment for `.section-nav` lives in `App.css` behind
 * `@media (max-width: 768px)`. A phone in landscape is *wider* than 768px
 * (iPhone 13 -> 844, Pixel 7 -> 915), so that block switched itself off and the
 * desktop wrapping grid stood: 208px of picker inside 302px of usable height,
 * leaving a 94px strip for the form.
 *
 * Same defect class as #5051 / #5053 / #5054 / #5060.
 *
 * #6211 generalised the fix: the rail moved out of ConfigurationTab.module.css
 * and into the shared `SectionNav.module.css`, so every picker surface
 * (Automation, Settings, Notifications, Admin Commands, the MeshCore views)
 * gets it by wrapping its nav + content in `.shell` / `.body`. These tests run
 * the real declarations through the shared cascade resolver, because "the rule
 * is in the file" and "the rule wins" are different claims and every bug in
 * this family was the second one failing.
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

// The rail now lives with the component.
const moduleCss = readFileSync(resolve('src/components/SectionNav.module.css'), 'utf-8');
const resolveModule = createResolver(moduleCss);

// The shell sheets the rail has to agree with about where the fixed header ends.
const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
const resolveApp = createResolver(appCss);
const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');
const resolveNodes = createResolver(nodesCss);

/**
 * The resolver escapes only `.[]\`, so it cannot parse the `:global(...)`
 * selector the rail uses for the nav column. Pull that rule's body out by hand
 * instead; its gating lives with `.shell` (same media block), asserted below.
 */
const navRuleBody =
  moduleCss
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/\.shell\s+:global\(\.section-nav\)\s*\{([^}]*)\}/)?.[1] ?? '';

/** Names the custom property a declaration offsets the fixed header by. */
function headerVarUsedBy(declaration: string | null): string | null {
  return declaration?.match(/var\((--app-header-height|--header-height)\b/)?.[1] ?? null;
}

const LANDSCAPE_VIEWPORTS: Array<[string, Viewport]> = [
  ['landscape phone', LANDSCAPE_PHONE],
  ['landscape big phone', LANDSCAPE_BIG_PHONE],
  ['landscape small phone', LANDSCAPE_SMALL_PHONE],
];

describe('the picker becomes a left rail in landscape (#5069/#6211)', () => {
  it.each(LANDSCAPE_VIEWPORTS)('puts picker and form side by side on a %s', (_name, vp) => {
    // The whole fix in one assertion: the picker stops being a block above the
    // form and becomes a column beside it.
    expect(resolveModule('.shell', 'display', vp)).toBe('flex');
    // A stretched flex item cannot stick — without this the rail is pinned to
    // the top of a full-height box and never follows the scroll.
    expect(resolveModule('.shell', 'align-items', vp)).toBe('flex-start');
  });

  it('gives the rail a fixed narrow width', () => {
    // 160px of the abundant axis. At 844px wide that leaves ~660px for the
    // form — more than the desktop content column ever uses.
    expect(navRuleBody).toMatch(/\bwidth:\s*160px/);
    expect(navRuleBody).toMatch(/\bflex:\s*0 0 160px/);
    expect(navRuleBody).toMatch(/\bflex-direction:\s*column/);
  });

  it('lets the rail scroll itself', () => {
    // With 28 categories the rail overflows. It must scroll independently —
    // a rail that grows the page is just the old grid rotated.
    expect(navRuleBody).toMatch(/\boverflow-y:\s*auto/);
    expect(navRuleBody).toMatch(/\boverflow-x:\s*hidden/);
    // Derived from the shell's own variables, never a magic pixel count, so it
    // stays correct if the header or bottom bar is re-measured (#5070/#5053).
    expect(navRuleBody).toContain(
      'max-height: calc(100dvh - var(--app-header-height) - var(--app-nav-bar-height) - 0.5rem)'
    );
  });

  it.each(LANDSCAPE_VIEWPORTS)('lets the form take the remaining width on a %s', (_name, vp) => {
    expect(resolveModule('.body', 'flex', vp)).toBe('1 1 auto');
    // Without min-width:0 a wide child (the channel table) would refuse to
    // shrink and push the rail off screen.
    expect(resolveModule('.body', 'min-width', vp)).toBe('0');
  });

  it('leaves portrait alone', () => {
    // 160px out of a 390px-wide phone is not spare width. Portrait keeps the
    // App.css chip row, so every rail declaration must resolve to nothing.
    expect(resolveModule('.shell', 'display', PORTRAIT_PHONE)).toBeNull();
    expect(resolveModule('.body', 'flex', PORTRAIT_PHONE)).toBeNull();
  });

  it('leaves desktop alone', () => {
    // Desktop is tall enough that the wrapping grid costs nothing worth
    // reclaiming, and the two-column GPIO layout already owns the width.
    expect(resolveModule('.shell', 'display', DESKTOP)).toBeNull();
    expect(resolveModule('.body', 'flex', DESKTOP)).toBeNull();
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
    // so the rail wins on specificity instead: `.shell :global(.section-nav)`
    // is 0,2,0 against `.section-nav`'s 0,1,0. If someone drops the `.shell`
    // scope, the small landscape phone silently reverts to a chip row.
    expect(mediaMatches('(max-width: 768px)', LANDSCAPE_SMALL_PHONE)).toBe(true);
    expect(moduleCss).toContain('.shell :global(.section-nav)');
    expect(navRuleBody).toMatch(/\bflex-wrap:\s*nowrap/);
    expect(navRuleBody).toMatch(/\bflex-direction:\s*column/);
  });
});

/**
 * The rail is sticky, so where it parks is a "content starts below the fixed
 * header" question — the same one `.app-main`, `.nodes-split-view` and the
 * banner stack ask, and the one #5070 exists to answer once.
 *
 * #6211 deliberately does NOT re-answer it in the rail: the rail reshapes the
 * nav but leaves `top` to the base `.section-nav` rule in App.css, which
 * already parks below the fixed header via `--app-header-height`. (The MeshCore
 * pane views keep their own pane-relative `top` from MeshCoreSectionNav.) So
 * the #5070 guarantee is pinned at its real source — the base rule — and the
 * rail is pinned to not override it.
 */
describe('the sticky rail parks below the whole header, not the constant (#5070)', () => {
  it('does not set its own `top` — it inherits the base rule', () => {
    expect(navRuleBody).not.toMatch(/\btop:/);
  });

  it.each(LANDSCAPE_VIEWPORTS)('the base nav parks below the real header on a %s', (_name, vp) => {
    expect(headerVarUsedBy(resolveApp('.section-nav', 'top', vp))).toBe('--app-header-height');
  });

  it.each(LANDSCAPE_VIEWPORTS)('agrees with the rest of the shell on a %s', (_name, vp) => {
    // The relationship, stated directly. If someone repoints one of these and
    // not the others, the rail and the page disagree about where the bar ends
    // — which is exactly how #5070 and #5053 happened.
    const shellVar = headerVarUsedBy(resolveApp('.app-main', 'padding-top', vp));
    expect(shellVar).toBe('--app-header-height');
    expect(headerVarUsedBy(resolveNodes('.nodes-split-view', 'top', vp))).toBe(shellVar);
    expect(headerVarUsedBy(resolveApp('.section-nav', 'top', vp))).toBe(shellVar);
  });

  it('offsets the rail height by the real header height too', () => {
    // Same question asked downward: under-counting the bar runs the rail's own
    // scroll area past the bottom of the screen.
    expect(headerVarUsedBy(navRuleBody.match(/max-height:\s*([^;]+)/)?.[1] ?? null)).toBe(
      '--app-header-height'
    );
  });

  it('does not disturb portrait or desktop, where the rail does not exist', () => {
    // The rail declarations resolve to nothing outside landscape, so the
    // App.css chip row keeps owning the surface — and it offsets by the same
    // variable.
    for (const vp of [PORTRAIT_PHONE, DESKTOP]) {
      expect(resolveModule('.shell', 'display', vp)).toBeNull();
      expect(resolveModule('.body', 'flex', vp)).toBeNull();
      expect(headerVarUsedBy(resolveApp('.section-nav', 'top', vp))).toBe('--app-header-height');
    }
  });
});

describe('selected category stays visible (#5069)', () => {
  it('highlights the active button at every viewport', () => {
    // Unconditional on purpose: a scrolling picker needs the highlight, and a
    // static one is no worse for having it.
    for (const vp of [PORTRAIT_PHONE, LANDSCAPE_PHONE, DESKTOP]) {
      expect(resolveModule('.active.active', 'background', vp)).toBe('var(--color-accent)');
      expect(resolveModule('.active.active', 'color', vp)).toBe('var(--color-accent-text)');
    }
  });

  it('doubles the class so it beats .section-nav-item in App.css', () => {
    expect(moduleCss).toContain('.active.active');
  });
});
