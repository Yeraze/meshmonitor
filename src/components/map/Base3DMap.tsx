import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Basemap3DSource } from '../../config/basemap3d';
import './Base3DMap.css';

/** A single node marker fed into the MapLibre `nodes` GeoJSON source. */
export interface Node3DFeature {
  key: string;
  lat: number;
  lng: number;
  label?: string;
  color?: string;
}

export interface Base3DMapProps {
  /** Initial center, [lat, lng] (converted to MapLibre's [lng, lat] internally). */
  center: [number, number];
  /** Initial zoom. */
  zoom: number;
  /** Raster basemap source, from `resolve3DBasemap`. */
  basemap: Basemap3DSource;
  /** Same-origin DEM tile URL template, from `buildTerrainTileUrl`. */
  terrainTileUrl: string;
  /** Node markers to render as a GeoJSON `circle` + `symbol` label layer. */
  nodes: Node3DFeature[];
  /** Fired when a node's circle marker is clicked, with its `key`. */
  onNodeClick?: (key: string) => void;
  className?: string;
}

const BASEMAP_SOURCE_ID = 'basemap-raster';
const BASEMAP_LAYER_ID = 'basemap-raster-layer';
const TERRAIN_SOURCE_ID = 'terrain-dem';
const HILLSHADE_LAYER_ID = 'terrain-hillshade';
const NODES_SOURCE_ID = 'nodes';
const NODES_CIRCLE_LAYER_ID = 'nodes-circle';
const NODES_LABEL_LAYER_ID = 'nodes-label';

const ELEVATION_ATTRIBUTION = 'Elevation: Mapzen / AWS Terrain Tiles';
const INITIAL_PITCH = 60;
const DEFAULT_EXAGGERATION = 1.3;
const EXAGGERATION_MIN = 0;
const EXAGGERATION_MAX = 2;
const EXAGGERATION_STEP = 0.1;

/** Build a GeoJSON FeatureCollection from the `nodes` prop for the `nodes` source. */
function toNodesFeatureCollection(nodes: Node3DFeature[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: nodes.map((n) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [n.lng, n.lat] },
      properties: { key: n.key, label: n.label ?? '', color: n.color ?? '#3fb1ce' },
    })),
  };
}

/**
 * Generic MapLibre GL 3D map surface (#3826 Phase 2 WP-C, spec §3.9).
 *
 * Map-Analysis-agnostic: all data comes in via props (`nodes`, `basemap`,
 * `terrainTileUrl`) and the only outbound signal is `onNodeClick`. Wraps
 * `maplibregl.Map` directly (not the Leaflet MapLibre adapter used by
 * `VectorTileLayer` — that embeds MapLibre *inside* Leaflet for 2D vector
 * tiles, the opposite of what a genuinely 3D/pitched surface needs).
 *
 * Lifecycle (spec §2.12): the `maplibregl.Map` is created once in a
 * mount-effect and destroyed via `map.remove()` in its cleanup, held in a
 * ref so the create/remove pair is symmetric — safe under React 19
 * StrictMode's dev double-mount (mount→unmount→mount leaves no dangling
 * WebGL context). `basemap`/`nodes`/exaggeration changes mutate the
 * existing map in separate effects rather than remounting it.
 *
 * Basemap-identity changes: this implementation removes and re-adds the
 * raster source/layer in place (simplest correct approach — MapLibre has
 * no "swap a raster source's tiles" primitive short of `removeSource`
 * followed by `addSource`, and raster sources are cheap to recreate,
 * unlike the terrain/hillshade/node layers which persist). The map itself
 * is never recreated.
 */
