/**
 * #5364/#5365 Phase 1 WP4 wiring guard, modeled on `mapPinColorMode.wiring.test.ts`
 * (#5018).
 *
 * Every map that draws node pins must pass `isLikelyAircraft` to the icon
 * factory AND include it in `iconSig`, and both Map Features panels must
 * render the shared `MapAircraftDisplayControl`. Each half fails silently and
 * differently:
 *
 *  - A map that never passes `isLikelyAircraft` just never badges an aircraft.
 *    There are three independent node-marker maps, and a previous map toggle
 *    (#5177) shipped to only one of the two Map Features panels with a fully
 *    green suite (memory: "TWO Map Features panels").
 *
 *  - A map that passes it but leaves it out of `iconSig` is worse: Leaflet
 *    reuses the cached icon, so the badge only appears for nodes that happen
 *    to re-render for some other reason — reads as "flaky", not "broken".
 *
 * A source-level check is crude, but it catches the omission at the point it
 * is made.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Every component that builds a node marker icon from a node record. */
const NODE_MARKER_MAPS = [
  'src/components/Dashboard/DashboardMap.tsx',
  'src/components/MapAnalysis/layers/NodeMarkersLayer.tsx',
  'src/components/NodesTab.tsx',
];

/** Both Map Features panels. */
const MAP_FEATURES_PANELS = [
  'src/components/Dashboard/DashboardMap.tsx',
  'src/components/NodesTab.tsx',
];

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('mapAircraftMode wiring (#5364/#5365 Phase 1 WP4)', () => {
  it.each(NODE_MARKER_MAPS)('%s passes isLikelyAircraft to the icon factory', (rel) => {
    expect(read(rel)).toContain('isLikelyAircraft:');
  });

  /**
   * Pull the line that assigns iconSig. Matching on the line rather than a
   * template-literal regex over the whole file — these components contain many
   * backtick strings, and an unanchored match happily grabs the wrong one.
   */
  const iconSigLine = (rel: string): string => {
    const line = read(rel)
      .split('\n')
      .find((l) => /iconSig\s*[:=]/.test(l));
    expect(line, `no iconSig assignment found in ${rel}`).toBeDefined();
    return line as string;
  };

  it.each(NODE_MARKER_MAPS)('%s includes the aircraft flag in the marker cache key', (rel) => {
    // Without this the icon is cached across a mode change, so the badge only
    // appears for nodes re-rendered for some other reason.
    expect(iconSigLine(rel)).toMatch(/markAircraft/);
  });

  it.each(MAP_FEATURES_PANELS)('%s renders the shared MapAircraftDisplayControl', (rel) => {
    expect(read(rel)).toContain('<MapAircraftDisplayControl');
  });

  it.each(MAP_FEATURES_PANELS)('%s reads aircraftDisplayMode from the map context', (rel) => {
    expect(read(rel)).toContain('aircraftDisplayMode');
  });

  // #5364/#5365 Phase 2 "Show aged-out": both panels must pass the checkbox
  // and its count, or the toggle ships to one panel only (#5177 again).
  it.each(MAP_FEATURES_PANELS)('%s wires the Show aged-out checkbox and count', (rel) => {
    const src = read(rel);
    expect(src).toContain('showAgedOutAircraft');
    expect(src).toMatch(/onShowAgedOutChange=\{setShowAgedOutAircraft\}/);
    expect(src).toMatch(/agedOutCount=\{/);
    // The aged-out predicate is shared, never re-implemented inline.
    expect(src).toContain('isAgedOutAircraft(');
  });

  it('App hands NodesTab the aged-out list from useSourceView', () => {
    expect(read('src/App.tsx')).toMatch(/agedOutAircraftNodes=\{agedOutAircraftNodes\}/);
    expect(read('src/hooks/useSourceView.ts')).toContain('agedOutAircraftNodes');
  });

  it('Map Analysis follows Show aged-out too (useAnalysisNodes + NodeMarkersLayer)', () => {
    expect(read('src/components/MapAnalysis/useAnalysisNodes.ts')).toContain('showAgedOutAircraft');
    expect(read('src/components/MapAnalysis/layers/NodeMarkersLayer.tsx')).toContain('isAgedOutAircraft(');
  });

  it('Map Analysis has no Map Features panel of its own but still honours Hide (useAnalysisNodes)', () => {
    const src = read('src/components/MapAnalysis/useAnalysisNodes.ts');
    expect(src).toContain('aircraftDisplayMode');
    expect(src).toMatch(/likelyAircraft === true/);
  });
});
