/**
 * Regression tests for the per-source page body row on phones.
 *
 * The defect: on a phone the Reticulum source page showed only its tab bar,
 * stretched over the whole screen, with no content. SourceNav had switched to
 * its full-width bottom bar, but Reticulum's own copy of the body row had no
 * mobile rule and stayed `flex-direction: row`, so the bar took the row and
 * the content pane got a width of 0. MeshCore had the rule (#5311); Reticulum
 * had copied the desktop half only.
 *
 * The row now has one owner, `SourceNavLayout`. These tests check that owner
 * flips under the same query as the bar, and that no in-flow source page keeps
 * a private row.
 *
 * jsdom implements no layout, no cascade and no media-query matching, so a
 * render test cannot measure the bar. These assertions read the source, the
 * same way `SourceNav.mobile.test.ts` does. Real layout needs a browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const read = (p: string) => readFileSync(resolve(p), 'utf-8');
/** Strip comments first — they quote the query and selector text. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const layoutCss = stripComments(read('src/components/nav/SourceNavLayout.module.css'));
const navCss = stripComments(read('src/components/nav/SourceNav.module.css'));

/** The one query that puts the shell in bottom-bar mode. */
const BAR_QUERY = '@media (max-width: 768px), (max-height: 500px) and (orientation: landscape)';

/** Every non-test .tsx under a directory, recursively. */
function tsxFiles(dir: string): string[] {
  return readdirSync(resolve(dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [p] : [];
  });
}

describe('SourceNavLayout body row', () => {
  it('lays the nav and content out as a flex row that can shrink', () => {
    const body = layoutCss.match(/\.body\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/min-height:\s*0/);
    const content = layoutCss.match(/\.content\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(content).toMatch(/flex:\s*1/);
    // Without these the pane cannot shrink below its content, in either axis.
    expect(content).toMatch(/min-width:\s*0/);
    expect(content).toMatch(/min-height:\s*0/);
  });

  it('uses the same bottom-bar query as SourceNav', () => {
    expect(navCss).toContain(BAR_QUERY);
    expect(layoutCss).toContain(BAR_QUERY);
  });

  it('stacks the row inside that query so the bar docks under the content', () => {
    const query = layoutCss.slice(layoutCss.indexOf(BAR_QUERY));
    expect(query).toMatch(/\.body\s*\{[^}]*flex-direction:\s*column-reverse/);
  });

  it('has no width-only mobile block, which would miss landscape phones', () => {
    expect(layoutCss).not.toMatch(/@media\s*\(max-width:\s*\d+px\)\s*\{/);
  });
});

describe('in-flow per-source pages share SourceNavLayout', () => {
  // Each `*SubToolbar` is a bottom-bar SourceNav that sits in normal flow, so
  // whatever renders it must put it in the shared row. (Meshtastic's Sidebar
  // is `position: fixed` and is handled by the app shell instead.)
  const toolbars = tsxFiles('src/components')
    .filter((f) => /SubToolbar\.tsx$/.test(f))
    .filter((f) => /mobileVariant="bottom-bar"/.test(read(f)))
    .map((f) => f.split(/[\\/]/).pop()!.replace(/\.tsx$/, ''));

  it('finds the MeshCore and Reticulum toolbars', () => {
    expect(toolbars).toEqual(expect.arrayContaining(['MeshCoreSubToolbar', 'ReticulumSubToolbar']));
  });

  it.each(toolbars)('%s is only rendered inside a SourceNavLayout', (toolbar) => {
    const users = [...tsxFiles('src/components'), ...tsxFiles('src/pages')].filter((f) =>
      new RegExp(`<${toolbar}\\b`).test(read(f)),
    );
    expect(users.length).toBeGreaterThan(0);
    for (const file of users) {
      const src = read(file);
      const open = src.indexOf('<SourceNavLayout');
      const close = src.indexOf('</SourceNavLayout>');
      const at = src.search(new RegExp(`<${toolbar}\\b`));
      expect(open, `${file} must render <SourceNavLayout>`).toBeGreaterThan(-1);
      expect(at > open && at < close, `${file}: <${toolbar}> must sit inside <SourceNavLayout>`).toBe(true);
    }
  });

  it.each([
    'src/components/Reticulum/ReticulumPage.module.css',
    'src/components/MeshCore/MeshCorePage.css',
  ])('%s keeps no private body row', (file) => {
    const css = stripComments(read(file));
    expect(css).not.toMatch(/\.(pageBody|meshcore-page-body)\b/);
  });
});
