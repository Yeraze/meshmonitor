import { describe, it, expect } from 'vitest';
import {
  getOverlayColors,
  getSchemeForTileset,
  darkOverlayColors,
  lightOverlayColors,
  tilesetSchemeMap,
} from './overlayColors';

describe('overlayColors', () => {
  describe('getOverlayColors', () => {
    it('returns dark colors for dark scheme', () => {
      expect(getOverlayColors('dark')).toBe(darkOverlayColors);
    });

    it('returns light colors for light scheme', () => {
      expect(getOverlayColors('light')).toBe(lightOverlayColors);
    });
  });

  describe('getSchemeForTileset', () => {
    it('returns light for OSM', () => {
      expect(getSchemeForTileset('osm')).toBe('light');
    });

    it('returns dark for cartoDark', () => {
      expect(getSchemeForTileset('cartoDark')).toBe('dark');
    });

    it('returns dark for esriSatellite', () => {
      expect(getSchemeForTileset('esriSatellite')).toBe('dark');
    });

    it('defaults to dark for unknown tileset IDs', () => {
      expect(getSchemeForTileset('custom-abc')).toBe('dark');
    });

    it('uses customOverlayScheme when provided', () => {
      expect(getSchemeForTileset('custom-abc', 'light')).toBe('light');
    });

    it('customOverlayScheme overrides built-in mapping', () => {
      expect(getSchemeForTileset('osm', 'dark')).toBe('dark');
    });
  });

  describe('tilesetSchemeMap completeness', () => {
    it('maps all 6 built-in tilesets', () => {
      expect(Object.keys(tilesetSchemeMap)).toHaveLength(6);
      expect(tilesetSchemeMap).toHaveProperty('osm');
      expect(tilesetSchemeMap).toHaveProperty('osmHot');
      expect(tilesetSchemeMap).toHaveProperty('cartoDark');
      expect(tilesetSchemeMap).toHaveProperty('cartoLight');
      expect(tilesetSchemeMap).toHaveProperty('openTopo');
      expect(tilesetSchemeMap).toHaveProperty('esriSatellite');
    });
  });

  describe('color scheme structure', () => {
    it('dark and light schemes have same keys', () => {
      expect(Object.keys(darkOverlayColors).sort()).toEqual(Object.keys(lightOverlayColors).sort());
    });

    it('dark and light schemes have different traceroute forward colors', () => {
      expect(darkOverlayColors.tracerouteForward).not.toBe(lightOverlayColors.tracerouteForward);
    });
  });
});
