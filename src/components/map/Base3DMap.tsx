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

/**
 * A single line feature fed into the MapLibre `lines` GeoJSON source
 * (#3826 Phase 3 WP-1, spec §2.1). Kept generic (no MapAnalysis types) so
 * `Base3DMap` stays Map-Analysis-agnostic; callers resolve `key` back to a
 * domain object via `onLineClick`.
 */
export interface Line3DFeature {
  key: string;
  /** [lat, lng] (converted to MapLibre's [lng, lat] internally). */
  from: [number, number];
  /** [lat, lng] (converted to MapLibre's [lng, lat] internally). */
  to: [number, number];
  color: string;
  opacity: number;
  width: number;
  /** Dash pattern in line-widths; omit/empty = solid. */
  dash?: number[];
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
  /** Line segments (neighbor links, traceroute paths, …) to render below the node layers. */
  lines?: Line3DFeature[];
  /** Fired when a line is clicked, with its `key`. */
  onLineClick?: (key: string) => void;
  /**
   * Fired at most once per component instance when WebGL is unavailable and
   * the 3D map cannot be constructed (probe failed or the maplibre Map
   * constructor threw). Callers should switch the user back to a working 2D
   * view; the component itself renders a non-crashing fallback message
   * either way.
   */
  onUnsupported?: () => void;
  /**
   * Seed value for the terrain-exaggeration slider (default `1.3`, same as
   * `DEFAULT_EXAGGERATION`). Seed-once: the slider is the only way
   * exaggeration changes after mount, so this is not re-applied on prop
   * changes after the initial mount.
   */
  initialExaggeration?: number;
  /** Fired with the new exaggeration value whenever the slider changes. */
  onExaggerationChange?: (value: number) => void;
  className?: string;
}

const BASEMAP_SOURCE_ID = 'basemap-raster';
const BASEMAP_LAYER_ID = 'basemap-raster-layer';
const TERRAIN_SOURCE_ID = 'terrain-dem';
const HILLSHADE_LAYER_ID = 'terrain-hillshade';
const NODES_SOURCE_ID = 'nodes';
const NODES_CIRCLE_LAYER_ID = 'nodes-circle';
const NODES_LABEL_LAYER_ID = 'nodes-label';
const LINES_SOURCE_ID = 'lines';
const LINES_LAYER_PREFIX = 'lines-';

const ELEVATION_ATTRIBUTION = 'Elevation: Mapzen / AWS Terrain Tiles';
const INITIAL_PITCH = 60;
const DEFAULT_EXAGGERATION = 1.3;
const EXAGGERATION_MIN = 0;
const EXAGGERATION_MAX = 2;
const EXAGGERATION_STEP = 0.1;

/**
 * Cheap WebGL availability probe. A passing probe does NOT guarantee the
 * real map context succeeds (driver blocklists, exhausted contexts), so the
 * `new maplibregl.Map` call is additionally try/caught — belt and braces.
 */
function isWebGlAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

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

/** Build a GeoJSON FeatureCollection from the `lines` prop for the `lines` source. */
function toLinesFeatureCollection(lines: Line3DFeature[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: lines.map((l) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [l.from[1], l.from[0]],
          [l.to[1], l.to[0]],
        ],
      },
      properties: {
        key: l.key,
        color: l.color,
        opacity: l.opacity,
        width: l.width,
        dashKey: JSON.stringify(l.dash ?? []),
      },
    })),
  };
}

/**
 * Distinct dash patterns present in `lines`, keyed by `JSON.stringify(dash ?? [])`
 * (spec §2.1 — `line-dasharray` is not data-drivable, so each distinct pattern
 * gets its own MapLibre line layer sharing the one `lines` GeoJSON source).
 */
