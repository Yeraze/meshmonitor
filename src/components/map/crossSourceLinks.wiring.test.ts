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
