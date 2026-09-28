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
 * jsdom has no layout engine, so stylesheets and markup are asserted directly,
 * as AutomationFormLayout.placeholderHint.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('geofence number inputs line up', () => {
  const tsx = read('GeofenceTriggersSection.tsx');

  it('Interval and Cooldown labels share a fixed width', () => {
    const [grow, shrink, basis] = flexOf('numberLabel');
    expect(grow).toBe(0);
    expect(shrink).toBe(0);
    // Wider than "Cooldown (minutes):" (~160px at 0.9rem), so both fit.
    expect(basis).toBeGreaterThanOrEqual(160);
    // 390px viewport: ~333px card. Label + gap + 100px input still share a line.
    expect(basis + 8 + 100).toBeLessThanOrEqual(333);
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
