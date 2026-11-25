/**
 * #5891 wiring guard, modeled on `mapAircraftMode.wiring.test.ts`.
 *
 * Every Map Features panel must render the shared toggle, and every map that
 * filters nodes must use the shared predicate. NodesTab has no DOM harness, so
 * a source scan is the only guard against shipping the chip to one panel only
 * (#5177).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PANELS = [
  'src/components/NodesTab.tsx',
  'src/components/Dashboard/DashboardMap.tsx',
  'src/components/MeshCore/MeshCoreMapControls.tsx',
];
const FILTERING_MAPS = [
  'src/components/NodesTab.tsx',
  'src/components/Dashboard/DashboardMap.tsx',
  'src/components/MeshCore/MeshCoreMap.tsx',
];

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('mapRepeatersOnly wiring (#5891)', () => {
  it.each(PANELS)('%s renders the shared MapRepeatersOnlyToggle', (rel) => {
    expect(read(rel)).toContain('<MapRepeatersOnlyToggle');
  });

  it.each(FILTERING_MAPS)('%s filters with isRepeaterClassNode', (rel) => {
    expect(read(rel)).toContain('isRepeaterClassNode');
  });

  it.each(FILTERING_MAPS)('%s reads showRepeatersOnly', (rel) => {
    expect(read(rel)).toContain('showRepeatersOnly');
  });
});
