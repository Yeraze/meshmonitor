/**
 * Pins the en.json wording for the node-age controls (#5344). Component tests
 * run against a key-echo i18n mock, so the user-facing text is asserted here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const en = JSON.parse(readFileSync(`${process.cwd()}/public/locales/en.json`, 'utf-8'));

describe('node-age control wording (en)', () => {
  it('labels the sidebar activity stat as a fixed 2h, non-filter stat', () => {
    expect(en['source.node_activity_count']).toBe('{{active}}/{{total}}');
    expect(en['source.node_activity_window']).toBe('active · 2h');
    expect(en['source.node_activity_recent_title']).toMatch(/last 2 hours/);
    expect(en['source.node_activity_recent_title']).toMatch(/does not filter/);
  });

  it('labels the Settings value by what it governs', () => {
    expect(en['settings.node_window_label']).toBe('Node list & map window (hours)');
    expect(en['settings.node_window_description']).toMatch(/0 shows all nodes/);
    expect(en['settings.node_window_description']).toMatch(/never widen/);
    expect(en['meshcore.settings.node_display.window_description']).toMatch(/never widen/);
  });

  it('frames the map slider as a narrower of the Settings window', () => {
    expect(en.map.ageFilter).toBe('Map age filter');
    expect(en.map.ageShowing).toBe('Showing: {{value}}');
    expect(en.map.ageAllFromSettings).toBe('All ({{window}} from Settings)');
    expect(en.map.ageAllUnlimited).toBe('All (no limit in Settings)');
  });
});