export function Base3DMap({
  center,
  zoom,
  basemap,
  terrainTileUrl,
  nodes,
  onNodeClick,
  className,
}: Base3DMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [exaggeration, setExaggeration] = useState(DEFAULT_EXAGGERATION);

  // Latest props, readable from stable callbacks (click handler, basemap sync)
  // without adding them as effect deps that would force a map/layer rebuild.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  // ---- Mount / unmount: create the map exactly once ------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          [BASEMAP_SOURCE_ID]: {
            type: 'raster',
            tiles: basemap.tiles,
            tileSize: 256,
            maxzoom: basemap.maxZoom,
            attribution: basemap.attribution,
          },
        },
        layers: [
          {
            id: BASEMAP_LAYER_ID,
            type: 'raster',
            source: BASEMAP_SOURCE_ID,
          },
        ],
      },
      center: [center[1], center[0]],
      zoom,
      pitch: INITIAL_PITCH,
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: [basemap.attribution, ELEVATION_ATTRIBUTION],
      }),
      'bottom-right',
    );

    map.on('load', () => {
      map.addSource(TERRAIN_SOURCE_ID, {
        type: 'raster-dem',
        tiles: [terrainTileUrl],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: ELEVATION_ATTRIBUTION,
      });
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: DEFAULT_EXAGGERATION });
      map.addLayer({
        id: HILLSHADE_LAYER_ID,
        type: 'hillshade',
        source: TERRAIN_SOURCE_ID,
      });

      map.addSource(NODES_SOURCE_ID, {
        type: 'geojson',
        data: toNodesFeatureCollection(nodes),
      });
      map.addLayer({
        id: NODES_CIRCLE_LAYER_ID,
        type: 'circle',
        source: NODES_SOURCE_ID,
        paint: {
          'circle-radius': 6,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: NODES_LABEL_LAYER_ID,
        type: 'symbol',
        source: NODES_SOURCE_ID,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#f8fafc',
          'text-halo-color': '#0f172a',
          'text-halo-width': 1,
        },
      });

      map.on('click', NODES_CIRCLE_LAYER_ID, (e) => {
        const feature = e.features?.[0];
        const key = feature?.properties?.key;
        if (typeof key === 'string') {
          onNodeClickRef.current?.(key);
        }
      });
      map.on('mouseenter', NODES_CIRCLE_LAYER_ID, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', NODES_CIRCLE_LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
      });

      setLoaded(true);
    });

    return () => {
      setLoaded(false);
      map.remove();
      mapRef.current = null;
    };
    // Mount-once: center/zoom are applied only at construction (BaseMap
    // convention, see BaseMap.tsx), basemap/terrainTileUrl identity changes
    // are handled by the dedicated effects below rather than remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Basemap identity change: recreate the raster source in place --------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (map.getLayer(BASEMAP_LAYER_ID)) map.removeLayer(BASEMAP_LAYER_ID);
    if (map.getSource(BASEMAP_SOURCE_ID)) map.removeSource(BASEMAP_SOURCE_ID);
    map.addSource(BASEMAP_SOURCE_ID, {
      type: 'raster',
      tiles: basemap.tiles,
      tileSize: 256,
      maxzoom: basemap.maxZoom,
      attribution: basemap.attribution,
    });
    // Re-insert below the hillshade layer so terrain shading stays on top.
    map.addLayer(
      { id: BASEMAP_LAYER_ID, type: 'raster', source: BASEMAP_SOURCE_ID },
      map.getLayer(HILLSHADE_LAYER_ID) ? HILLSHADE_LAYER_ID : undefined,
    );
  }, [basemap, loaded]);

  // ---- Node data change: patch the GeoJSON source's data -------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource(NODES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(toNodesFeatureCollection(nodes));
  }, [nodes, loaded]);

  // ---- Exaggeration slider ---------------------------------------------------
  const handleExaggerationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      setExaggeration(value);
      const map = mapRef.current;
      if (map && loaded) {
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: value });
      }
    },
    [loaded],
  );

  return (
    <div className={`base-3d-map ${className ?? ''}`.trim()}>
      <div ref={containerRef} className="base-3d-map-canvas" data-testid="base-3d-map-canvas" />
      <div className="base-3d-map-exaggeration" data-testid="base-3d-map-exaggeration">
        <label htmlFor="base-3d-map-exaggeration-input">Terrain exaggeration</label>
        <input
          id="base-3d-map-exaggeration-input"
          type="range"
          min={EXAGGERATION_MIN}
          max={EXAGGERATION_MAX}
          step={EXAGGERATION_STEP}
          value={exaggeration}
          onChange={handleExaggerationChange}
        />
        <span>{exaggeration.toFixed(1)}x</span>
      </div>
    </div>
  );
}

export default Base3DMap;
