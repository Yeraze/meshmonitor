/**
 * Regression tests for content sitting UNDER the mobile bottom bar (#4473 phase 2).
 *
 * Moving the Meshtastic phone nav from a left rail to a bottom bar means every
 * full-height surface has to reserve space at the bottom instead of the left.
 * Two surfaces opt out of the normal `.app-main` flow and were missed on the
 * first pass — both were reported/found only by driving the running app:
 *
 *   1. Channels tab — `.app-main:has(.channels-tab-content)` zeroed its
 *      padding-bottom (correct when nothing occupied the bottom strip), which
 *      ran the compose row's send/location/bell buttons under the bar.
 *   2. DM tab — `.messages-split-view { height: 100% }` over-constrained the
 *      `position: fixed` top/bottom pair it inherits from `.nodes-split-view`,
 *      so height won, `bottom` was ignored, and the box overshot the viewport.
 *
 * jsdom does no layout and no cascade, so these read the stylesheet source, in
 * the same style as the other stylesheet assertions under src/ (see
 * NodesTab.test.tsx). They are cheap guards on the two specific declarations
 * whose regression is invisible until someone opens the tab on a phone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');

/** Body of a rule, searched by exact selector text at any indent. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

describe('mobile bottom-bar clearance (#4473)', () => {
  it('the channels tab reserves the bar height instead of zeroing it', () => {
    const body = ruleBody(appCss, '.app-main:has(.channels-tab-content)');
    expect(body).not.toBeNull();

    const pb = body!.match(/padding-bottom:\s*([^;]+)/)?.[1].trim();
    expect(pb).toBeDefined();
    // A flat `0` is what put send/location/bell under the bar.
    expect(pb).not.toBe('0');
    expect(pb).toMatch(/var\(--app-nav-bar-height/);
    // The safe-area inset is deliberately NOT repeated here — .send-message-form
    // already applies it, and doubling it leaves dead space below the input.
    expect(pb).not.toMatch(/env\(safe-area-inset-bottom/);
  });

  it('the DM split view lets its fixed top/bottom pair define the box', () => {
    // Scoped to the mobile block: the desktop rule has no height declaration.
    const mobile = nodesCss.slice(nodesCss.indexOf('@media (max-width: 768px)'));
    const body = ruleBody(mobile, '.messages-split-view');
    expect(body).not.toBeNull();

    const h = body!.match(/(?:^|;)\s*height:\s*([^;]+)/)?.[1].trim();
    expect(h).toBeDefined();
    // `100%` over-constrains position:fixed + top + bottom; height wins and the
    // box overshoots the viewport, hiding the compose row behind the bar.
    expect(h).not.toBe('100%');
    expect(h).toBe('auto');
  });

  it('the map/list split view clears the bar', () => {
    const mobile = nodesCss.slice(nodesCss.indexOf('@media (max-width: 768px)'));
    const body = ruleBody(mobile, '.nodes-split-view');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/bottom:\s*calc\([^;]*--app-nav-bar-height/);
    // The old left-rail offset must be gone — the rail no longer exists.
    expect(body!).not.toMatch(/left:\s*48px/);
  });

  it('app-main reserves the bar height in both mobile orientations', () => {
    // Portrait block and landscape block each declare their own bar height.
    const portrait = appCss.slice(appCss.indexOf('@media (max-width: 768px)'));
    expect(portrait).toMatch(/--app-nav-bar-height:\s*56px/);
    expect(appCss).toMatch(/--app-nav-bar-height:\s*44px/);
    // And --sidebar-width collapses so horizontal offsets stop reserving a rail.
    expect(appCss).toMatch(/--sidebar-width:\s*0px\s*!important/);
  });
});