function dashGroupsOf(lines: Line3DFeature[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const line of lines) {
    const dash = line.dash ?? [];
    const dashKey = JSON.stringify(dash);
    if (!groups.has(dashKey)) groups.set(dashKey, dash);
  }
  return groups;
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
  lines = [],
  onLineClick,
  onUnsupported,
  initialExaggeration,
  onExaggerationChange,
  className,
}: Base3DMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  // Seed-once from initialExaggeration (spec §2.4): exaggeration only ever
  // changes via the slider below, so no prop-driven re-sync after mount.
  const [exaggeration, setExaggeration] = useState(() => initialExaggeration ?? DEFAULT_EXAGGERATION);

  // Latest props, readable from stable callbacks (click handler, basemap sync)
  // without adding them as effect deps that would force a map/layer rebuild.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const onLineClickRef = useRef(onLineClick);
  onLineClickRef.current = onLineClick;
  const onExaggerationChangeRef = useRef(onExaggerationChange);
  onExaggerationChangeRef.current = onExaggerationChange;
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;
  // Notify-once guard: refs survive StrictMode's dev double-mount (the same
  // component instance is remounted with state/refs preserved), so
  // `onUnsupported` fires exactly once even when the mount effect runs twice.
  const unsupportedNotifiedRef = useRef(false);
  // Live dash-group -> line-layer-id map, reconciled as `lines` changes
  // (spec §3.1 — the set of distinct dash patterns isn't known ahead of time).
  const lineLayerIdsRef = useRef<Map<string, string>>(new Map());
  const nextLineLayerIndexRef = useRef(0);

  // Adds one MapLibre `line` layer for a dash group, filtered to its
  // features via `dashKey`, inserted below the node circle/label layers so
  // markers stay clickable on top. Stable identity (empty deps, refs only)
  // so it can be an effect dep without forcing extra reconciliation runs.
  const addLineLayer = useCallback((map: maplibregl.Map, dashKey: string, dash: number[], layerId: string) => {
    map.addLayer(
      {
        id: layerId,
        type: 'line',
        source: LINES_SOURCE_ID,
        filter: ['==', ['get', 'dashKey'], dashKey],
        paint: {
          'line-color': ['get', 'color'],
          'line-opacity': ['get', 'opacity'],
          'line-width': ['get', 'width'],
          ...(dash.length ? { 'line-dasharray': dash } : {}),
        },
      },
      NODES_CIRCLE_LAYER_ID,
    );
    map.on('click', layerId, (e) => {
      const feature = e.features?.[0];
      const key = feature?.properties?.key;
      if (typeof key === 'string') {
        onLineClickRef.current?.(key);
      }
    });
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  }, []);

  // ---- Mount / unmount: create the map exactly once ------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const markUnsupported = () => {
      setWebglUnavailable(true);
      if (!unsupportedNotifiedRef.current) {
        unsupportedNotifiedRef.current = true;
        onUnsupportedRef.current?.();
      }
    };

    if (!isWebGlAvailable()) {
      markUnsupported();
      return;
    }

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
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
    } catch (err) {
      // Real case: the probe can pass while the actual context creation still
      // fails ("Failed to initialize WebGL") — degrade instead of crashing.
      console.warn('Base3DMap: WebGL map construction failed', err);
      markUnsupported();
      return;
    }
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
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
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

      // Lines source + one line layer per distinct dash pattern (spec §2.1/§3.1),
      // inserted below the node circle/label layers so markers stay clickable
      // on top. Zero dash groups when `lines` is omitted/empty ⇒ no line
      // layers added, matching pre-Phase-3 behavior.
      map.addSource(LINES_SOURCE_ID, {
        type: 'geojson',
        data: toLinesFeatureCollection(lines),
      });
      for (const [dashKey, dash] of dashGroupsOf(lines)) {
        const layerId = `${LINES_LAYER_PREFIX}${nextLineLayerIndexRef.current++}`;
        lineLayerIdsRef.current.set(dashKey, layerId);
        addLineLayer(map, dashKey, dash, layerId);
      }

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
    // `nodes`/`lines` here only seed the initial sources — subsequent
    // updates are patched by the dedicated sync effects below.
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

  // ---- Line data change: patch the source + reconcile dash-group layers ----
  // The set of distinct dash patterns can grow/shrink as `lines` changes, so
  // this diffs against `lineLayerIdsRef` rather than assuming a fixed layer
  // set (spec §3.1).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource(LINES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(toLinesFeatureCollection(lines));

    const currentGroups = dashGroupsOf(lines);
    const liveLayerIds = lineLayerIdsRef.current;

    for (const [dashKey, dash] of currentGroups) {
      if (!liveLayerIds.has(dashKey)) {
        const layerId = `${LINES_LAYER_PREFIX}${nextLineLayerIndexRef.current++}`;
        liveLayerIds.set(dashKey, layerId);
        addLineLayer(map, dashKey, dash, layerId);
      }
    }

    for (const [dashKey, layerId] of Array.from(liveLayerIds)) {
      if (!currentGroups.has(dashKey)) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        liveLayerIds.delete(dashKey);
      }
    }
  }, [lines, loaded, addLineLayer]);

  // ---- Exaggeration slider ---------------------------------------------------
  const handleExaggerationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      setExaggeration(value);
      const map = mapRef.current;
      if (map && loaded) {
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: value });
      }
      onExaggerationChangeRef.current?.(value);
    },
    [loaded],
  );

  return (
    <div className={`base-3d-map ${className ?? ''}`.trim()}>
      <div ref={containerRef} className="base-3d-map-canvas" data-testid="base-3d-map-canvas" />
      {webglUnavailable ? (
        <div className="base-3d-map-unsupported" data-testid="base-3d-map-unsupported" role="alert">
          3D view requires WebGL, which is not available in this browser
        </div>
      ) : (
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
      )}
    </div>
  );
}

export default Base3DMap;
