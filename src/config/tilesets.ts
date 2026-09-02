/**
 * Available map tilesets configuration
 */

// Type-safe tileset IDs using string literal union (predefined only)
export type PredefinedTilesetId = 'osm' | 'osmHot' | 'cartoDark' | 'cartoLight' | 'esriDarkGray' | 'openTopo' | 'esriSatellite' | 'esriHybrid';

// Custom tilesets can have any string ID (must start with 'custom-')
export type TilesetId = PredefinedTilesetId | string;

export interface CustomTileset {
  id: string;
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  description: string;
  createdAt: number;
  updatedAt: number;
  isVector?: boolean;
  overlayScheme?: 'light' | 'dark';
  overlayUrl?: string;
  overlayAttribution?: string;
}

export interface TilesetConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly attribution: string;
  readonly maxZoom: number;
  /** Highest zoom the provider actually has TILES for, when that is lower than
   *  `maxZoom`. Leaflet then upscales the deepest real tile instead of
   *  requesting levels that do not exist, so the user can keep zooming without
   *  the map going blank. Omit when the provider has tiles all the way to
   *  `maxZoom` (every tileset here except esriDarkGray, see #5015). */
  readonly maxNativeZoom?: number;
  readonly description: string;
  readonly isCustom?: boolean;
  readonly isVector?: boolean;
  /** Optional transparent raster overlay drawn on top of the base tiles (e.g.
   *  labels/roads over satellite imagery). Raster tilesets only. */
  readonly overlayUrl?: string;
  /** Attribution for the overlay layer. The overlay's data sources usually
   *  differ from the base (e.g. ESRI's reference overlay credits Garmin/USGS/NPS,
   *  not the imagery providers), so it needs its own credit. Falls back to
   *  `attribution` when omitted. Only meaningful alongside `overlayUrl`. */
  readonly overlayAttribution?: string;
}

export const TILESETS: Readonly<Record<PredefinedTilesetId, TilesetConfig>> = {
  osm: {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    description: 'Standard OpenStreetMap tiles'
  },
  osmHot: {
    id: 'osmHot',
    name: 'OpenStreetMap HOT',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a>',
    maxZoom: 19,
    description: 'Humanitarian OpenStreetMap Team style'
  },
  cartoDark: {
    id: 'cartoDark',
    name: 'Dark Mode',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    description: 'Dark theme map'
  },
  cartoLight: {
    id: 'cartoLight',
    name: 'Light Mode',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    description: 'Clean light theme map'
  },
  // The only KEYLESS dark basemap we ship (#5015). Carto retired its free
  // keyless rasters, so `cartoDark` now serves an "API KEY REQUIRED"
  // watermark to anyone without a `cartoApiKey` — and serves it as a
  // perfectly valid HTTP 200 PNG, so nothing downstream can detect it. This
  // is therefore the dark default when no key is configured; see
  // DEFAULT_DARK_TILESET_ID / resolveDefaultDarkTileset in SettingsContext.
  //
  // Same `server.arcgisonline.com` host as esriSatellite/esriHybrid, so it
  // adds no new origin (nothing to change in CSP or connect-src). Base tiles
  // are label-free, so the companion Dark Gray Reference layer rides along as
  // `overlayUrl` — the same mechanism esriHybrid uses for its place names.
  esriDarkGray: {
    id: 'esriDarkGray',
    name: 'Dark Gray',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    overlayUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    overlayAttribution: 'Labels &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    // Both services ADVERTISE maxLOD 23 in their ?f=json metadata, but that is
    // not where their data stops: from z17 up every tile is the same blank
    // placeholder. Verified against central London for BOTH layers — the Base
    // returns distinct imagery at z14/15/16 then one identical 2521-byte tile
    // from z17, and the Reference (labels) layer stops at exactly the same
    // level, returning one identical 875-byte tile from z17. So a single cap
    // of 16 is right for the pair, and no label resolution is being thrown
    // away. Trusting the advertised number would give a map that silently
    // goes blank when you zoom in on a node.
    //
    // So keep maxZoom at 19 to match the other tilesets — switching basemaps
    // must not yank the zoom ceiling out from under the user — and set
    // maxNativeZoom to the real 16, which makes Leaflet upscale the z16 tile
    // rather than fetch nonexistent levels.
    maxZoom: 19,
    maxNativeZoom: 16,
    description: 'Dark theme map, no API key required'
  },
  openTopo: {
    id: 'openTopo',
    name: 'Topographic',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17,
    description: 'Topographic map with elevation contours'
  },
  esriSatellite: {
    id: 'esriSatellite',
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 18,
    description: 'Satellite imagery'
  },
  esriHybrid: {
    id: 'esriHybrid',
    name: 'Satellite + Labels',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    overlayUrl: 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Reference_Overlay/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    overlayAttribution: 'Labels &copy; Esri &mdash; Sources: Esri, Garmin, USGS, NPS',
    maxZoom: 18,
    description: 'Satellite imagery with place names and road labels'
  }
} as const;

