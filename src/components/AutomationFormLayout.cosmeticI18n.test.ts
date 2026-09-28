/**
 * Follow-ups to #5465 on the Meshtastic Automation page.
 *
 *   - German Auto Responder add row at 1280px: "Hinzufügen" (122px vs 63px for
 *     "Add") pushed "Leeren" to a line of its own.
 *   - The script select's "Select a script..." was clipped at the 181px
 *     Response width.
 *   - Auto Responder labels ("Channels:", "Enable Multiline ...", the trigger
 *     edit form, the test panel) were hardcoded English.
 *   - Geofence Interval / Cooldown inputs started at different x at 390px.
 *
 *   - Pattern Examples & Templates card was entirely hardcoded English.
 *
 * jsdom has no layout engine, so stylesheets and markup are asserted directly,
 * as AutomationFormLayout.placeholderHint.test.ts does. PatternExamples is
 * also rendered with the real react-i18next (the global setup mocks it) to
 * prove the <Trans> tips put the literal examples back in.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import PatternExamples from './auto-responder/PatternExamples';

vi.unmock('react-i18next');

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');
const layoutCss = read('AutomationFormLayout.module.css').replace(/\/\*[\s\S]*?\*\//g, '');
const en = JSON.parse(read('../../public/locales/en.json')) as Record<string, string>;
const REM = 16;

function rule(selector: string): string {
  const m = layoutCss.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
  expect(m, `.${selector} rule`).not.toBeNull();
  return m![1];
}

function flexOf(selector: string): [number, number, number] {
  const m = rule(selector).match(/flex:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)rem/);
  expect(m, `.${selector} needs a three-value flex with a rem basis`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3]) * REM];
}

describe('auto responder add row keeps Add and Clear on one line', () => {
  const tsx = read('AutoResponderSection.tsx');

  it('Add and Clear sit in one nowrap group', () => {
    expect(rule('buttonGroup')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('buttonGroup')).toMatch(/flex:\s*0\s+0\s+auto/);
    const group = tsx.indexOf('<div className={layout.buttonGroup}>');
    expect(group).toBeGreaterThan(0);
    const add = tsx.indexOf("{t('common.add')}", group);
    const clear = tsx.indexOf("{t('common.clear')}", group);
    expect(add).toBeGreaterThan(group);
    expect(clear).toBeGreaterThan(add);
    // Both buttons close before the group does.
    const between = tsx.slice(group, clear);
    expect(between.match(/<button/g)?.length).toBe(2);
  });

  it('the Cooldown group gives up width before the buttons move', () => {
    const [grow, shrink, basis] = flexOf('cooldownGroup');
    expect(grow).toBeGreaterThan(0);
    expect(shrink).toBeGreaterThan(0);
    expect(rule('cooldownGroup')).toMatch(/min-width:\s*0/);
    expect(rule('cooldownGroup')).toMatch(/flex-wrap:\s*wrap/);
    // 1280px row is 599px. German buttons: 122 (Hinzufügen) + ~80 (Leeren) + gap.
    const row = 599;
    const germanButtons = 122 + 80 + 8;
    expect(basis + 8 + germanButtons).toBeLessThanOrEqual(row);
    expect(tsx).toContain('<div className={layout.cooldownGroup}');
  });

  it('keeps the #5465 pattern / response layout', () => {
    expect(layoutCss).toMatch(/\.patternField\s*\{[^}]*flex:\s*1 1 17rem/);
    expect(layoutCss).toMatch(/\.responseField\s*\{[^}]*flex:\s*2 1 10rem/);
    expect(en['auto_responder.trigger_placeholder']).toBe('e.g. weather {location}');
  });

  it('wraps by row width, not viewport', () => {
    expect(layoutCss).not.toMatch(/@media/);
  });
});

describe('script select placeholder fits the Response field', () => {
  it('is short enough for 181px and still translatable', () => {
    const text = en['auto_responder.select_script'];
    // Monospace at 14px is ~8.4px a character; ~40px goes to padding and arrow.
    expect(text.length * 8.4 + 40).toBeLessThanOrEqual(181);
    expect(read('AutoResponderSection.tsx')).toContain("t('auto_responder.select_script')");
    expect(read('auto-responder/TriggerItem.tsx')).toContain("t('auto_responder.select_script')");
  });

  it('the full description stays in the tooltip', () => {
    expect(read('AutoResponderSection.tsx')).toContain("title={t('auto_responder.script_select_title')}");
    expect(en['auto_responder.script_select_title']).toMatch(/data\/scripts/);
  });
});

describe('auto responder strings are translatable', () => {
  const files = {
    section: read('AutoResponderSection.tsx'),
    item: read('auto-responder/TriggerItem.tsx'),
    scripts: read('auto-responder/ScriptManagement.tsx'),
    examples: read('auto-responder/PatternExamples.tsx'),
  };

  it('every t() key the components use exists in en.json', () => {
    const has = (k: string) => k in en || `${k}_one` in en || `${k}_other` in en;
    for (const [name, src] of Object.entries(files)) {
      const keys = [
        ...src.matchAll(/\bt\('([a-z_]+\.[A-Za-z0-9_]+)'/g),
        ...src.matchAll(/i18nKey="([a-z_]+\.[A-Za-z0-9_]+)"/g),
      ].map((m) => m[1]);
      expect(keys.length, name).toBeGreaterThan(0);
      expect(keys.filter((k) => !has(k)), `${name}: keys missing from en.json`).toEqual([]);
    }
  });

  it.each([
    ['Cooldown:', 'auto_responder.cooldown_label'],
    ['seconds per node (0 = disabled)', 'auto_responder.cooldown_help'],
    ['Channels:', 'auto_responder.channels_label'],
    ['Enable Multiline (split long responses into multiple messages)', 'auto_responder.multiline_label'],
    ['Verify Response (enable 3-retry delivery confirmation)', 'auto_responder.verify_response_label'],
    ['Response Preview:', 'auto_responder.response_preview'],
    ['Configured Triggers', 'auto_responder.configured_triggers_heading'],
    ['No matching trigger', 'auto_responder.no_matching_trigger'],
    ['Remove Trigger', 'auto_responder.remove_trigger_title'],
    ['Script Management', 'auto_responder.script_management'],
  ])('"%s" comes from %s', (text, key) => {
    expect(en[key]).toBe(text);
    const all = Object.values(files).join('\n');
    expect(all).toContain(`t('${key}'`);
    // No literal copy left in JSX text, attributes or t() fallbacks.
    for (const src of Object.values(files)) {
      expect(src).not.toMatch(new RegExp(`>\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`));
      expect(src).not.toContain(`'${text}'`);
      expect(src).not.toContain(`"${text}"`);
    }
  });

  it('the trigger edit form has no hardcoded labels or buttons', () => {
    for (const text of ['Trigger:', 'Type:', 'Response:', 'Text Response', 'HTTP Request', 'Script Execution', 'Direct Messages', 'MULTILINE', 'VERIFY']) {
      expect(files.item).not.toMatch(new RegExp(`>\\s*${text}\\s*<`));
    }
    for (const word of ['Save', 'Cancel', 'Edit', 'Remove', 'Clear']) {
      expect(files.item).not.toMatch(new RegExp(`\\n\\s+${word}\\n`));
    }
  });

  it('adds keys to en.json only', () => {
    const de = JSON.parse(read('../../public/locales/de.json')) as Record<string, string>;
    expect(de).not.toHaveProperty(['auto_responder.channels_label']);
    expect(de).not.toHaveProperty(['auto_responder.multiline_label']);
  });
});

describe('pattern examples are translatable', () => {
  // Comments name the sections in English, so strip them first.
  const src = read('auto-responder/PatternExamples.tsx').replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
  const exampleKeys = Object.keys(en).filter((k) => k.startsWith('auto_responder.examples_'));

  it('every examples_* key the component names exists in en.json', () => {
    // Descriptions and group titles are looked up by key suffix, so collect
    // the suffixes as string literals rather than t('...') calls.
    const named = [...new Set([...src.matchAll(/['.](examples_[a-z_]+)['"]/g)].map((m) => `auto_responder.${m[1]}`))];
    expect(named.length).toBeGreaterThan(30);
    expect(named.filter((k) => !(k in en))).toEqual([]);
    // And nothing in en.json is orphaned.
    expect(exampleKeys.filter((k) => !named.includes(k))).toEqual([]);
  });

  it('keeps pattern, regex and config literals out of the translated text', () => {
    for (const key of exampleKeys) {
      const value = en[key].replace(/\{\{\w+\}\}/g, '').replace(/<\/?\w+\/?>/g, '');
      expect(value, key).not.toMatch(/[{}\\[\]]/);
      expect(value, key).not.toMatch(/TZ=|docker-compose|!a1b2/);
    }
  });

  it('has no hardcoded English prose left in the markup', () => {
    for (const text of ['Pattern Examples & Templates', 'Common Meshtastic Commands', 'Click to use', 'Quick Tips:', 'Node & Network Patterns', 'Multi-pattern weather command', 'Battery level (0-100)']) {
      expect(src).not.toContain(text);
    }
    expect(src).not.toMatch(/title="[A-Z]/);
    expect(src).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</);
  });

  it('renders the tips with their literal examples through <Trans>', async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
    const onSelect = vi.fn();
    const { container, getByText } = render(
      createElement(I18nextProvider, { i18n }, createElement(PatternExamples, { onSelectPattern: onSelect })),
    );
    fireEvent.click(getByText('Pattern Examples & Templates'));
    const text = container.textContent ?? '';
    expect(text).toContain('Use {param} for default matching (single word, no spaces)');
    expect(text).toContain('Default pattern [^\\s]+ matches any single word');
    expect(text).toContain('Use [\\w\\s]+ for multiple words with spaces');
    expect(text).toContain('configure via TZ=America/New_York in docker-compose.yaml');
    expect(text).toContain('Meshtastic node ID (e.g., !a1b2c3d4)');
    expect(text).not.toMatch(/auto_responder\./);

    // The clickable examples still insert the exact pattern.
    fireEvent.click(getByText('grid {square:[A-R]{2}\\d{2}[a-x]{2}}'));
    expect(onSelect).toHaveBeenLastCalledWith('grid {square:[A-R]{2}\\d{2}[a-x]{2}}');
    fireEvent.click(getByText('weather, weather {location}, w {location}'));
    expect(onSelect).toHaveBeenLastCalledWith('weather, weather {location}, w {location}');
  });
});

describe('pattern count badge does not cover the pattern', () => {
  const tsx = read('AutoResponderSection.tsx');

  it('the input reserves room for the badge while it shows', () => {
    const m = tsx.match(/const PATTERN_BADGE_RESERVE = '([\d.]+)rem';/);
    expect(m).not.toBeNull();
    const reserve = Number(m![1]) * REM;
    // Badge inset (0.5rem) + "12 patterns" at 0.7rem (~74px measured in Chrome).
    expect(reserve).toBeGreaterThanOrEqual(8 + 74);
    // Tied to the same condition that renders the badge, so an empty field
    // keeps its full width for the placeholder (#5465).
    expect(tsx).toContain('paddingRight: newTrigger.trim() ? PATTERN_BADGE_RESERVE : undefined');
    expect(tsx).toMatch(/\{newTrigger\.trim\(\) && \(\s*<div style=\{\{\s*position: 'absolute'/);
  });

  it('the badge stays on one line', () => {
    const at = tsx.indexOf("t('auto_responder.pattern_count', { count: splitTriggerPatterns(newTrigger).length })");
    const style = tsx.slice(tsx.lastIndexOf('<div style={{', at), at);
    expect(style).toContain("whiteSpace: 'nowrap'");
  });
});

describe('examples do nothing while the trigger field is disabled', () => {
  it('the section passes the field state', () => {
    expect(read('AutoResponderSection.tsx')).toContain('<PatternExamples onSelectPattern={setNewTrigger} disabled={!localEnabled} />');
    expect(en['auto_responder.examples_disabled_title']).toBeTruthy();
  });

  async function renderExamples(disabled: boolean) {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
    const onSelect = vi.fn();
    const view = render(
      createElement(I18nextProvider, { i18n }, createElement(PatternExamples, { onSelectPattern: onSelect, disabled })),
    );
    fireEvent.click(view.getByText('Pattern Examples & Templates'));
    return { ...view, onSelect };
  }

  it('disabled: card buttons are disabled, patterns are no-ops, tooltips explain', async () => {
    const { getByText, onSelect, unmount } = await renderExamples(true);
    const card = getByText('ping').closest('button')!;
    expect(card.disabled).toBe(true);
    expect(card.title).toBe(en['auto_responder.examples_disabled_title']);
    fireEvent.click(card);
    const code = getByText('zip {code:\\d{5}}');
    expect(code.getAttribute('aria-disabled')).toBe('true');
    expect(code.title).toBe(en['auto_responder.examples_disabled_title']);
    fireEvent.click(code);
    expect(onSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('enabled: both kinds still insert', async () => {
    const { getByText, onSelect, unmount } = await renderExamples(false);
    fireEvent.click(getByText('ping').closest('button')!);
    fireEvent.click(getByText('zip {code:\\d{5}}'));
    expect(onSelect.mock.calls).toEqual([['ping'], ['zip {code:\\d{5}}']]);
    unmount();
  });
});

describe('click targets clear the sticky tab strip', () => {
  it('scroll-margin-top covers the header and the SectionNav', () => {
    const r = rule('scrollTarget');
    expect(r).toMatch(/scroll-margin-top:\s*calc\(/);
    expect(r).toContain('var(--app-header-height');
    expect(r).toContain('var(--section-nav-height');
  });

  it('the examples and the trigger input carry the class', () => {
    const examples = read('auto-responder/PatternExamples.tsx');
    expect(examples.match(/className=\{layout\.scrollTarget\}/g)?.length).toBe(2);
    expect(read('AutoResponderSection.tsx')).toContain('className={`setting-input ${layout.scrollTarget}`}');
  });
});

describe('geofence number inputs line up', () => {
  const tsx = read('GeofenceTriggersSection.tsx');

  it('Interval and Cooldown labels share one-line widths on phone and desktop', () => {
    const m = rule('numberLabel').match(/flex:\s*0\s+0\s+min\(\s*([\d.]+)rem\s*,\s*([\d.]+)%\s*\)/);
    expect(m, '.numberLabel needs flex: 0 0 min(<rem>, <pct>%)').not.toBeNull();
    const cap = Number(m![1]) * REM;
    const pct = Number(m![2]) / 100;
    const basisAt = (row: number) => Math.min(cap, row * pct);
    const gap = 8;
    const input = 100;

    // Label widths measured in headless Chrome at 0.9rem (German falls back
    // to English: both keys are empty in de.json).
    const intervalLabel = 116;
    const cooldownLabel = 133;
    const oldDesktopLabel = 120; // the pre-#5466 min-width
    // If German gains its own text, re-measure: it may be longer.
    const de = JSON.parse(read('../../public/locales/de.json')) as Record<string, string>;
    expect(de['automation.geofence_triggers.cooldown'] ?? '').toBe('');
    expect(de['automation.geofence_triggers.while_inside_interval'] ?? '').toBe('');

    // 390px viewport: the measured row is ~276px. 11rem (176px) needed 284px,
    // so each input dropped under its label. Label + gap + input share the line.
    const phone = basisAt(276);
    expect(phone + gap + input).toBeLessThanOrEqual(276);
    // Both labels fit on one line, so the two rows are the same height.
    expect(phone).toBeGreaterThanOrEqual(cooldownLabel);
    expect(phone).toBeGreaterThanOrEqual(intervalLabel);

    // 1280px: the label takes the full cap. It fits the longer label on one
    // line and stays within ~20px of the old 120px, where 11rem moved the
    // inputs ~52px right.
    const desktop = basisAt(900);
    expect(desktop).toBe(cap);
    expect(desktop).toBeGreaterThanOrEqual(cooldownLabel);
    expect(desktop - oldDesktopLabel).toBeLessThanOrEqual(20);
  });

  it.each(['while_inside_interval', 'cooldown'])('%s label uses the class', (key) => {
    const at = tsx.indexOf(`{t('automation.geofence_triggers.${key}',`);
    expect(at).toBeGreaterThan(0);
    const before = tsx.slice(0, at);
    const label = before.slice(before.lastIndexOf('<label '));
    expect(label).toMatch(/^<label className=\{layout\.numberLabel\}/);
    expect(label).not.toContain('minWidth');
  });

  it('keeps the #5465 hint wrap', () => {
    expect(layoutCss).toMatch(/\.inlineHint\s*\{[^}]*flex:\s*1 1 14rem/);
  });
});
