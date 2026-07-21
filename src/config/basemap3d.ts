/**
 * Pure, react-free helpers for resolving the 3D (MapLibre GL) basemap from
 * the app's existing 2D (Leaflet) tileset config (#3826 Phase 2 WP-B, spec
 * §2.7 / §2.14).
 *
 * MapLibre raster sources differ from Leaflet `TileLayer` in two ways that
 * matter here:
 *  - MapLibre has no `{s}` subdomain placeholder — Leaflet-style URLs using
 *    it (`osm`/`osmHot`/`carto*`/`openTopo`) must be expanded into an
 *    explicit `tiles[]` array, one entry per subdomain.
 *  - MapLibre raster sources cannot render a vector (`.pbf`/`.mvt`) tileset
 *    without a full style JSON (out of scope this phase) — vector-only
 *    tilesets fall back to the default `osm` raster basemap for 3D only;
 *    the 2D view is unaffected.
 */
import { getTilesetById, TILESETS, type TilesetId, type CustomTileset } from './tilesets';

export interface Basemap3DSource {
  tiles: string[];
  attribution: string;
  maxZoom: number;
  /** True when the requested tileset was vector-only and we substituted `osm`. */
  usedFallback: boolean;
}

/** Leaflet subdomains conventionally used by `{s}`-templated tile hosts. */
const SUBDOMAINS = ['a', 'b', 'c'];

/**
 * Expand a Leaflet `{s}` subdomain placeholder into an explicit list of
 * URLs (one per subdomain) for MapLibre's `tiles[]` array. URLs without
 * `{s}` are returned unchanged as a single-element array.
 */
export function expandSubdomains(url: string): string[] {
  if (!url.includes('{s}')) return [url];
  return SUBDOMAINS.map((s) => url.replace('{s}', s));
}

/**
 * Resolve the raster basemap source to feed a MapLibre GL map from the
 * user's current 2D tileset selection. Vector-only tilesets (predefined or
 * custom) fall back to `TILESETS.osm` with `usedFallback: true` so callers
 * can surface a non-blocking note.
 */
export function resolve3DBasemap(tilesetId: TilesetId, custom: CustomTileset[] = []): Basemap3DSource {
  const tileset = getTilesetById(tilesetId, custom);

  if (tileset.isVector) {
    const fallback = TILESETS.osm;
    return {
      tiles: expandSubdomains(fallback.url),
      attribution: fallback.attribution,
      maxZoom: fallback.maxZoom,
      usedFallback: true,
    };
  }

  return {
    tiles: expandSubdomains(tileset.url),
    attribution: tileset.attribution,
    maxZoom: tileset.maxZoom,
    usedFallback: false,
  };
}

/**
 * Build the same-origin DEM terrain tile URL template honoring the
 * deployment base path (e.g. `/meshmonitor`, matching `ApiService`'s
 * `baseUrl` / `import.meta.env.BASE_URL`). `basePath` may be empty (root
 * deployment), with or without a trailing slash.
 */
export function buildTerrainTileUrl(basePath: string): string {
  const base = basePath.replace(/\/$/, '');
  return `${base}/api/elevation/tiles/{z}/{x}/{y}`;
}
