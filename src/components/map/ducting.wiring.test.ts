/**
 * #5734 wiring guard: the ducting overlay control must sit in EVERY Map
 * Features panel (NodesTab, DashboardMap and, since #5972, MeshCoreMap), and
 * every map must mount the shared layer only while the toggle is on. The control itself renders
 * nothing while the admin switch is off (DuctingControl.test.tsx), so wiring
 * it into a panel is what makes that panel hide the toggle.
 *
 * Same source-level approach as crossSourceLinks.wiring.test.ts: a previous
 * map toggle (#5177) shipped to one panel with a green suite.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Maps with a 3D view: the toggle must disable there. */
const MAPS_3D = ['src/components/NodesTab.tsx', 'src/components/Dashboard/DashboardMap.tsx'];
/** #5972: the MeshCore map (2D only) forecasts its own source's area. */
const MESHCORE_MAP = 'src/components/MeshCore/MeshCoreMap.tsx';
const MESHCORE_CONTROLS = 'src/components/MeshCore/MeshCoreMapControls.tsx';
const MAPS = [...MAPS_3D, MESHCORE_MAP];
const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
/** The file holding a map's Map Features panel (MeshCore's sidebar body moved out, #6260). */
const panelSrc = (rel: string) => read(rel === MESHCORE_MAP ? MESHCORE_CONTROLS : rel);

describe('ducting overlay wiring (#5734)', () => {
  it.each(MAPS)('%s reads the toggle and the step from MapContext', (rel) => {
    const src = read(rel);
    for (const name of ['showDucting', 'setShowDucting', 'ductingHoursAhead', 'setDuctingHoursAhead']) {
      expect(src).toContain(name);
    }
  });

  it.each(MAPS)('%s renders the shared control in its Map Features panel', (rel) => {
    const src = panelSrc(rel);
    expect(src).toMatch(/<DuctingControl\s[^>]*onCheckedChange=\{(p\.)?setShowDucting\}/);
    expect(src).toMatch(/<DuctingControl\s[^>]*onHoursAheadChange=\{(p\.)?setDuctingHoursAhead\}/);
  });

  it.each(MAPS_3D)('%s disables the control in 3D', (rel) => {
    expect(read(rel)).toMatch(/<DuctingControl\s[^>]*disabledTitle=\{unavailableIn3DTitle\}/);
  });

  it('MeshCoreMap scopes the control and the layer to its own source (#5972)', () => {
    expect(read(MESHCORE_CONTROLS)).toMatch(/<DuctingControl\s[^>]*sourceId=\{p\.sourceId\}/);
    const src = read(MESHCORE_MAP);
    expect(src).toMatch(/<DuctingLayer hoursAhead=\{ductingHoursAhead\} sourceId=\{sourceId\}/);
  });

  it.each(MAPS)('%s mounts the shared layer only while the toggle is on', (rel) => {
    expect(read(rel)).toMatch(/\{showDucting( === true)?( && sourceId)? && \(\s*<DuctingLayer hoursAhead=\{ductingHoursAhead/);
  });

  it('the locale file has the toggle label and the attribution', () => {
    const en = JSON.parse(read('public/locales/en.json'));
    expect(en['map.ducting.toggle']).toBe('Ducting');
    expect(en['map.ducting.attribution']).toBe('Data: NOAA GFS');
  });
});
