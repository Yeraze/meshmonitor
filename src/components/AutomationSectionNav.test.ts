/**
 * Guards the Automation tab's SectionNav quick-links against drift.
 *
 * Regression: the Position Estimation section (issue #3271/#3349) was rendered
 * in the Automation tab as `<div id="position-estimation">` but was never added
 * to the `SectionNav` items list, so there was no quick-link to it and users
 * couldn't find the feature's settings.
 *
 * App.tsx is far too large to render in jsdom, so this is a static-source
 * invariant: every Automation nav item id must have a matching section anchor
 * (`id="..."`) in the file, and Position Estimation must be listed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readAppSource(): string {
  // Vitest runs from the repo root.
  return readFileSync(resolve('src/App.tsx'), 'utf8');
}

/** Extract the `items={[ ... ]}` array that immediately follows the
 *  `activeTab === 'automation'` block, and return the parsed nav item ids. */
function automationNavIds(src: string): string[] {
  const tabStart = src.indexOf("activeTab === 'automation'");
  expect(tabStart, "Automation tab block not found in App.tsx").toBeGreaterThan(-1);
  const itemsStart = src.indexOf('items={[', tabStart);
  expect(itemsStart, "SectionNav items array not found in Automation tab").toBeGreaterThan(-1);
  const itemsEnd = src.indexOf(']}', itemsStart);
  expect(itemsEnd, "Unterminated SectionNav items array").toBeGreaterThan(itemsStart);
  const block = src.slice(itemsStart, itemsEnd);
  return [...block.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('Automation tab SectionNav', () => {
  it('lists the Position Estimation section', () => {
    const ids = automationNavIds(readAppSource());
    expect(ids).toContain('position-estimation');
  });

  it('every nav item has a matching section anchor in the page', () => {
    const src = readAppSource();
    const ids = automationNavIds(src);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      // The rendered section wrapper is `<div id="<id>">`.
      expect(src, `missing <div id="${id}"> anchor for nav item '${id}'`).toContain(`id="${id}"`);
    }
  });
});
