/**
 * Maps embedded in scrolling settings pages must sit in their own stacking
 * context.
 *
 * Leaflet's panes (z-index 400) and controls (1000) live under
 * `.leaflet-container`, which forms no stacking context, so they competed with
 * the sticky SectionNav (z-index 10) in the root context and painted over it
 * once the Geofence map scrolled under the nav at 1280px. jsdom has no layout
 * or cascade, so these assertions read the stylesheet and the wrappers' source,
 * like the other stylesheet tests under src/components.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve('src/components/map/EmbeddedMapFrame.module.css'), 'utf-8');
const frameRule = css.match(/\.frame\s*\{([^}]*)\}/)?.[1] ?? '';

describe('EmbeddedMapFrame stacking context', () => {
  it('isolates the frame so Leaflet z-indexes cannot escape it', () => {
    expect(frameRule).not.toBe('');
    expect(frameRule).toMatch(/isolation:\s*isolate/);
  });

  it('does not lift the frame above page chrome with a positive z-index', () => {
    const z = frameRule.match(/z-index:\s*(-?\d+)/);
    if (z) expect(Number(z[1])).toBeLessThanOrEqual(0);
  });

  // Every BaseMap rendered inside a settings page with a sticky SectionNav.
  const consumers = [
    'src/components/GeofenceMapEditor.tsx',
    'src/components/BBoxMapEditor.tsx',
    'src/components/configuration/DefaultMapCenterPicker.tsx',
    'src/components/settings/EmbedSettings.tsx',
  ];

  it.each(consumers)('%s wraps its map in the isolated frame', (file) => {
    const src = readFileSync(resolve(file), 'utf-8');
    expect(src).toMatch(/import mapFrame from '\.{1,2}\/map\/EmbeddedMapFrame\.module\.css';/);
    // The frame class must sit on the element that directly wraps <BaseMap.
    expect(src).toMatch(/className=\{`?[^}\n]*mapFrame\.frame[^\n]*\n\s*(?:[^\n]*\n\s*)*?<BaseMap/);
  });
});
