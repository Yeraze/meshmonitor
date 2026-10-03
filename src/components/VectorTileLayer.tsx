import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import { createCartoTransformRequest } from '../config/cartoKey';
import { resolveStyleUrl } from '../config/tilesets';

// Extend Leaflet types to include MapLibre GL
declare module 'leaflet' {
  interface MaplibreGLOptions {
    style: unknown;
    attribution?: string;
    /** Zoom ceiling. Read by Leaflet's zoom-limit table once the layer is
     *  registered there (see below); the adapter also forwards it to
     *  `new maplibregl.Map(options)`. */
    maxZoom?: number;
    /** Forwarded by the adapter to `new maplibregl.Map(options)`. */
    transformRequest?: (url: string, resourceType?: string) => { url: string } | undefined;
    /** Forwarded to `maplibregl.Map`. False draws one world only (#5556). */
    renderWorldCopies?: boolean;
  }
  function maplibreGL(options: MaplibreGLOptions): L.Layer;
}

/** Leaflet's zoom-limit table. Private in Leaflet 1.x but stable: `GridLayer`
 *  calls these from `beforeAdd`/`onRemove`, which is how a raster `TileLayer`
 *  gives the map its `maxZoom`. */
type ZoomLimitMap = L.Map & {
  _addZoomLimit?: (layer: L.Layer) => void;
  _removeZoomLimit?: (layer: L.Layer) => void;
};

interface VectorTileLayerProps {
  url: string;
  attribution?: string;
  maxZoom?: number;
  styleJson?: Record<string, unknown>;
  /** Complete MapLibre GL style URL (#5448, e.g. a CARTO GL style). When set,
   *  MapLibre loads this style as-is and `url`/`styleJson` are ignored. */
  styleUrl?: string;
  /** Carto basemap API key (#4934/#5448). Appended to every Carto CDN request
   *  (style, tiles, sprites, glyphs) through MapLibre's `transformRequest`. */
  cartoApiKey?: string | null;
}

/** The app's base URL: the server-injected `<base href>` when deployed under a
 *  `BASE_URL` sub-path, else the origin root. Deliberately NOT
 *  `document.baseURI`, which without a `<base>` tag is the current route
 *  (e.g. `/nodes/…`) and would resolve a bundled style under that route. */
function appBaseUri(): string {
  const href = document.querySelector('base')?.getAttribute('href') || '/';
  return new URL(href, window.location.origin).href;
}

/**
 * Vector tile layer component for rendering .pbf/.mvt tiles using MapLibre GL
 *
 * Uses MapLibre GL renderer wrapped as a Leaflet layer to display vector tiles.
 * Vector tiles are rendered client-side with a default style, or a custom styleJson.
 */
