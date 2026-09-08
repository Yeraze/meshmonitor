/**
 * Chart panel layout in narrow portrait viewports (#5093).
 *
 * On a phone in portrait, the chart cards on the Node Info page ran off the
 * right edge — the plotted line spilled past the viewport and the header
 * controls were clipped — while landscape looked fine. Two independent
 * min-content floors caused it, and each has a non-obvious fix that is very
 * easy to "tidy up" back into the broken form:
 *
 *   1. A grid item defaults to `min-width: auto`, so `.graph-container` sized
 *      to its own contents rather than the track. Writing the mobile track as
 *      bare `1fr` does NOT help: `1fr` means `minmax(auto, 1fr)`, and that
 *      `auto` floor is the very thing being escaped.
 *   2. `.graph-title` reserved a fixed `calc(100% - 60px)` for "the favorite
 *      and menu buttons". A TelemetryGraphs header now renders up to six
 *      controls (~182px), so the title over-claimed and pushed them off-screen.
 *
 * This is a pure-CSS fix with no JS behaviour to assert, so the stylesheet is
 * checked directly — the same approach BeaconOffersPanel.test.tsx uses to guard
 * its own CSS module. Rendering cannot cover it: jsdom has no layout engine, so
 * a reintroduced min-content floor would still "pass" a render test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Comments are stripped first: these rules are heavily commented, and the
// comments quote the very declarations being asserted absent (e.g. the old
// `max-width: calc(...)`), which would otherwise match.
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'TelemetryGraphs.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first rule whose selector list contains `selector`. */
const ruleBody = (selector: string, from = 0): string => {
  const re = new RegExp(`(^|\\})[^{}]*\\${selector}\\b[^{}]*\\{([^}]*)\\}`, 'm');
  const match = re.exec(css.slice(from));
  expect(match, `rule for ${selector} not found`).not.toBeNull();
  return match![2];
};

describe('TelemetryGraphs.css — narrow-viewport overflow (#5093)', () => {
  it('lets .graph-container shrink below its content width', () => {
    // Without this a card sizes to min-content (measured 307-502px) and any
    // card wider than the viewport spills off the right edge in portrait.
    expect(ruleBody('.graph-container')).toMatch(/min-width:\s*0/);
  });

  it('zeroes the mobile grid track floor with minmax(0, 1fr), not bare 1fr', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    const grid = /\.graphs-grid\s*\{([^}]*)\}/.exec(mobile);
    expect(grid, '.graphs-grid override missing from the mobile media query').not.toBeNull();
    expect(grid![1]).toMatch(/grid-template-columns:\s*minmax\(\s*0\s*,\s*1fr\s*\)/);
    // `1fr` on its own is `minmax(auto, 1fr)` and reintroduces the floor.
    expect(grid![1]).not.toMatch(/grid-template-columns:\s*1fr\s*;/);
  });

  it('sizes .graph-title by flex rather than reserving a fixed pixel budget', () => {
    const title = ruleBody('.graph-title');
    // A hard-coded reservation cannot track how many controls a header renders,
    // which is what pushed them off-screen once the mode-toggle group landed.
    expect(title).not.toMatch(/max-width:\s*calc\(/);
    expect(title).toMatch(/flex:\s*1\s+1\s+auto/);
    // Required for `text-overflow: ellipsis` to engage — a flex item's default
    // `min-width: auto` floors it at min-content and the title never truncates.
    expect(title).toMatch(/min-width:\s*0/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('keeps .graph-actions at its natural width so the title gives way instead', () => {
    expect(ruleBody('.graph-actions')).toMatch(/flex:\s*0\s+0\s+auto/);
  });
});
