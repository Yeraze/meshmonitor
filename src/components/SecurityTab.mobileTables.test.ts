/**
 * Security page tables on a phone (#5194).
 *
 * The tables had no scroll container. Their cells hold unbreakable content —
 * `!0aca5658` node IDs, `HELTEC_MESH_NODE_T114` hardware names — so the table's
 * min-content width ran past a phone viewport with nothing inside to absorb it,
 * and the overflow escaped to the document root. The reporter had to drag the
 * entire layout, sticky nav and all, to read one cell.
 *
 * jsdom has no layout engine, so a render test cannot see this: a reintroduced
 * overflow would still "pass". The stylesheet and the markup are asserted
 * directly, the same way TelemetryGraphs.layout.test.ts guards #5093.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Comments quote the declarations being asserted, so strip them first.
const css = readFileSync(join(here, '../styles/SecurityTab.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(here, 'SecurityTab.tsx'), 'utf8');

const ruleBody = (source: string, selector: string): string => {
  const re = new RegExp(`(^|\\})[^{}]*\\${selector}\\s*(,[^{}]*)?\\{([^}]*)\\}`, 'm');
  const match = re.exec(source);
  expect(match, `rule for ${selector} not found`).not.toBeNull();
  return match![3];
};

describe('SecurityTab mobile table overflow (#5194)', () => {
  it('wraps every Security table in a scroll container', () => {
    const tables = tsx.match(/<table className="top-broadcasters-table">/g) ?? [];
    const wrappers = tsx.match(/<div className="security-table-scroll">/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    // Top Broadcasters, Dead Nodes and Key Mismatch Events all use this table.
    expect(wrappers).toHaveLength(tables.length);
  });

  it('gives the wrapper its own horizontal scroll', () => {
    expect(ruleBody(css, '.security-table-scroll')).toMatch(/overflow-x:\s*auto/);
  });

  it('lets the page root shrink below its content width', () => {
    // A min-content floor here is how one over-wide table used to push the
    // whole page — sticky nav included — past the viewport.
    expect(ruleBody(css, '.security-tab')).toMatch(/min-width:\s*0/);
  });

  it('lets the digest inputs shrink instead of panning the page', () => {
    // `flex: 1` is `1 1 0%`, but a flex item's default `min-width: auto` floors
    // it at min-content — for an <input> that is its intrinsic `size`, ~222px.
    // Next to the 140px label that overflowed the card and left the whole page
    // panning 22px sideways even after the tables were fixed.
    expect(ruleBody(css, '.digest-input')).toMatch(/min-width:\s*0/);

    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(/\.digest-row\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? '').toMatch(/flex-wrap:\s*wrap/);
    expect(/\.digest-label\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? '').toMatch(/min-width:\s*0/);
  });

  it('floors the table width on mobile so it scrolls instead of truncating', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    const rule = /\.top-broadcasters-table\s*\{([^}]*)\}/.exec(mobile);
    expect(rule, '.top-broadcasters-table override missing from the mobile media query').not.toBeNull();
    expect(rule![1]).toMatch(/min-width:\s*\d+px/);
  });
});
