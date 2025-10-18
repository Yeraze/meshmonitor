/**
 * Available map tilesets configuration
 */

// Type-safe tileset IDs using string literal union
export type TilesetId = 'osm' | 'osmHot' | 'cartoDark' | 'cartoLight' | 'openTopo' | 'esriSatellite';

export interface TilesetConfig {
  readonly id: TilesetId;
  readonly name: string;
  readonly url: string;
  readonly attribution: string;
  readonly maxZoom: number;
  readonly description: string;
}

export const TILESETS: Readonly<Record<TilesetId, TilesetConfig>> = {
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

export const DEFAULT_TILESET_ID: TilesetId = 'osm';

/**
 * Type guard to check if a string is a valid TilesetId
 */
export function isTilesetId(id: string): id is TilesetId {
  return id in TILESETS;
}

/**
 * Get tileset configuration by ID with type safety
 * Returns default tileset if ID is invalid
 */
export function getTilesetById(id: string): TilesetConfig {
  if (isTilesetId(id)) {
    return TILESETS[id];
  }
  return TILESETS[DEFAULT_TILESET_ID];
}

/**
 * Get all available tilesets as an array
 */
export function getAllTilesets(): readonly TilesetConfig[] {
  return Object.values(TILESETS);
}
