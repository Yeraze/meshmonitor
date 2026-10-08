import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';
import { createCartoTransformRequest } from '../config/cartoKey';
import { resolveStyleUrl } from '../config/tilesets';
import { isVectorRenderingAvailable, reportVectorRenderingFailure } from './map/vectorSupport';

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

/** Why a vector layer cannot be shown.
 *  - `unsupported`: the WebGL2 probe failed, so no layer was built.
 *  - `create-failed`: the probe passed but MapLibre could not get a context.
 *  - `context-lost`: a working layer lost its context and did not get it back. */
export type VectorUnavailableReason = 'unsupported' | 'create-failed' | 'context-lost';

/** How long a lost WebGL context may take to come back before the map gives
 *  up on vector tiles. MapLibre restores a lost context by itself when the
 *  browser hands one back; a browser that dropped the context for good (too
 *  many live contexts, a GPU reset) never does, and the map would stay blank. */
export const CONTEXT_RESTORE_GRACE_MS = 5000;

/** The adapter's private surface that this file guards. */
type GlMapLike = {
  on?: (type: string, listener: () => void) => unknown;
  off?: (type: string, listener: () => void) => unknown;
};
type AdapterLayer = L.Layer & {
  _glMap?: GlMapLike | null;
  _map?: L.Map | null;
  _container?: HTMLElement | null;
  _throttledUpdate?: unknown;
  options?: { updateInterval?: number };
  getMaplibreMap?: () => GlMapLike | null | undefined;
} & Record<string, unknown>;

/** Adapter handlers Leaflet calls on move/zoom/resize. Each one dereferences
 *  `this._glMap` with no check. */
const GL_HANDLERS = ['_update', '_pinchZoom', '_animateZoom', '_zoomEnd', '_transitionEnd', '_resize'] as const;

/**
 * Make one adapter layer safe when its MapLibre map does not exist.
 *
 * `@maplibre/maplibre-gl-leaflet` builds the GL map inside `onAdd`. Leaflet
 * binds the layer's map events BEFORE it calls `onAdd`, so when the
 * constructor throws (no WebGL2) the layer stays registered with live
 * handlers and no `_glMap`. The next move then throws "reading 'jumpTo'" and
 * the next `map.remove()` throws "reading 'remove'" from `onRemove`. That last
 * one runs inside React's unmount, outside any error boundary in the removed
 * subtree, and took the whole app down.
 *
 * Patched per instance (not by subclassing) so it also holds for whatever
 * `L.maplibreGL` returns. With a live GL map every wrapper is a pass-through.
 */
function hardenAdapterLayer(layer: AdapterLayer, onCreateError: (err: unknown) => void): void {
  for (const name of GL_HANDLERS) {
    const original = layer[name];
    if (typeof original !== 'function') continue;
    layer[name] = function guarded(this: AdapterLayer, ...args: unknown[]) {
      if (!this._glMap || !this._map) return undefined;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  // The adapter throttles the prototype `_update` in `initialize`, before the
  // loop above ran. Leaflet binds that throttled copy to `move`, so rebuild it
  // around the guarded one (same interval, same context).
  if (typeof layer._throttledUpdate === 'function' && typeof layer._update === 'function' && L.Util?.throttle) {
    layer._throttledUpdate = L.Util.throttle(
      layer._update as (...a: unknown[]) => void,
      layer.options?.updateInterval ?? 32,
      layer,
    );
  }

  const onAdd = layer.onAdd;
  if (typeof onAdd === 'function') {
    layer.onAdd = function guardedOnAdd(this: AdapterLayer, map: L.Map) {
      try {
        onAdd.call(this, map);
      } catch (err) {
        // Leaflet may run `onAdd` later than `addTo` (it waits for the map's
        // first view), so the caller's try/catch cannot be relied on.
        onCreateError(err);
      }
      return this;
    };
  }

  const onRemove = layer.onRemove;
  if (typeof onRemove === 'function') {
    layer.onRemove = function guardedOnRemove(this: AdapterLayer, map: L.Map) {
      if (!this._glMap) {
        // No GL map to tear down: `onAdd` threw before it bound anything, so
        // the pane's container is all that is left.
        this._container?.remove();
        return this;
      }
      onRemove.call(this, map);
      return this;
    };
  }
}

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
  /** Called at most once per layer when vector tiles cannot be shown. The
   *  layer has already removed itself; `BaseMap` draws a raster tileset in its
   *  place. */
  onUnavailable?: (reason: VectorUnavailableReason) => void;
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
export function VectorTileLayer({ url, attribution, maxZoom = 14, styleJson, styleUrl, cartoApiKey, onUnavailable }: VectorTileLayerProps) {
  const map = useMap();
  // Read through a ref so a new callback identity does not rebuild the layer.
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    if (!map) return;

    // No WebGL2: do not build a layer at all.
    if (!isVectorRenderingAvailable()) {
      onUnavailableRef.current?.('unsupported');
      return;
    }

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

    let vectorLayer: AdapterLayer | undefined;
    let glMap: GlMapLike | null | undefined;
    let disposed = false;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;

    const onContextLost = () => {
      if (restoreTimer !== undefined) return;
      restoreTimer = setTimeout(() => {
        restoreTimer = undefined;
        fail('context-lost');
      }, CONTEXT_RESTORE_GRACE_MS);
    };
    const onContextRestored = () => {
      if (restoreTimer !== undefined) clearTimeout(restoreTimer);
      restoreTimer = undefined;
    };

    // Idempotent: runs from the effect cleanup and from `fail`, in either order.
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (restoreTimer !== undefined) clearTimeout(restoreTimer);
      restoreTimer = undefined;
      try {
        glMap?.off?.('webglcontextlost', onContextLost);
        glMap?.off?.('webglcontextrestored', onContextRestored);
      } catch { /* the GL map may already be gone */ }
      glMap = null;
      if (!vectorLayer) return;
      try {
        map.removeLayer(vectorLayer);
      } catch { /* layer may already be removed */ }
      (map as ZoomLimitMap)._removeZoomLimit?.(vectorLayer);
    };

    function fail(reason: VectorUnavailableReason, err?: unknown) {
      if (disposed) return;
      if (reason === 'create-failed') {
        console.error('Failed to create MapLibre GL layer:', err);
        // The probe passed and creation still failed, so it will fail on the
        // next map too: every map falls back until the page reloads.
        reportVectorRenderingFailure();
      }
      dispose();
      onUnavailableRef.current?.(reason);
    }

    // Create MapLibre GL layer using Leaflet's extended API
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
      }) as AdapterLayer;
      hardenAdapterLayer(vectorLayer, (err) => fail('create-failed', err));

      // Add to map, then register its zoom bounds. The MapLibre adapter
      // extends plain `L.Layer`, not `GridLayer`, so Leaflet never reads its
      // `maxZoom` on its own. Without this the map has no zoom ceiling at all
      // (`getMaxZoom()` is Infinity), and leaflet.markercluster throws
      // "Map has no maxZoom specified" (#5516).
      vectorLayer.addTo(map);
      if (!disposed) {
        (map as ZoomLimitMap)._addZoomLimit?.(vectorLayer);
        // MapLibre restores a lost context itself. Watch only for the case
        // where the browser never gives one back.
        glMap = vectorLayer.getMaplibreMap?.();
        glMap?.on?.('webglcontextlost', onContextLost);
        glMap?.on?.('webglcontextrestored', onContextRestored);
      }
    } catch (err) {
      fail('create-failed', err);
    }

    // Cleanup on unmount
    return dispose;
  }, [map, url, attribution, maxZoom, styleJson, styleUrl, cartoApiKey]);

  return null;
}
