/**
 * The 3D map rasterizes glyphs by FAMILY (`glyphFamilyMarkerSvg`) while the 2D
 * maps draw by CATEGORY (`roleGlyphMarkerSvg`). They must agree, or a node
 * changes icon when the map flips to 3D (#5491).
 */
import { describe, it, expect } from 'vitest';
import { glyphFamilyMarkerSvg, roleGlyphMarkerSvg } from './roleGlyphSvg';
import { categoryGlyphFamily, type NodeTypeCategory } from './nodeTypeCategory';

const COLOR = '#0000FF';

describe('glyphFamilyMarkerSvg', () => {
  const categories: NodeTypeCategory[] = ['repeater', 'roomServer', 'sensor', 'companion', 'mtRouter', 'mtRepeater', 'mtSensor'];

  it.each(categories)('matches the 2D glyph for %s', (category) => {
    expect(glyphFamilyMarkerSvg(categoryGlyphFamily(category), COLOR, 32)).toBe(roleGlyphMarkerSvg(category, COLOR, 32));
  });

  it('draws the router and MeshCore repeater families differently', () => {
    expect(glyphFamilyMarkerSvg('router', COLOR)).not.toBe(glyphFamilyMarkerSvg('repeater', COLOR));
  });

  it('returns empty for the standard family', () => {
    expect(glyphFamilyMarkerSvg('standard', COLOR)).toBe('');
  });
});
