/**
 * Available map tilesets configuration
 */

// Type-safe tileset IDs using string literal union (predefined only)
export type PredefinedTilesetId = 'osm' | 'osmHot' | 'cartoDark' | 'cartoLight' | 'openTopo' | 'esriSatellite';

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
}

export interface TilesetConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly attribution: string;
  readonly maxZoom: number;
  readonly description: string;
  readonly isCustom?: boolean;
  readonly isVector?: boolean;
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
