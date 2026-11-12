/**
 * Standalone `/automations` page theme (#4173 review M15).
 *
 * The user's theme is applied to <html data-theme> by SettingsProvider. The
 * Analysis and Reports pages mount one; the Automation Engine route did not,
 * so it always rendered in the dark default regardless of the saved theme.
 * main.tsx renders at module scope and its route table is not exported, so
 * this pins the wiring at the source level.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('/automations route applies the user theme', () => {
  it('wraps AutomationsPage in SettingsProvider', () => {
    const src = readFileSync(resolve('src/main.tsx'), 'utf-8');
    const start = src.indexOf('path="automations"');
    expect(start).toBeGreaterThan(-1);
    // The route's own element, up to the next <Route.
    const next = src.indexOf('<Route', start);
    const route = src.slice(start, next === -1 ? undefined : next);
    expect(route).toMatch(/<SettingsProvider>\s*<AutomationsPage\s*\/>\s*<\/SettingsProvider>/);
  });
});
