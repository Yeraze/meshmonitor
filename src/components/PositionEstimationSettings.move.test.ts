/**
 * Guards the relocation of Position Estimation from the per-source Automation
 * tab to the global Settings UI.
 *
 * Position estimation is a single global, cross-source batch job (issue #3271)
 * whose backend endpoints are gated by `settings:read`/`settings:write` — not
 * the per-source `automation` resource. It used to render in the Automation
 * tab, which (a) implied per-source config, (b) mismatched the backend
 * permission, and (c) was hidden for mqtt_bridge sources. It now lives in the
 * global Settings tab.
 *
 * SettingsTab.tsx and App.tsx are far too large to render in jsdom, so this is
 * a static-source invariant test asserting the move stuck in both directions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settingsTabSrc = readFileSync(resolve('src/components/SettingsTab.tsx'), 'utf8');
const appSrc = readFileSync(resolve('src/App.tsx'), 'utf8');

/** Return the contents of a `const NAME = new Set([ ... ])` literal. */
function setLiteral(src: string, name: string): string {
  const start = src.indexOf(`${name} = new Set([`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('])', start);
  return src.slice(start, end);
}

describe('Position Estimation lives in global Settings (issue #3271)', () => {
  it('is a GLOBAL settings section, not a per-source one', () => {
    expect(setLiteral(settingsTabSrc, 'GLOBAL_SECTIONS')).toContain("'settings-position-estimation'");
    expect(setLiteral(settingsTabSrc, 'SOURCE_SECTIONS')).not.toContain("'settings-position-estimation'");
  });

  it('renders the section and a nav link inside SettingsTab', () => {
    expect(settingsTabSrc).toContain("import PositionEstimationSection from './PositionEstimationSection'");
    // SectionNav quick-link entry.
    expect(settingsTabSrc).toContain("id: 'settings-position-estimation'");
    // Rendered section anchor + the component itself.
    expect(settingsTabSrc).toContain('id="settings-position-estimation"');
    expect(settingsTabSrc).toContain('<PositionEstimationSection baseUrl={baseUrl} />');
  });

  it('gates the section on settings:write (not the automation resource)', () => {
    expect(settingsTabSrc).toContain("hasPermission('settings', 'write')");
    // The render block is gated by the computed permission flag.
    expect(settingsTabSrc).toContain("show('settings-position-estimation') && canWriteSettings");
  });

  it('is no longer rendered in the per-source Automation tab', () => {
    expect(appSrc).not.toContain('PositionEstimationSection');
    // The old automation-tab anchor id must be gone.
    expect(appSrc).not.toContain('id="position-estimation"');
  });
});