export function VectorTileLayer({ url, attribution, maxZoom = 14, styleJson, styleUrl, cartoApiKey }: VectorTileLayerProps) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    let style: unknown;

    if (styleUrl) {
      // A complete published GL style: hand it to MapLibre untouched. The
      // patch-sources / default-style branches below assume a `.pbf` template.
      style = resolveStyleUrl(styleUrl, appBaseUri());
    } else if (styleJson) {
      // Deep-clone and patch all vector sources to point at the active tile URL
      const patched = JSON.parse(JSON.stringify(styleJson));
      if (patched.sources && typeof patched.sources === 'object') {
        for (const [, source] of Object.entries(patched.sources)) {
          if (source && typeof source === 'object' && (source as any).type === 'vector') {
            (source as any).tiles = [url];
            delete (source as any).url;
          }
        }
      }
      style = patched;
    } else {
    // Create MapLibre GL default style object for vector tiles
    const defaultStyle = {
      version: 8,
      sources: {
        'vector-tiles': {
          type: 'vector',
          tiles: [url],
          maxzoom: maxZoom
        }
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: {
            'background-color': '#f8f8f8'
          }
        },
        {
          id: 'water',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'water',
          paint: {
            'fill-color': '#a0c8f0'
          }
        },
        {
          id: 'waterway',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'waterway',
          paint: {
            'line-color': '#a0c8f0',
            'line-width': {
              base: 1.3,
              stops: [
                [8, 1],
                [14, 3],
                [18, 6]
              ]
            }
          }
        },
        {
          id: 'landuse',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'landuse',
          paint: {
            'fill-color': '#e8eddb'
          }
        },
        {
          id: 'landcover',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'landcover',
          paint: {
            'fill-color': '#d4e2c6',
            'fill-opacity': 0.5
          }
        },
        {
          id: 'park',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'park',
          paint: {
            'fill-color': '#c8e6b6'
          }
        },
        {
          id: 'building',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'building',
          paint: {
            'fill-color': '#d9d0c9',
            'fill-opacity': 0.7
          }
        },
        {
          id: 'aeroway-area',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'aeroway',
          filter: ['==', '$type', 'Polygon'],
          paint: {
            'fill-color': '#e8e8e8',
            'fill-opacity': 0.8
          }
        },
        {
          id: 'aeroway-runway',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'aeroway',
          filter: ['==', '$type', 'LineString'],
          paint: {
            'line-color': '#d0d0d0',
            'line-width': {
              base: 1.5,
              stops: [
                [10, 2],
                [14, 8],
                [18, 20]
              ]
            }
          }
        },
        {
          id: 'road-casing',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'transportation',
          paint: {
            'line-color': '#cfcdca',
            'line-width': {
              base: 1.4,
              stops: [
                [6, 0.5],
                [20, 10]
              ]
            }
          }
        },
        {
          id: 'road',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'transportation',
          paint: {
            'line-color': '#ffffff',
            'line-width': {
              base: 1.4,
              stops: [
                [6, 0.3],
                [20, 8]
              ]
            }
          }
        },
        {
          id: 'boundary',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'boundary',
          paint: {
            'line-color': '#9e9cab',
            'line-dasharray': [4, 2]
          }
        },
        {
          id: 'road-label',
          type: 'symbol',
          source: 'vector-tiles',
          'source-layer': 'transportation_name',
          layout: {
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
            'text-font': ['Open Sans Regular'],
            'symbol-placement': 'line',
            'text-size': {
              base: 1,
              stops: [
                [10, 10],
                [14, 12],
                [18, 14]
              ]
            },
            'text-max-angle': 30,
            'text-padding': 2
          },
          paint: {
            'text-color': '#555',
            'text-halo-color': '#fff',
            'text-halo-width': 1.5
          }
        },
        {
          id: 'place-label',
          type: 'symbol',
          source: 'vector-tiles',
          'source-layer': 'place',
          layout: {
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
            'text-font': ['Open Sans Regular'],
            'text-size': {
              base: 1,
              stops: [
                [0, 10],
                [10, 14]
              ]
            }
          },
          paint: {
            'text-color': '#333',
            'text-halo-color': '#fff',
            'text-halo-width': 1
          }
        },
        {
          id: 'water-label',
          type: 'symbol',
          source: 'vector-tiles',
          'source-layer': 'water_name',
          layout: {
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
            'text-font': ['Open Sans Regular'],
            'text-size': {
              base: 1,
              stops: [
                [8, 10],
                [14, 14]
              ]
            }
          },
          paint: {
            'text-color': '#5a8fc7',
            'text-halo-color': '#fff',
            'text-halo-width': 1
          }
        },
        {
          id: 'poi-label',
          type: 'symbol',
          source: 'vector-tiles',
          'source-layer': 'poi',
          minzoom: 14,
          layout: {
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
            'text-font': ['Open Sans Regular'],
            'text-size': 11,
            'text-offset': [0, 0.8],
            'text-anchor': 'top',
            'icon-image': '',
            'icon-size': 0.8
          },
          paint: {
            'text-color': '#666',
            'text-halo-color': '#fff',
            'text-halo-width': 1
          }
        }
      ]
    };

      style = defaultStyle;
    }

    // Create MapLibre GL layer using Leaflet's extended API
    let vectorLayer: any;
    try {
      vectorLayer = L.maplibreGL({
        style: style,
        attribution: attribution,
        // No `minZoom`: the adapter forwards options to maplibregl.Map, which
        // runs one zoom level below Leaflet. A floor of 0 there would clamp
        // the GL canvas at Leaflet zoom 0 (MapLibre's own floor is -2).
        maxZoom,
        // Appends the Carto key to Carto-CDN requests only; every other host
        // (self-hosted tiles, same-origin styles) passes through untouched.
        transformRequest: createCartoTransformRequest(cartoApiKey),
        // One world, matching the raster `noWrap` + `maxBounds` in BaseMap (#5556).
        renderWorldCopies: false,
      });

      // Add to map, then register its zoom bounds. The MapLibre adapter
      // extends plain `L.Layer`, not `GridLayer`, so Leaflet never reads its
      // `maxZoom` on its own. Without this the map has no zoom ceiling at all
      // (`getMaxZoom()` is Infinity), and leaflet.markercluster throws
      // "Map has no maxZoom specified" (#5516).
      vectorLayer.addTo(map);
      (map as ZoomLimitMap)._addZoomLimit?.(vectorLayer);
    } catch (err) {
      console.error('Failed to create MapLibre GL layer:', err);
      return;
    }

    // Cleanup on unmount
    return () => {
      try {
        map.removeLayer(vectorLayer);
      } catch { /* layer may already be removed */ }
      (map as ZoomLimitMap)._removeZoomLimit?.(vectorLayer);
    };
  }, [map, url, attribution, maxZoom, styleJson, styleUrl, cartoApiKey]);

  return null;
}
