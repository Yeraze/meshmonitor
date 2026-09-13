/**
 * Security issue cards vs. two global class-name collisions.
 *
 * `.node-info` and `.node-name` are generic names that two other global sheets
 * also claim, and both turn the element into a flex row:
 *
 *   AppHeader.css  `.node-info { display: flex; align-items: center }`
 *   nodes.css      `.node-name { display: flex; flex: 1; min-width: 0 }`
 *
 * SecurityTab.css never declared `display`, so those won by default. A Security
 * issue card's three stacked lines (name / node id / last seen) were laid out
 * side by side, and the name — `flex: 1` with `min-width: 0` in a row too narrow
 * to hold it — collapsed to zero width and rendered on top of the node id.
 * Desktop hid it: the card is wide enough for the row to fit.
 *
 * jsdom applies no cascade across stylesheets, so a render test cannot catch
 * this. The stylesheet is asserted directly, the way
 * TelemetryGraphs.layout.test.ts guards #5093.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const security = strip(readFileSync(join(here, '../styles/SecurityTab.css'), 'utf8'));
const appHeader = strip(readFileSync(join(here, 'AppHeader/AppHeader.css'), 'utf8'));
const nodes = strip(readFileSync(join(here, '../styles/nodes.css'), 'utf8'));

const ruleBody = (source: string, selector: string): string | null => {
  const re = new RegExp(`(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(source)?.[2] ?? null;
};

describe('Security issue card layout vs. global class collisions', () => {
  it('still has the collision it is defending against', () => {
    // If either of these stops being true the guard below is dead weight and
    // the scoping can be reconsidered — but do not quietly drop it first.
    expect(ruleBody(appHeader, '.node-info')).toMatch(/display:\s*flex/);
    expect(ruleBody(nodes, '.node-name')).toMatch(/display:\s*flex/);
  });

  it('states the stacked layout explicitly, scoped above the bare globals', () => {
    // The two selectors share one rule body, so match the block directly rather
    // than through `ruleBody` (which escapes its argument as a literal).
    const guard = /\.security-tab \.issue-header \.node-info\s*,\s*\.security-tab \.issue-header \.node-name\s*\{([^}]*)\}/
      .exec(security)?.[1] ?? null;
    expect(guard, 'issue-card layout guard missing').not.toBeNull();
    expect(guard!).toMatch(/display:\s*block/);
    // `min-width: 0` keeps a long node name from forcing the card wider than
    // the viewport now that it is a block again.
    expect(guard!).toMatch(/min-width:\s*0/);
  });

  it('keeps the guard off the Top Broadcasters table cells', () => {
    // `.node-name` is also a <td> class in `.top-broadcasters-table`. Widening
    // the guard to `.security-tab .node-name` would change that cell's display
    // as a side effect of a fix that has nothing to do with it.
    expect(security).not.toMatch(/\.security-tab \.node-(info|name)\s*[,{]/);
  });

  it('leaves .node-info a live flex item of the header row', () => {
    // `.issue-header` is `display: flex`, so `.node-info` is a flex ITEM. The
    // `display: block` above governs its own children, not its participation in
    // that row — `flex: 1` is still what makes it fill the card.
    expect(ruleBody(security, '.node-info')).toMatch(/flex:\s*1/);
  });
});
