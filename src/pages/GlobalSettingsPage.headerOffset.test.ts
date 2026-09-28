/**
 * The standalone /settings page has no app header, so its sticky section nav
 * must stick at the top of the viewport, not 60px down it.
 *
 * `.section-nav` is `position: sticky; top: var(--app-header-height)` (App.css).
 * Inside the app shell `useAppHeaderHeightVar` publishes the measured header
 * height, but /settings mounts outside the shell, so the variable fell back to
 * the :root default (the 60px design height) and content scrolled through an
 * empty band above the nav. The page wrapper now zeroes the variable for its
 * own subtree.
 *
 * Asserted against source because jsdom has no layout and does not apply
 * CSS-module stylesheets; the three halves below are the whole contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

/** Body of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[2];
}

describe('/settings sticky nav offset', () => {
  it('the page wrapper sets --app-header-height to 0', () => {
    const body = ruleBody(read('./GlobalSettingsPage.module.css'), '.page');
    expect(body).toMatch(/--app-header-height:\s*0(px)?\s*;/);
  });

  it('GlobalSettingsPage renders its content inside that wrapper', () => {
    const src = read('./GlobalSettingsPage.tsx');
    expect(src).toMatch(/import styles from '\.\/GlobalSettingsPage\.module\.css'/);
    expect(src).toMatch(/className=\{styles\.page\}/);
  });

  it('the section nav still sticks at the published header height', () => {
    // Pages inside the app shell keep their offset: the nav reads the variable
    // rather than a constant, and :root still defaults it to the header height.
    const appCss = read('../App.css');
    expect(ruleBody(appCss, '.section-nav')).toMatch(/top:\s*var\(--app-header-height\)\s*;/);
    expect(appCss).toMatch(/--app-header-height:\s*calc\(var\(--header-height\)/);
  });
});
