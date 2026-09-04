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

describe('compact-landscape breakpoint is a single number (#5053)', () => {
  /**
   * The shell had two competing definitions of "compact landscape" — 500px in
   * App.css/AppHeader.css/SourceNav/SaveBar and 700px in Sidebar.css and
   * SidebarFooter.module.css — so a viewport 501–700px tall in landscape got
   * half of each layout. `src/utils/sidebarWidth.ts` mirrors the 500px query in
   * JS, so 500px is the number the rest of the app already agrees on.
   */
  const sheets = [
    'src/App.css',
    'src/styles/dashboard.css',
    'src/components/Sidebar.css',
    'src/components/SidebarFooter.module.css',
    'src/components/AppHeader/AppHeader.css',
    'src/components/nav/SourceNav.module.css',
    'src/components/SaveBar/SaveBar.css',
  ];

  it.each(sheets)('%s uses max-height: 500px for every landscape query', (sheet) => {
    const text = readFileSync(resolve(sheet), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const landscapeQueries = [...text.matchAll(/@media([^{]*orientation:\s*landscape[^{]*)\{/g)].map(
      (m) => m[1]
    );
    for (const q of landscapeQueries) {
      for (const [, value] of q.matchAll(/max-height:\s*(\d+)px/g)) {
        expect(Number(value), `${sheet}: @media${q}`).toBe(500);
      }
    }
  });

  it('matches the threshold the JS mirror uses', async () => {
    const { MOBILE_LANDSCAPE_MAX_HEIGHT_PX } = await import('../utils/sidebarWidth.js');
    expect(MOBILE_LANDSCAPE_MAX_HEIGHT_PX).toBe(500);
  });
});
