/**
 * #5734 wiring guard: the ducting overlay control must sit in BOTH Map
 * Features panels (NodesTab and DashboardMap), and both maps must mount the
 * shared layer only while the toggle is on. The control itself renders
 * nothing while the admin switch is off (DuctingControl.test.tsx), so wiring
 * it into a panel is what makes that panel hide the toggle.
 *
 * Same source-level approach as crossSourceLinks.wiring.test.ts: a previous
 * map toggle (#5177) shipped to one panel with a green suite.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MAPS = ['src/components/NodesTab.tsx', 'src/components/Dashboard/DashboardMap.tsx'];
const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('ducting overlay wiring (#5734)', () => {
  it.each(MAPS)('%s reads the toggle and the step from MapContext', (rel) => {
    const src = read(rel);
    for (const name of ['showDucting', 'setShowDucting', 'ductingHoursAhead', 'setDuctingHoursAhead']) {
      expect(src).toContain(name);
    }
  });

  it.each(MAPS)('%s renders the shared control in its Map Features panel', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/<DuctingControl\s[^>]*onCheckedChange=\{setShowDucting\}/);
    expect(src).toMatch(/<DuctingControl\s[^>]*onHoursAheadChange=\{setDuctingHoursAhead\}/);
    expect(src).toMatch(/<DuctingControl\s[^>]*disabledTitle=\{unavailableIn3DTitle\}/);
  });

  it.each(MAPS)('%s mounts the shared layer only while the toggle is on', (rel) => {
    expect(read(rel)).toMatch(/\{showDucting( === true)? && \(\s*<DuctingLayer hoursAhead=\{ductingHoursAhead/);
  });

  it('the locale file has the toggle label and the attribution', () => {
    const en = JSON.parse(read('public/locales/en.json'));
    expect(en['map.ducting.toggle']).toBe('Ducting');
    expect(en['map.ducting.attribution']).toBe('Data: NOAA GFS');
  });
});
