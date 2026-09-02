import { describe, it, expect } from 'vitest';
import { isCartoUrl } from './cartoKey';
import {
  TILESETS,
  getTilesetById,
  getAllTilesets,
  type CustomTileset,
} from './tilesets';

describe('tilesets — hybrid overlay support', () => {
  it('exposes the esriHybrid tileset with an ESRI reference-label overlayUrl', () => {
    const hybrid = TILESETS.esriHybrid;
    expect(hybrid).toBeDefined();
    expect(hybrid.name).toBe('Satellite + Labels');
    // Base is the same imagery as the plain satellite tileset...
    expect(hybrid.url).toContain('World_Imagery');
    // ...with a transparent reference overlay stacked on top.
    expect(hybrid.overlayUrl).toBeDefined();
    expect(hybrid.overlayUrl).toContain('World_Reference_Overlay');
    expect(hybrid.overlayUrl).toMatch(/\{z\}.*\{y\}.*\{x\}/); // ESRI z/y/x order
    // The overlay credits its own sources (Garmin/USGS/NPS), distinct from the
    // imagery attribution — ESRI serves them as separate services.
    expect(hybrid.overlayAttribution).toBeDefined();
    expect(hybrid.overlayAttribution).toContain('Garmin');
    expect(hybrid.overlayAttribution).not.toBe(hybrid.attribution);
  });

  it('plain esriSatellite has no overlayUrl (kept as a distinct option)', () => {
    expect(TILESETS.esriSatellite.overlayUrl).toBeUndefined();
  });

  it('getTilesetById resolves esriHybrid with its overlayUrl intact', () => {
    const t = getTilesetById('esriHybrid');
    expect(t.id).toBe('esriHybrid');
    expect(t.overlayUrl).toContain('World_Reference_Overlay');
  });

  it('getTilesetById passes overlayUrl through for custom tilesets', () => {
    const custom: CustomTileset = {
      id: 'custom-hybrid',
      name: 'My Hybrid',
      url: 'https://base/{z}/{x}/{y}.png',
      overlayUrl: 'https://labels/{z}/{x}/{y}.png',
      attribution: '',
      maxZoom: 18,
      description: '',
      createdAt: 0,
      updatedAt: 0,
    };
    const resolved = getTilesetById('custom-hybrid', [custom]);
    expect(resolved.overlayUrl).toBe('https://labels/{z}/{x}/{y}.png');
    expect(getAllTilesets([custom]).find(t => t.id === 'custom-hybrid')?.overlayUrl)
      .toBe('https://labels/{z}/{x}/{y}.png');
  });
});

describe('tilesets — keyless dark basemap (#5015)', () => {
  it('ships a dark basemap that needs no CARTO key', () => {
    const dark = TILESETS.esriDarkGray;
    expect(dark).toBeDefined();
    // The whole point: this must not be a CARTO URL, or it inherits the exact
    // "API KEY REQUIRED" watermark problem it exists to avoid.
    expect(isCartoUrl(dark.url)).toBe(false);
    expect(isCartoUrl(dark.overlayUrl!)).toBe(false);
    // Same host as the satellite tilesets, so no new origin is introduced.
    expect(dark.url).toContain('server.arcgisonline.com');
    expect(dark.url).toContain('World_Dark_Gray_Base');
    // Base tiles carry no labels, so the reference layer rides along.
    expect(dark.overlayUrl).toContain('World_Dark_Gray_Reference');
    expect(dark.url).toMatch(/\{z\}.*\{y\}.*\{x\}/); // ESRI z/y/x order
  });

  it('caps native zoom at 16 while keeping the usual 19 ceiling', () => {
    const dark = TILESETS.esriDarkGray;
    // The service ADVERTISES maxLOD 23, but from z17 up every tile is the same
    // blank placeholder. maxNativeZoom pins the deepest level that has real
    // data so Leaflet upscales instead of fetching nothing...
    expect(dark.maxNativeZoom).toBe(16);
    // ...while maxZoom stays level with the other tilesets, so switching to
    // this basemap never yanks the zoom ceiling out from under the user.
    expect(dark.maxZoom).toBe(19);
    expect(dark.maxZoom).toBe(TILESETS.osm.maxZoom);
  });

  it('is the only tileset that needs a native-zoom cap', () => {
    // A guard on the invariant, not the value: if a future tileset gets a cap,
    // whoever adds it should confirm BaseMap still keys its TileLayer on
    // maxNativeZoom (it is part of the remount key).
    const capped = Object.values(TILESETS)
      .filter((t) => t.maxNativeZoom !== undefined)
      .map((t) => t.id);
    expect(capped).toEqual(['esriDarkGray']);
  });

  it('CARTO tilesets remain available for keyed deployments', () => {
    // The fix changes a DEFAULT. It must not remove the Carto options, which
    // are still the best dark/light rasters when a key is configured.
    expect(TILESETS.cartoDark).toBeDefined();
    expect(TILESETS.cartoLight).toBeDefined();
    expect(isCartoUrl(TILESETS.cartoDark.url)).toBe(true);
  });
});
