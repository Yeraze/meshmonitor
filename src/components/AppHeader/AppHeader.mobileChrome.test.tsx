/**
 * @vitest-environment jsdom
 *
 * #5051: on a narrow viewport the cycling connection badge overflowed the
 * header row and the "Sources" back button was hard-clipped to "Sourc…".
 *
 * Two things had to be true for that to happen, and both are asserted here:
 * the badge reserved ~90px of width it did not need on a phone, and the back
 * button was allowed to shrink inside an `overflow: hidden` row, so the
 * overflow landed on it as a clip rather than on the element designed to
 * ellipsise. jsdom does no layout and no media queries, so the geometry half
 * is asserted against the stylesheet and the markup half against the render.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CyclingConnectionStatus } from './CyclingConnectionStatus';
import {
  createResolver,
  type Viewport,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  LANDSCAPE_BIG_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
} from '../../styles/cssCascadeResolver';

const css = readFileSync(resolve('src/components/AppHeader/AppHeader.css'), 'utf-8');

/** Body of `selector`'s rule inside the `@media (max-width: 768px)` block. */
function mobileRule(selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = clean.indexOf('@media (max-width: 768px)');
  expect(start).toBeGreaterThan(-1);
  // The mobile block ends where the next top-level @media begins.
  const next = clean.indexOf('@media', start + 1);
  const block = clean.slice(start, next === -1 ? undefined : next);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`(?:^|[},])\\s*${escaped}[^{}]*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
}

/** Body of a rule outside any media query. */
function baseRule(selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const upToFirstMedia = clean.slice(0, clean.indexOf('@media'));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return upToFirstMedia.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

const METRICS = { batteryLevel: 101, voltage: 4.38, channelUtilization: 12.3, airUtilTx: 4.5 };

describe('header connection badge on narrow viewports (#5051)', () => {
  it('wraps every badge face in a class the sheet can collapse', () => {
    // A bare text node cannot be targeted by CSS — the collapse depends on
    // these wrappers existing, so a refactor that drops them must fail here.
    const { container } = render(
      <CyclingConnectionStatus
        connectionStatus="connected"
        connectionStatusText="connected"
        webSocketConnected
        metrics={METRICS}
        onClick={() => {}}
        title="t"
      />
    );
    // Face 0 is the plain status text.
    expect(container.querySelector('.connection-status-label .status-text')).not.toBeNull();
    expect(container.querySelector('.connection-status-label .status-text')?.textContent).toBe(
      'connected'
    );
  });

  it('wraps the metric faces too', () => {
    // Render the battery face directly by giving it battery-only metrics and
    // reaching the second face is timer-driven; instead assert the source
    // contains the wrapper for both metric branches.
    const source = readFileSync(resolve('src/components/AppHeader/CyclingConnectionStatus.tsx'), 'utf-8');
    const wrappers = source.match(/className="status-metric-text"/g) ?? [];
    expect(wrappers.length).toBe(2); // battery face + airtime face
  });

  it('hides the badge text on mobile without dropping it from the a11y tree', () => {
    const rule = mobileRule('.connection-status-label .status-text');
    expect(rule).not.toBe('');
    // `display: none` would leave a screen reader with a colored dot and
    // nothing to announce.
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  it('releases the width the badge reserved for its longest face', () => {
    // The base rule pins 5.5rem so the badge does not jump as text faces
    // rotate. With the text hidden that reservation is pure overflow: it is
    // most of what pushed the row past a 390px viewport.
    const base = baseRule('.connection-status-label');
    const baseMin = Number(base.match(/min-width:\s*([\d.]+)rem/)?.[1]);
    expect(baseMin).toBe(5.5);

    const mobile = mobileRule('.connection-status-label');
    const mobileMin = Number(mobile.match(/min-width:\s*([\d.]+)rem/)?.[1]);
    expect(Number.isFinite(mobileMin)).toBe(true);
    expect(mobileMin).toBeLessThan(baseMin);
    // Still reserves the icon slot, so the badge does not jitter as the face
    // rotates between "no icon" (status) and "icon" (battery/airtime).
    expect(mobileMin).toBeGreaterThan(0);
  });

  it('never lets the Sources back button be the element that gives way', () => {
    // `.header-left` is overflow:hidden, so a shrinkable back button is
    // clipped mid-word rather than ellipsised — the reported "Sourc…".
    expect(baseRule('.back-to-sources-btn')).toMatch(/flex-shrink:\s*0/);
    // The element that is *supposed* to absorb the squeeze still can.
    const name = baseRule('.header-source-name');
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/min-width:\s*0/);
  });

  it('does not make the header taller to buy the room', () => {
    // The alternative fix in the issue. `--header-height` is the DESIGN height
    // of the header's control strip, and App.css deliberately shrinks it to
    // 40px in landscape where vertical space is scarce — growing it here would
    // fight #5053.
    //
    // Still true after #5070, which did NOT change this variable. #5070 added a
    // second one, `--app-header-height` (the bar's real on-screen height,
    // inset included and measured at runtime), and moved the offsets onto it.
    // Surfaces below the bar no longer read the constant asserted here, so this
    // test constrains presentation only — exactly what it was written to do.
    const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
    const landscape = appCss.slice(
      appCss.indexOf('@media (max-height: 500px) and (orientation: landscape)')
    );
    expect(landscape).toMatch(/--header-height:\s*40px/);
    // Nothing in the mobile header block grows the bar.
    expect(mobileRule('.app-header')).not.toMatch(/min-height/);
  });
});

/**
 * #5051 reopened against v4.16.0-rc3, still portrait.
 *
 * The badge no longer clipped the back button, but a long source name in the
 * chip collided with the connection dot. Measured on the real page at 390x844
 * with "Heltec LF listener": the chip's border box ran to x=233 while the dot
 * occupied 205–221, so the dot's rect sat *inside* the chip's.
 *
 * The mechanism was not a missing `max-width`. `.header-title` is a flex item
 * and so defaults to `min-width: auto` — it refuses to shrink below its
 * content-based minimum, and `.header-source-name`'s `max-width` (30vw on
 * phones) set that minimum at ~117px. `.header-left` therefore could not
 * shrink it, overflowed its own content box, and its `overflow: hidden` cut
 * the name off at exactly the boundary where `.header-right` — and the dot —
 * begins. The name never ellipsised because its own box was never short of
 * room; its ancestor was.
 *
 * Note `document.elementFromPoint` at the dot's centre returned the dot even
 * *before* the fix, because the clip hides the offending pixels: hit-testing
 * cannot see this bug, only rect geometry can. So these tests assert the two
 * structural properties that make the collision impossible at any name length:
 * the shrink chain from the row down to the name is unbroken, and the two
 * halves of the row are separated by a real gap.
 *
 * jsdom does no layout and no media queries, so the resolved-declaration
 * resolver stands in for measurement (same approach as
 * `src/styles/dashboardMobileDrawer.test.ts`).
 */
describe('long source name never collides with the connection dot (#5051 rc3)', () => {
  const resolveDecl = createResolver(css);

  /** Smallest phone width still in circulation; iPhone SE 1st gen. */
  const NARROW_PHONE: Viewport = { width: 320, height: 568 };

  const viewports: Array<[string, Viewport]> = [
    ['narrow portrait phone (320)', NARROW_PHONE],
    ['portrait phone (390)', PORTRAIT_PHONE],
    ['landscape small phone (667)', LANDSCAPE_SMALL_PHONE],
    ['landscape phone (844)', LANDSCAPE_PHONE],
    ['landscape big phone (915)', LANDSCAPE_BIG_PHONE],
    ['desktop', DESKTOP],
  ];

  it.each(viewports)('keeps the shrink chain unbroken on a %s', (_label, vp) => {
    // Both boxes between the flex row and the name must be allowed to shrink.
    // `.header-left` already was (#5016); `.header-title` was the broken link,
    // and it defaults to `auto` if the declaration is ever dropped.
    expect(resolveDecl('.header-left', 'min-width', vp)).toBe('0');
    expect(resolveDecl('.header-title', 'min-width', vp)).toBe('0');
    // ...so that this is the element that actually runs out of room.
    expect(resolveDecl('.header-source-name', 'min-width', vp)).toBe('0');
    expect(resolveDecl('.header-source-name', 'text-overflow', vp)).toBe('ellipsis');
    expect(resolveDecl('.header-source-name', 'overflow', vp)).toBe('hidden');
  });

  it.each(viewports)('separates the two halves of the row on a %s', (_label, vp) => {
    // `.header-left` is `overflow: hidden`, so its right edge is a clip plane.
    // Without a gap that plane is exactly the dot's left edge and clipped text
    // lands against the indicator — which is what the rc3 screenshots show.
    const gap = resolveDecl('.app-header', 'gap', vp);
    expect(gap).not.toBeNull();
    const rem = Number(/^([\d.]+)rem$/.exec(gap!)?.[1]);
    expect(rem).toBeGreaterThan(0);
  });

  it.each(viewports)('never lets the status dot itself be squeezed on a %s', (_label, vp) => {
    // An empty span's automatic minimum size is 0, so a shrinkable dot can be
    // compressed away entirely. A hidden connection state is worse than a
    // truncated name — the dot is the one thing that must not give.
    expect(resolveDecl('.status-indicator', 'flex-shrink', vp)).toBe('0');
    // ...and #5058's guarantee still holds: the back button is not the element
    // that absorbs the squeeze either.
    expect(resolveDecl('.back-to-sources-btn', 'flex-shrink', vp)).toBe('0');
    // The clip is the backstop if some future child refuses to shrink.
    expect(resolveDecl('.header-left', 'overflow', vp)).toBe('hidden');
  });

  it('does not spend the row on a margin the flex gap already provides', () => {
    // `.user-menu` carries a global `margin-left: 16px` from before the row had
    // a gap. `.header-right` is `flex-shrink: 0`, so those 16px come straight
    // out of the half that has to hold the name — enough, at 320px, to push the
    // chip back over the dot.
    expect(resolveDecl('.header-right .user-menu', 'margin-left', NARROW_PHONE)).toBe('0');
    expect(resolveDecl('.header-right .user-menu', 'margin-left', PORTRAIT_PHONE)).toBe('0');
    const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
    // Guard the assumption: if App.css ever drops that margin, this override is
    // dead weight and should go with it.
    expect(appCss).toMatch(/\.user-menu\s*\{[^}]*margin-left:\s*16px/);
  });
});
