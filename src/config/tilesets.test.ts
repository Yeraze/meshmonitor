import { describe, it, expect } from 'vitest';
import { isCartoUrl } from './cartoKey';
import {
  TILESETS,
  getTilesetById,
  getAllTilesets,
  getRasterTileset,
  isVectorTileUrl,
  normalizeCustomMaxZoom,
  DEFAULT_CUSTOM_MAX_ZOOM,
  resolveStyleUrl,
  validateTileUrl,
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

describe('tilesets — CARTO vector presets (#5448)', () => {
  const STYLE_PRESETS = ['cartoVoyager', 'cartoPositron', 'cartoDarkMatter', 'cartoVoyagerDark'] as const;

  it.each(STYLE_PRESETS)('%s resolves as a vector tileset with a styleUrl', (id) => {
    const t = getTilesetById(id);
    expect(t.id).toBe(id);
    expect(t.isVector).toBe(true);
    expect(t.styleUrl).toBeTruthy();
    expect(getAllTilesets().some((x) => x.id === id)).toBe(true);
  });

  it.each(STYLE_PRESETS)('%s is not misclassified by the .pbf/.mvt URL sniffer', (id) => {
    const t = TILESETS[id];
    // The style URL is a JSON document, not a tile template, so the sniffer
    // (which only exists for custom tilesets) must not be what marks it
    // vector — the explicit isVector flag does.
    expect(isVectorTileUrl(t.styleUrl!)).toBe(false);
    expect(isVectorTileUrl(t.url)).toBe(false);
  });

  it.each(STYLE_PRESETS)('%s keeps a valid raster twin in url (thumbnail / 3D / mini-map)', (id) => {
    const t = TILESETS[id];
    // `url` must stay a real {z}/{x}/{y} raster template; validateTileUrl is
    // never run on styleUrl, which has no placeholders by design.
    expect(validateTileUrl(t.url).valid).toBe(true);
    expect(validateTileUrl(t.styleUrl!).valid).toBe(false);
    expect(isCartoUrl(t.url)).toBe(true);
  });

  it.each(STYLE_PRESETS)('%s credits OSM and CARTO and says it needs a key', (id) => {
    const t = TILESETS[id];
    expect(t.attribution).toContain('OpenStreetMap');
    expect(t.attribution).toContain('CARTO');
    expect(t.description).toMatch(/CARTO API key/);
  });

  it('points the three CARTO-published presets at CARTO GL styles', () => {
    expect(TILESETS.cartoVoyager.styleUrl).toBe('https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json');
    expect(TILESETS.cartoPositron.styleUrl).toBe('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json');
    expect(TILESETS.cartoDarkMatter.styleUrl).toBe('https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json');
  });

  it('serves Voyager Dark from the bundled same-origin style (relative path)', () => {
    expect(TILESETS.cartoVoyagerDark.styleUrl).toBe('map-styles/carto-voyager-dark.json');
  });

  it('every CARTO preset description notes the key requirement', () => {
    for (const t of Object.values(TILESETS)) {
      if (isCartoUrl(t.url)) expect(t.description).toMatch(/CARTO API key/);
    }
  });
});

describe('getRasterTileset (#5448)', () => {
  it('returns raster tilesets unchanged', () => {
    expect(getRasterTileset(TILESETS.osm)).toEqual({ tileset: TILESETS.osm, substituted: false });
  });

  it('returns a style preset itself (its url is the raster twin)', () => {
    expect(getRasterTileset(TILESETS.cartoVoyagerDark)).toEqual({
      tileset: TILESETS.cartoVoyagerDark,
      substituted: false,
    });
  });

  it('substitutes osm for a custom .pbf vector tileset', () => {
    const vector = getTilesetById('custom-v', [
      {
        id: 'custom-v',
        name: 'V',
        url: 'https://x.example/{z}/{x}/{y}.pbf',
        attribution: '',
        maxZoom: 14,
        description: '',
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(getRasterTileset(vector)).toEqual({ tileset: TILESETS.osm, substituted: true });
  });
});

describe('resolveStyleUrl (#5448)', () => {
  it('passes absolute style URLs through', () => {
    const url = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
    expect(resolveStyleUrl(url, 'https://mm.example/meshmonitor/')).toBe(url);
  });

  it('resolves a bundled style under a BASE_URL sub-path', () => {
    expect(resolveStyleUrl('map-styles/carto-voyager-dark.json', 'https://mm.example/meshmonitor/')).toBe(
      'https://mm.example/meshmonitor/map-styles/carto-voyager-dark.json',
    );
  });

  it('resolves a bundled style at the origin root', () => {
    expect(resolveStyleUrl('map-styles/carto-voyager-dark.json', 'http://localhost:8080/')).toBe(
      'http://localhost:8080/map-styles/carto-voyager-dark.json',
    );
  });
});

describe('custom tileset maxZoom clamp (#5516)', () => {
  const base: CustomTileset = {
    id: 'custom-vec',
    name: 'Vec',
    url: 'https://tiles.example.com/{z}/{x}/{y}.pbf',
    attribution: 'x',
    maxZoom: 14,
    description: '',
    createdAt: 0,
    updatedAt: 0,
  };
  const withMax = (maxZoom: unknown): CustomTileset => ({ ...base, maxZoom: maxZoom as number });

  it('keeps a valid ceiling', () => {
    expect(getTilesetById('custom-vec', [base]).maxZoom).toBe(14);
  });

  it('defaults a missing / NaN / Infinity ceiling to 18', () => {
    expect(DEFAULT_CUSTOM_MAX_ZOOM).toBe(18);
    for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}]) {
      expect(getTilesetById('custom-vec', [withMax(bad)]).maxZoom).toBe(18);
    }
  });

  it('clamps to 1..22 and rounds', () => {
    expect(normalizeCustomMaxZoom(0)).toBe(1);
    expect(normalizeCustomMaxZoom(-5)).toBe(1);
    expect(normalizeCustomMaxZoom(30)).toBe(22);
    expect(normalizeCustomMaxZoom(16.4)).toBe(16);
    expect(normalizeCustomMaxZoom('17')).toBe(17);
  });

  it('getAllTilesets clamps custom entries but leaves presets alone', () => {
    const all = getAllTilesets([withMax(Infinity)]);
    expect(all.find((t) => t.id === 'custom-vec')!.maxZoom).toBe(18);
    expect(all.find((t) => t.id === 'osm')!.maxZoom).toBe(19);
  });
});
