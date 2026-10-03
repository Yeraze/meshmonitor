/**
 * #5561 wiring guard: the "Show Cross-Source Links" toggle must exist in BOTH
 * Map Features panels (NodesTab and DashboardMap), and both maps must mount
 * the 2D layer and pass the toggle to the 3D view.
 *
 * A previous map toggle (#5177) shipped to one panel with a fully green
 * suite. A source-level check is crude, but it catches the omission where it
 * is made (same approach as mapPinColorMode.wiring.test.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MAPS = ['src/components/NodesTab.tsx', 'src/components/Dashboard/DashboardMap.tsx'];
const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('cross-source links wiring (#5561)', () => {
  it.each(MAPS)('%s reads the toggle from MapContext', (rel) => {
    const src = read(rel);
    expect(src).toContain('showCrossSourceLinks');
    expect(src).toContain('setShowCrossSourceLinks');
  });

  it.each(MAPS)('%s has the Map Features checkbox', (rel) => {
    const src = read(rel);
    expect(src).toContain("t('map.cross_source.toggle'");
    expect(src).toMatch(/onChange=\{\(e\) => setShowCrossSourceLinks\(e\.target\.checked\)\}/);
  });

  it.each(MAPS)('%s mounts the 2D layer only while the toggle is on', (rel) => {
    expect(read(rel)).toMatch(/\{showCrossSourceLinks && [^}]*\(\s*<CrossSourceLinksLayer/);
  });

  it.each(MAPS)('%s passes the toggle to the 3D view', (rel) => {
    expect(read(rel)).toMatch(/showCrossSourceLinks=\{[^}]*showCrossSourceLinks/);
  });

  it('the locale file has the toggle label', () => {
    const en = JSON.parse(read('public/locales/en.json'));
    expect(en['map.cross_source.toggle']).toBe('Show Cross-Source Links');
  });
});

/**
 * #5580 wiring guard: the "Traceroute-Confirmed Links" sub-toggle must exist
 * under "Show Cross-Source Links" in BOTH Map Features panels, default on,
 * and both maps must mount the sibling 2D layer and feed the 3D view only
 * while BOTH toggles are on.
 */
describe('traceroute-confirmed links wiring (#5580)', () => {
  it.each(MAPS)('%s reads the sub-toggle from MapContext', (rel) => {
    const src = read(rel);
    expect(src).toContain('showTracerouteConfirmedLinks');
    expect(src).toContain('setShowTracerouteConfirmedLinks');
  });

  it.each(MAPS)('%s has the sub-toggle checkbox, after the parent and shown only while the parent is on', (rel) => {
    const src = read(rel);
    expect(src).toContain("t('map.traceroute_confirmed.toggle'");
    expect(src).toMatch(/onChange=\{\(e\) => setShowTracerouteConfirmedLinks\(e\.target\.checked\)\}/);
    const parent = src.indexOf("t('map.cross_source.toggle'");
    const child = src.indexOf("t('map.traceroute_confirmed.toggle'");
    expect(parent).toBeGreaterThan(-1);
    expect(child).toBeGreaterThan(parent);
    // Gated on the parent toggle and styled as a sub-item.
    const between = src.slice(parent, child);
    expect(between).toMatch(/\{showCrossSourceLinks( === true)? && \(/);
    expect(between).toContain('subToggleStyles.subToggle');
  });

  it.each(MAPS)('%s mounts the sibling 2D layer only while both toggles are on', (rel) => {
    expect(read(rel)).toMatch(
      /\{showCrossSourceLinks && showTracerouteConfirmedLinks && [^}]*\(\s*<TracerouteConfirmedLinksLayer/,
    );
  });

  it.each(MAPS)('%s passes "both toggles on" to the 3D view', (rel) => {
    expect(read(rel)).toMatch(
      /showTracerouteConfirmedLinks=\{[^}]*showCrossSourceLinks[^}]*showTracerouteConfirmedLinks/,
    );
  });

  it('MapContext defaults the sub-toggle to on and persists it per browser', () => {
    const src = read('src/contexts/MapContext.tsx');
    expect(src).toMatch(/localStorage\.getItem\('showTracerouteConfirmedLinks'\) !== 'false'/);
    expect(src).toMatch(/localStorage\.setItem\('showTracerouteConfirmedLinks'/);
  });

  it('the sibling layer takes its look from crossSourceLinkStyle.ts', () => {
    const layer = read('src/components/map/layers/TracerouteConfirmedLinksLayer.tsx');
    expect(layer).toContain('tracerouteConfirmedLinkStyle');
    expect(read('src/utils/crossSourceLinkStyle.ts')).toContain('export function tracerouteConfirmedLinkStyle');
  });

  it('the locale file has the sub-toggle label', () => {
    const en = JSON.parse(read('public/locales/en.json'));
    expect(en['map.traceroute_confirmed.toggle']).toBe('Traceroute-Confirmed Links');
    expect(en['map.traceroute_confirmed.toggle_hint']).toMatch(/sends none/);
  });
});

