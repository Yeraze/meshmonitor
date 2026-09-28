/**
 * The global /settings page on a phone.
 *
 * At a 390px viewport /settings measured a 538px document scrollWidth. Two
 * sources ran past the screen:
 *   - Channel Database cards: an implicit `auto` grid column sized to each
 *     card's ~462px min-content (a one-line flex row of handle, info and four
 *     buttons) inside a 292px section.
 *   - Map overlay layer rows: a one-line flex row whose name input (~214px
 *     intrinsic width) pushed the Delete button to 538px.
 *
 * jsdom has no layout engine, so a render test cannot see an overflow. The
 * stylesheets and markup are asserted directly, as
 * AutomationFormLayout.mobileOverflow does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');
// Comments quote the declarations being asserted, so strip them first.
const readCss = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '');

describe('Channel Database cards fit a phone', () => {
  const css = readCss('configuration/ChannelDatabaseSection.module.css');
  const tsx = read('configuration/ChannelDatabaseSection.tsx');

  it('the card grid track can shrink below its content', () => {
    expect(css).toMatch(/\.cardList\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(tsx).toContain('className={styles.cardList}');
    expect(tsx).not.toContain("style={{ display: 'grid', gap: '1rem' }}");
  });

  it('the card row wraps and the info column may shrink', () => {
    expect(css).toMatch(/\.cardRow\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.cardInfo\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.cardActions\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(tsx).toContain('className={styles.cardRow}');
    expect(tsx).toContain('className={styles.cardInfo}');
    expect(tsx).toContain('className={styles.cardActions}');
  });

  it('uses no viewport media query', () => {
    // A max-width-only query would miss phones in landscape (#5051-#5054).
    expect(css).not.toMatch(/@media/);
  });
});

describe('Map overlay layer rows fit a phone', () => {
  const css = readCss('GeoJsonLayerManager.module.css');
  const tsx = read('GeoJsonLayerManager.tsx');

  it('both rows wrap', () => {
    expect(css).toMatch(/\.controlRow\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.styleRow\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(tsx).toContain('className={styles.controlRow}');
    expect(tsx).toContain('className={styles.styleRow}');
  });

  it('the name input has a floor that never exceeds the row', () => {
    expect(css).toMatch(/\.nameInput\s*\{[^}]*min-width:\s*min\(100%,/);
    expect(tsx).toContain('className={styles.nameInput}');
    // An inline `flex: 1` would override the module's flex-basis.
    expect(tsx).not.toMatch(/style=\{\{ flex: 1, padding: '2px 6px'/);
  });

  it('the name floor keeps the whole row on one line in a 497px desktop section', () => {
    // Measured at a 1280px window: the settings section is 497px wide and the
    // row's other controls (Visible, Public, Disable click popup, Color,
    // Delete) plus their 12px gaps take 354.4px. A 9rem (144px) floor needed
    // 498.4px and wrapped Delete to a second line.
    const SECTION_PX = 497;
    const OTHER_CONTROLS_PX = 354.4;
    const REM_PX = 16;
    const rule = css.match(/\.nameInput\s*\{([^}]*)\}/)?.[1] ?? '';
    const floorRem = Number(rule.match(/min-width:\s*min\(100%,\s*([\d.]+)rem\)/)?.[1]);
    const basisRem = Number(rule.match(/flex:\s*1 1 ([\d.]+)rem/)?.[1]);
    expect(floorRem).toBeGreaterThan(0);
    expect(basisRem).toBeGreaterThan(0);
    expect(OTHER_CONTROLS_PX + floorRem * REM_PX).toBeLessThanOrEqual(SECTION_PX);
    expect(OTHER_CONTROLS_PX + basisRem * REM_PX).toBeLessThanOrEqual(SECTION_PX);
  });

  it('uses no viewport media query', () => {
    expect(css).not.toMatch(/@media/);
  });
});