export const DEFAULT_TILESET_ID: PredefinedTilesetId = 'osm';

/**
 * Type guard to check if a string is a valid predefined TilesetId
 */
export function isPredefinedTilesetId(id: string): id is PredefinedTilesetId {
  return id in TILESETS;
}

/**
 * Get tileset configuration by ID with type safety
 * Checks both predefined and custom tilesets
 * Returns default tileset if ID is invalid
 */
export function getTilesetById(id: string, customTilesets: CustomTileset[] = []): TilesetConfig {
  // Check predefined tilesets first
  if (isPredefinedTilesetId(id)) {
    return TILESETS[id];
  }

  // Check custom tilesets
  const customTileset = customTilesets.find(ct => ct.id === id);
  if (customTileset) {
    return {
      ...customTileset,
      isCustom: true,
      isVector: customTileset.isVector ?? isVectorTileUrl(customTileset.url)
    };
  }

  // Fallback to default
  return TILESETS[DEFAULT_TILESET_ID];
}

/**
 * Get all available tilesets as an array
 * Merges predefined and custom tilesets
 */
export function getAllTilesets(customTilesets: CustomTileset[] = []): TilesetConfig[] {
  const predefined = Object.values(TILESETS);
  const custom = customTilesets.map(ct => ({
    ...ct,
    isCustom: true as const,
    isVector: ct.isVector ?? isVectorTileUrl(ct.url)
  }));
  return [...predefined, ...custom];
}

/**
 * Detect if a tile URL is for vector tiles based on file extension
 * Vector tiles use .pbf or .mvt extensions
 */
export function isVectorTileUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('.pbf') || lowerUrl.includes('.mvt');
}

/**
 * Validate tile URL format
 * Must contain {z}, {x}, {y} placeholders and be a valid URL
 */
export function validateTileUrl(url: string): { valid: boolean; error?: string } {
  // Must contain required placeholders
  if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    return {
      valid: false,
      error: 'URL must contain {z}, {x}, and {y} placeholders'
    };
  }

  // Validate URL format
  try {
    const testUrl = url
      .replace(/{z}/g, '0')
      .replace(/{x}/g, '0')
      .replace(/{y}/g, '0')
      .replace(/{s}/g, 'a');

    const parsedUrl = new URL(testUrl);

    // Only allow http and https
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        valid: false,
        error: 'URL must use http:// or https:// protocol'
      };
    }

    // Warn about HTTP (but still valid)
    if (parsedUrl.protocol === 'http:' && !parsedUrl.hostname.includes('localhost') && !parsedUrl.hostname.includes('127.0.0.1')) {
      return {
        valid: true,
        error: 'Warning: HTTPS is recommended for security'
      };
    }

    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format'
    };
  }
}
