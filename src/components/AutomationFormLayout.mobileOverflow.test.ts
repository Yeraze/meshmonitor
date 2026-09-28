/**
 * Automation + Configuration pages on a phone.
 *
 * At a 390px viewport the Meshtastic Automation page measured a 618px document
 * scrollWidth and the Configuration page 441px. The culprits were single-line
 * flex rows and a fixed 3-column grid whose children could not shrink:
 *   - Auto Responder "add trigger" row (577px of content in a 308px box)
 *   - Timer / Geofence "Channel:" rows (120px label + 200px select + help text)
 *   - Geofence circle Lat/Lng/Radius grid (`1fr 1fr 1fr`, 469px in 276px)
 *   - Network NTP / Rsyslog inputs (fixed `width: 400px`)
 *   - Configuration warning-box buttons and the private-key row
 *
 * jsdom has no layout engine, so a render test cannot see an overflow. The
 * stylesheets and markup are asserted directly, as SecurityTab.mobileTables
 * does for #5194.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');
// Comments quote the declarations being asserted, so strip them first.
const readCss = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '');

describe('automation forms wrap instead of overflowing on a phone', () => {
  const layoutCss = readCss('AutomationFormLayout.module.css');

  it('the shared row class wraps, with no viewport media query', () => {
    expect(layoutCss).toMatch(/\.wrapRow\s*\{[^}]*flex-wrap:\s*wrap/);
    // A max-width-only query would miss phones in landscape (#5051-#5054).
    expect(layoutCss).not.toMatch(/@media/);
  });

  it('grow fields have a floor that never exceeds the row', () => {
    expect(layoutCss).toMatch(/\.growField\s*\{[^}]*min-width:\s*min\(100%,/);
  });

  it('Auto Responder add row and its text fields use the classes', () => {
    const tsx = read('AutoResponderSection.tsx');
    expect(tsx).toContain("import layout from './AutomationFormLayout.module.css'");
    expect(tsx).toMatch(/className=\{`\$\{layout\.wrapRow\} \$\{layout\.patternRow\}`\}[^\n]*alignItems: 'flex-start'/);
    expect(tsx.match(/className=\{`?\$?\{?layout\.growField\}/g)?.length).toBe(2);
  });

  it.each(['TimerTriggersSection.tsx', 'GeofenceTriggersSection.tsx'])(
    '%s channel row wraps',
    (file) => {
      const tsx = read(file);
      // The Channel: label sits directly inside the wrapping row.
      expect(tsx).toMatch(
        /className=\{layout\.wrapRow\}[^\n]*\n\s*<label[^\n]*\n\s*\{t\('automation\.(timer|geofence)_triggers\.channel',/,
      );
    },
  );

  it('geofence circle fields use a responsive grid, not a fixed 3 columns', () => {
    const css = readCss('GeofenceMapEditor.module.css');
    expect(css).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/);
    expect(css).toMatch(/\.circleFields input\s*\{[^}]*min-width:\s*0/);
    const tsx = read('GeofenceMapEditor.tsx');
    expect(tsx).toContain('className={styles.circleFields}');
    expect(tsx).not.toContain("gridTemplateColumns: '1fr 1fr 1fr'");
  });
});

describe('configuration page fits a phone', () => {
  it('fixed 400px inputs are capped at their container', () => {
    for (const file of ['configuration/NetworkConfigSection.tsx', 'AdminCommandsTab.tsx']) {
      const tsx = read(file);
      expect(tsx).not.toMatch(/style=\{\{ width: '400px' \}\}/);
    }
  });

  it('warning-box buttons wrap', () => {
    expect(readCss('ConfigurationTab.module.css')).toMatch(/\.dangerActions\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(read('ConfigurationTab.tsx')).toContain('className={styles.dangerActions}');
  });

  it('private key row wraps', () => {
    expect(read('configuration/SecurityConfigSection.tsx')).toMatch(
      /flexWrap: 'wrap'[^\n]*\n\s*<input\n\s*id="privateKey"/,
    );
  });
});
