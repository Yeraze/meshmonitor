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
    // The alternative fix in the issue. `--header-height` is a constant every
    // other surface offsets from, and App.css deliberately shrinks it to 40px
    // in landscape where vertical space is scarce — growing it here would
    // fight #5053.
    const appCss = readFileSync(resolve('src/App.css'), 'utf-8');
    const landscape = appCss.slice(
      appCss.indexOf('@media (max-height: 500px) and (orientation: landscape)')
    );
    expect(landscape).toMatch(/--header-height:\s*40px/);
    // Nothing in the mobile header block grows the bar.
    expect(mobileRule('.app-header')).not.toMatch(/min-height/);
  });
});
