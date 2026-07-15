import { describe, expect, it } from 'vitest';
import { getMapTilesetValidationError, normalizeMapTilesetPayload } from './mapTilesetPreferences.js';

describe('map tileset API payload compatibility', () => {
  it('mirrors a legacy-only update into both theme slots', () => {
    expect(normalizeMapTilesetPayload({ mapTileset: 'custom-4' })).toEqual({
      mapTileset: 'custom-4',
      mapTilesetLight: 'custom-4',
      mapTilesetDark: 'custom-4',
    });
  });

  it('preserves explicit themed values and partial updates', () => {
    expect(normalizeMapTilesetPayload({ mapTileset: 'cartoDark', mapTilesetLight: 'osm', mapTilesetDark: 'cartoDark' })).toEqual({
      mapTileset: 'cartoDark',
      mapTilesetLight: 'osm',
      mapTilesetDark: 'cartoDark',
    });
    expect(normalizeMapTilesetPayload({ mapTilesetDark: 'custom-night' })).toEqual({
      mapTileset: undefined,
      mapTilesetLight: undefined,
      mapTilesetDark: 'custom-night',
    });
  });

  it('validates every legacy and themed field', () => {
    expect(getMapTilesetValidationError({ mapTileset: 'osm' })).toBeNull();
    expect(getMapTilesetValidationError({ mapTilesetLight: null, mapTilesetDark: 'cartoDark' })).toBeNull();
    expect(getMapTilesetValidationError({ mapTilesetLight: 42 as any })).toBe('mapTilesetLight must be a string or null');
  });
});
