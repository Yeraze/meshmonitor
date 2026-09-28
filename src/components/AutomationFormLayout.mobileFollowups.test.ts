/**
 * Follow-ups to the phone overflow fixes (#5462, #5457), from a 390x844 review.
 *
 *   - Timer Triggers: Name input and Script select ended at x=385, past the
 *     card edge at 349. `.setting-input` is `width: 200px`, so a `flex: 1`
 *     field could not shrink below 200px beside its 120px label.
 *   - Geofence Triggers: the same, for Name (385), Message (380) and Event
 *     (339) against a card edge of 333.
 *   - Auto Responder: the pattern placeholder was cut to "Try: weather, w".
 *   - Configuration: 49px below the last section instead of 33px, from an
 *     inline `marginBottom: '1rem'` escaping the Device Backup section.
 *
 * jsdom has no layout engine, so the stylesheets and markup are asserted
 * directly, as AutomationFormLayout.mobileOverflow.test.ts does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');
// Comments quote the declarations being asserted, so strip them first.
const readCss = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '');

const layoutCss = readCss('AutomationFormLayout.module.css');

describe('trigger form fields stay inside their card', () => {
  it('labeled fields replace the 200px automatic minimum with a capped floor', () => {
    expect(layoutCss).toMatch(/\.labeledField\s*\{[^}]*min-width:\s*min\(100%,/);
    expect(layoutCss).toMatch(/\.labeledField\s*\{[^}]*max-width:\s*100%/);
    // Wrapping must follow the row width, not the viewport (#5051-#5054).
    expect(layoutCss).not.toMatch(/@media/);
  });

  it.each(['TimerTriggersSection.tsx', 'GeofenceTriggersSection.tsx'])(
    '%s: every flex: 1 field beside a label has the floor, in a wrapping row',
    (file) => {
      const tsx = read(file);
      // No `flex: 1` setting-input is left without the floor.
      expect(tsx).not.toMatch(/className="setting-input"\n\s*style=\{\{ flex: 1 \}\}/);
      // Nor a `flex: 1` wrapper div directly after a fixed-width label.
      expect(tsx).not.toMatch(/<\/label>\n\s*<div style=\{\{ flex: 1/);

      // Every row led by a fixed-width label that holds a floored field wraps.
      const rowStart =
        /<div[^\n]*display: 'flex', alignItems: '(?:center|flex-start)', gap: '0\.5rem' \}\}>\n\s*<label style=\{\{ minWidth: '(?:120|80)px'/g;
      const starts = [...tsx.matchAll(rowStart)].map((m) => m.index ?? 0);
      let checked = 0;
      starts.forEach((start, i) => {
        const row = tsx.slice(start, starts[i + 1] ?? tsx.length);
        const head = row.split('\n').slice(0, 12).join('\n');
        if (head.includes('layout.labeledField')) {
          expect(head.split('\n')[0]).toContain('className={layout.wrapRow}');
          checked++;
        }
      });
      expect(checked).toBeGreaterThanOrEqual(4);
    },
  );

  it.each([
    ['TimerTriggersSection.tsx', 'timer_triggers.name_placeholder'],
    ['GeofenceTriggersSection.tsx', 'geofence_triggers.name_placeholder'],
  ])('%s Name input carries the floor', (file, key) => {
    const tsx = read(file);
    const at = tsx.indexOf(key);
    expect(at).toBeGreaterThan(0);
    expect(tsx.slice(at - 300, at)).toContain('className={`setting-input ${layout.labeledField}`}');
  });
});

describe('auto responder pattern placeholder fits', () => {
  it('the pattern field takes its own line when the row is narrow', () => {
    expect(layoutCss).toMatch(/\.patternRow\s*\{[^}]*container-type:\s*inline-size/);
    expect(layoutCss).toMatch(
      /@container\s*\(max-width:[^)]*\)\s*\{\s*\.patternField\s*\{[^}]*flex-basis:\s*100%/,
    );
    const tsx = read('AutoResponderSection.tsx');
    expect(tsx).toContain('className={`${layout.wrapRow} ${layout.patternRow}`}');
    expect(tsx).toContain('className={`${layout.growField} ${layout.patternField}`}');
    // An inline `flex: '1'` would pin flex-basis to 0 and defeat the query.
    expect(tsx).not.toMatch(/layout\.patternField\}`\} style=\{\{ flex:/);
  });

  it('the English placeholder is short enough for a phone-width input', () => {
    const en = JSON.parse(read('../../public/locales/en.json')) as Record<string, string>;
    // About 28 monospace characters fit in a full-width pattern input at 390px.
    expect(en['auto_responder.trigger_placeholder'].length).toBeLessThanOrEqual(26);
  });
});

describe('configuration page bottom gap', () => {
  it('the last Device Backup block has no bottom margin to escape the list', () => {
    const tsx = read('configuration/BackupManagementSection.tsx');
    expect(tsx).not.toContain("gap: '1rem', marginBottom: '1rem'");
    expect(tsx).toContain("<div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>");
  });

  it('sections are still spaced by the stack', () => {
    expect(readCss('ConfigurationTab.module.css')).toMatch(
      /\.sectionStack > \* \+ \*\s*\{[^}]*margin-top:\s*2rem/,
    );
  });
});
