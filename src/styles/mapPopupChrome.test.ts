/**
 * Regression tests for the map popup's duplicate card chrome (#4677).
 *
 * A map node popup is two nested boxes: Leaflet's `.leaflet-popup-content-wrapper`
 * and, inside it, the app's `.node-popup` (rendered by `NodeCard` for every map
 * surface). Both used to paint a full card — background + border + radius +
 * shadow — so the popup showed a visible card-inside-a-card: double border,
 * double corner radius, uneven inset.
 *
 * The wrapper is the single card shell; `.node-popup` keeps its own chrome
 * (TracerouteStrip's portalled hover popup and DashboardNeighborPopup render it
 * with no shell of their own) but drops it when nested inside a Leaflet popup.
 *
 * jsdom does no layout and no cascade, so these read the stylesheet source, in
 * the same style as the other stylesheet assertions under src/ (see
 * bottomBarClearance.test.ts and NodesTab.test.tsx).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nodesCss = readFileSync(resolve('src/styles/nodes.css'), 'utf-8');

/** Body of a rule, searched by exact selector text at any indent. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

describe('map popup card chrome (#4677)', () => {
  it('strips the inner card chrome from a .node-popup nested in a Leaflet popup', () => {
    const body = ruleBody(nodesCss, '.leaflet-popup-content .node-popup');
    expect(body).not.toBeNull();

    // Each of these is also declared by .leaflet-popup-content-wrapper; leaving
    // any one of them on the inner card is what draws the second card.
    expect(body).toMatch(/(?:^|;)\s*background:\s*none/);
    expect(body).toMatch(/(?:^|;)\s*border:\s*none/);
    expect(body).toMatch(/(?:^|;)\s*border-radius:\s*0/);
    expect(body).toMatch(/(?:^|;)\s*box-shadow:\s*none/);
  });

  it('keeps the standalone .node-popup chrome for consumers with no shell', () => {
    // TracerouteStrip's `.hoverPopup` is a bare portalled div and
    // DashboardNeighborPopup renders inline — both rely on this base rule, so
    // the fix must stay scoped rather than stripping the base.
    const body = ruleBody(nodesCss, '.node-popup');
    expect(body).not.toBeNull();
    expect(body).toMatch(/background:\s*var\(--color-surface\)/);
    expect(body).toMatch(/border:\s*1px solid/);
  });

  it('hands the popup inset to the inner card so it is even on all sides', () => {
    // Leaflet's defaults (wrapper padding 1px + content margin 13/24/13/20)
    // stacked with .node-popup's own 12px padding for the uneven inset.
    const wrapper = ruleBody(nodesCss, '.leaflet-popup-content-wrapper:has(.node-popup)');
    expect(wrapper).toMatch(/padding:\s*0/);
    expect(ruleBody(nodesCss, '.leaflet-popup-content:has(> .node-popup)')).toMatch(/margin:\s*0/);

    // Zeroing the content margin removes the gap Leaflet's absolutely
    // positioned close button used to sit in, so the header reserves it.
    const header = nodesCss.match(
      /\.leaflet-popup-content \.node-popup > \.node-popup-header,[^{]*\{([^}]*)\}/,
    )?.[1];
    expect(header).toMatch(/padding-right:\s*\d+px/);
  });

  it('clips the inner card to the wrapper radius', () => {
    // Without this the inner card's square corners poke through the wrapper's
    // rounded ones. The close button is a child of `.leaflet-popup`, not of the
    // wrapper, so it is not clipped by this.
    expect(ruleBody(nodesCss, '.leaflet-popup-content-wrapper:has(.node-popup)')).toMatch(
      /overflow:\s*hidden/,
    );
  });

  it('leaves popups that are not a .node-popup on Leaflet defaults', () => {
    // `.route-popup` (NodesTab position segments / neighbor links) declares no
    // padding of its own, so zeroing the content margin for every popup would
    // push its text flush against the card edge. Every override is `:has()`-gated.
    const base = ruleBody(nodesCss, '.leaflet-popup-content-wrapper');
    expect(base).not.toMatch(/padding:/);
    expect(base).not.toMatch(/overflow:/);
    expect(ruleBody(nodesCss, '.route-popup')).not.toBeNull();
  });
});

describe('map popup overflow (#4677)', () => {
  it('scrolls the body rather than the whole card, keeping the header pinned', () => {
    const card = ruleBody(nodesCss, '.leaflet-popup-content .node-popup:has(> .node-popup-content)');
    expect(card).not.toBeNull();
    expect(card).toMatch(/display:\s*flex/);
    expect(card).toMatch(/flex-direction:\s*column/);

    const content = ruleBody(nodesCss, '.leaflet-popup-content .node-popup > .node-popup-content');
    expect(content).not.toBeNull();
    expect(content).toMatch(/overflow-y:\s*auto/);
    // Without min-height:0 the flex child refuses to shrink below its content
    // height and nothing scrolls at all.
    expect(content).toMatch(/min-height:\s*0/);
  });

  it('keeps a styled scrollbar on the element that actually scrolls', () => {
    // The card-level `.node-popup::-webkit-scrollbar` rules no longer apply
    // once the scroll box moves to the body. An explicit width is also what
    // opts Chromium out of overlay scrollbars, so the thumb stays on screen.
    const track = ruleBody(
      nodesCss,
      '.leaflet-popup-content .node-popup > .node-popup-content::-webkit-scrollbar',
    );
    expect(track).toMatch(/width:\s*6px/);
    expect(
      ruleBody(
        nodesCss,
        '.leaflet-popup-content .node-popup > .node-popup-content::-webkit-scrollbar-thumb',
      ),
    ).toMatch(/background:/);
    expect(
      ruleBody(nodesCss, '.leaflet-popup-content .node-popup > .node-popup-content'),
    ).toMatch(/scrollbar-width:\s*thin/);
  });

  it('bounds a tall popup by the viewport and does not pan the map at the end of a scroll', () => {
    const body = ruleBody(nodesCss, '.leaflet-popup-content .node-popup');
    expect(body).toMatch(/max-height:\s*min\(400px,\s*60vh\)/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });
});
