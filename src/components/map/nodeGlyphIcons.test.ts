import { describe, it, expect } from 'vitest';
import { glyphIconId, parseGlyphIconId, GLYPH_ICON_SIZE } from './nodeGlyphIcons';

describe('nodeGlyphIcons id helpers (#4808)', () => {
  it('composes a "<family>_<color>" id', () => {
    expect(glyphIconId('repeater', '#0000FF')).toBe('repeater_#0000FF');
    expect(glyphIconId('sensor', '#22c55e')).toBe('sensor_#22c55e');
  });

  it('round-trips an id back into family + color', () => {
    const id = glyphIconId('roomServer', '#990066');
    expect(parseGlyphIconId(id)).toEqual({ family: 'roomServer', color: '#990066' });
  });

  it('splits on the FIRST underscore only, so the hex color survives intact', () => {
    // Colors carry a `#` but no `_`; the split must not be greedy.
    expect(parseGlyphIconId('companion_#FF0000')).toEqual({ family: 'companion', color: '#FF0000' });
  });

  it('returns null for an id with no underscore (e.g. the SDF disc id)', () => {
    expect(parseGlyphIconId('node-marker-icon')).toBeNull();
  });

  it('exposes a positive source size', () => {
    expect(GLYPH_ICON_SIZE).toBeGreaterThan(0);
  });
});
