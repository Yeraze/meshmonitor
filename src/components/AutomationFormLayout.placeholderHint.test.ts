/**
 * Follow-ups to #5463.
 *
 *   - Auto Responder at 1280px: the pattern input was 154px (118px of text), so
 *     the placeholder "e.g. weather {location}" (~222px) showed "e.g. weather".
 *     The pattern and Response fields split the row 1:2 from a zero basis.
 *   - Geofence Cooldown / Interval at 390px: the hint sat in the ~100px left
 *     beside the 120px label and 100px number input, one word per line.
 *   - Non-English locales still held the old long trigger placeholder.
 *
 * jsdom has no layout engine, so the stylesheets and markup are asserted
 * directly, as AutomationFormLayout.mobileFollowups.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');
// Comments quote the declarations being asserted, so strip them first.
const readCss = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '');

const layoutCss = readCss('AutomationFormLayout.module.css');
const REM = 16;

/** The `flex` shorthand of a top-level rule, as [grow, shrink, basis in px]. */
function flexOf(selector: string): [number, number, number] {
  // Drop the container-query blocks so only unconditional rules are read.
  const top = layoutCss.replace(/@container[^{]*\{[\s\S]*?\}\s*\}/g, '');
  const m = top.match(new RegExp(`\\.${selector}\\s*\\{[^}]*flex:\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)rem`));
  expect(m, `.${selector} needs a three-value flex with a rem basis`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3]) * REM];
}

describe('auto responder pattern field on a wide row', () => {
  const [patternGrow, , patternBasis] = flexOf('patternField');
  const [responseGrow, , responseBasis] = flexOf('responseField');

  it('gives the pattern input room for the whole placeholder', () => {
    // ~222px of monospace text plus ~36px of padding and border.
    expect(patternBasis).toBeGreaterThanOrEqual(258);
  });

  it('keeps the row on one line at a 1280px window', () => {
    // Measured row width at 1280px: 154 + 309 + 120 (type select) + 2 gaps.
    const row = 599;
    const typeSelect = 120;
    const gaps = 2 * 8;
    expect(patternBasis + responseBasis + typeSelect + gaps).toBeLessThanOrEqual(row);
    // The Response field still takes the larger share of any spare width.
    expect(responseGrow).toBeGreaterThan(patternGrow);
  });

  it('keeps the narrow-row container query from #5463', () => {
    expect(layoutCss).toMatch(/\.patternRow\s*\{[^}]*container-type:\s*inline-size/);
    expect(layoutCss).toMatch(
      /@container\s*\(max-width:[^)]*\)\s*\{\s*\.patternField\s*\{[^}]*flex-basis:\s*100%/,
    );
  });

  it('the Response field uses the class, not an inline flex', () => {
    const tsx = read('AutoResponderSection.tsx');
    expect(tsx).toContain('className={`${layout.growField} ${layout.responseField}`}>');
    expect(tsx).not.toContain("style={{ flex: '2' }}");
    // The script select must not force the Response field past its share.
    expect(tsx).not.toMatch(/width: '100%', minWidth: '200px'/);
  });
});

describe('geofence number-input hints wrap under the input on a phone', () => {
  it('the hint has a basis wider than the phone gap beside the input', () => {
    const [grow, shrink, basis] = flexOf('inlineHint');
    expect(grow).toBeGreaterThan(0);
    expect(shrink).toBeGreaterThan(0);
    // 390px viewport: ~333px card - 120px label - 100px input - 2 gaps ≈ 97px.
    expect(basis).toBeGreaterThan(333 - 120 - 100 - 16);
    // Wrapping follows the row width, not the viewport (#5051-#5054).
    expect(layoutCss).not.toMatch(/@media/);
  });

  it.each(['while_inside_interval_help', 'cooldown_help'])('%s row wraps', (key) => {
    const tsx = read('GeofenceTriggersSection.tsx');
    const at = tsx.indexOf(`automation.geofence_triggers.${key}`);
    expect(at).toBeGreaterThan(0);
    const before = tsx.slice(0, at);
    const rowStart = before.lastIndexOf("<div ");
    expect(before.slice(rowStart)).toMatch(/^<div className=\{layout\.wrapRow\}/);
    const hint = before.slice(before.lastIndexOf('<span '));
    expect(hint).toMatch(/^<span className=\{layout\.inlineHint\}/);
  });
});

describe('trigger placeholder locales', () => {
  const localeDir = join(here, '../../public/locales');

  it('non-English locales drop the stale long placeholder and fall back to English', () => {
    for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
      const d = JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as Record<string, unknown>;
      expect(d, file).not.toHaveProperty(['auto_responder.trigger_placeholder']);
    }
    const i18n = read('../config/i18n.ts');
    expect(i18n).toMatch(/fallbackLng:\s*'en'/);
  });
});
