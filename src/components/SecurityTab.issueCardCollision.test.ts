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
    const info = ruleBody(security, '.security-tab .node-info');
    const name = ruleBody(security, '.security-tab .node-name');
    expect(info, '.security-tab .node-info rule missing').not.toBeNull();
    expect(name, '.security-tab .node-name rule missing').not.toBeNull();
    expect(info!).toMatch(/display:\s*block/);
    expect(name!).toMatch(/display:\s*block/);
    // `min-width: 0` keeps a long node name from forcing the card wider than
    // the viewport now that it is a block again.
    expect(name!).toMatch(/min-width:\s*0/);
  });

  it('does not leave an unscoped .node-info / .node-name rule behind', () => {
    // A bare rule is (0,1,0) — the same specificity as the globals, decided by
    // sheet order, which is exactly the fragility this fix removes.
    expect(ruleBody(security, '.node-info')).toBeNull();
    expect(ruleBody(security, '.node-name')).toBeNull();
  });

  it('scopes the mobile override so it still outranks the base rule', () => {
    const mobile = security.slice(security.indexOf('@media (max-width: 768px)'));
    expect(ruleBody(mobile, '.security-tab .node-info')).toMatch(/flex-basis:\s*100%/);
  });
});
