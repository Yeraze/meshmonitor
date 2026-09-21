/**
 * Regression test for #5311 — the MeshCore page's mobile block must fire on
 * the same viewports as the shell's bottom bar.
 *
 * Three stylesheets decide whether the shell is in "bottom bar" mode, and they
 * have to agree. While MeshCorePage.css was width-only (`max-width: 768px`) it
 * missed landscape, where a phone is 956 CSS px wide: SourceNav drew its
 * full-width bottom bar while `.meshcore-page-body` stayed `flex-direction:
 * row`, so the bar consumed the whole flex row and the content pane got
 * nothing. Reported on an iOS 27 home-screen web app.
 *
 * jsdom implements no cascade and no media-query matching, so a render test
 * cannot catch a disagreement between two stylesheets — these assertions read
 * the source. Root-relative `resolve()` for the same reason as
 * `SourceNav.mobile.test.ts`: Vite rewrites `import.meta.url` to an http URL
 * here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Strip comments first — they quote the query text and would match. */
const read = (p: string) => readFileSync(resolve(p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

const sheets = {
  'MeshCorePage.css': read('src/components/MeshCore/MeshCorePage.css'),
  'Sidebar.css': read('src/components/Sidebar.css'),
  'SourceNav.module.css': read('src/components/nav/SourceNav.module.css'),
};

/** The one query that puts the shell in bottom-bar mode. */
const BAR_QUERY = '@media (max-width: 768px), (max-height: 500px) and (orientation: landscape)';

describe('MeshCore page mobile query (#5311)', () => {
  it.each(Object.keys(sheets))('%s declares the shared bottom-bar query', (name) => {
    expect(sheets[name as keyof typeof sheets]).toContain(BAR_QUERY);
  });

  it('flips the page body to column-reverse inside that query, not a width-only one', () => {
    const css = sheets['MeshCorePage.css'];
    const query = css.slice(css.indexOf(BAR_QUERY));
    expect(query).toMatch(/\.meshcore-page-body\s*\{[^}]*flex-direction:\s*column-reverse/);
  });

  it('leaves no width-only mobile block in MeshCorePage.css', () => {
    // `(max-width: 768px) {` with nothing after it is the exact shape that
    // skipped landscape. The shared query has a comma before its brace.
    expect(sheets['MeshCorePage.css']).not.toMatch(/@media\s*\(max-width:\s*768px\)\s*\{/);
  });
});
