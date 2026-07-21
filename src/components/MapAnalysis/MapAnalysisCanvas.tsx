import { useCallback, useEffect, useMemo } from 'react';
import { Pane } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useAnalysisNodes } from './useAnalysisNodes';
import MeasureDistanceController from '../MeasureDistanceController';
import type { MeasurePoint } from '../../utils/measureDistance';
import LinkProfileController from './LinkProfileController';
import LinkProfileDrawer from './LinkProfileDrawer';
import LinkProfileHoverLayer from './LinkProfileHoverLayer';
import type { LinkEndpoint } from '../../utils/linkProfile';
import { BaseMap } from '../map/BaseMap';
import { Base3DMap, type Node3DFeature, type Line3DFeature } from '../map/Base3DMap';
import { resolve3DBasemap, buildTerrainTileUrl } from '../../config/basemap3d';
import { useTerrainCapabilities } from '../../hooks/useTerrainCapabilities';
import { appBasename } from '../../init';
import { resolveNodeAltitude } from './nodePositionUtil';
import { use3DNeighborLines } from './use3DNeighborLines';
import { use3DTracerouteLines } from './use3DTracerouteLines';
import type { SelectedTarget } from './MapAnalysisContext';
import NodeMarkersLayer from './layers/NodeMarkersLayer';
import TraceroutePathsLayer from './layers/TraceroutePathsLayer';
import NeighborLinksLayer from './layers/NeighborLinksLayer';
import MeshCoreNeighborLinksLayer from './layers/MeshCoreNeighborLinksLayer';
import PositionTrailsLayer from './layers/PositionTrailsLayer';
import CoverageHeatmapLayer from './layers/CoverageHeatmapLayer';
import SnrOverlayLayer from './layers/SnrOverlayLayer';
import WaypointsLayer from '../map/layers/WaypointsLayer';
import PolarGridLayer from './layers/PolarGridLayer';
import AccuracyRegionsLayer from './layers/AccuracyRegionsLayer';
import TimeSliderControl from './TimeSliderControl';
import MapLegend from './MapLegend';
import FollowController from './FollowController';
import FollowResumeButton from './FollowResumeButton';

const FALLBACK_CENTER: [number, number] = [30, -90];
const FALLBACK_ZOOM = 10;

export default function MapAnalysisCanvas() {
  const {
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapTileset,
    customTilesets,
    setMapTileset,
  } = useSettings();
  const {
    config,
    setViewMode,
    setSelected,
    measureMode,
    setMeasureMode,
    linkProfileMode,
    setLinkProfileMode,
    linkEndpoints,
    setLinkEndpoints,
    linkVerdict,
    setExaggeration,
  } = useMapAnalysisCtx();

  // #3636: measurement endpoints, from the same visible+positioned node list
  // the markers layer uses so the two never disagree.
  const analysisNodes = useAnalysisNodes();
  const measurePoints: MeasurePoint[] = useMemo(
    () => analysisNodes.map((a) => ({
      id: a.key,
      lat: a.latLng[0],
      lng: a.latLng[1],
      label: a.node.shortName ?? undefined,
    })),
    [analysisNodes],
  );

  // #4111 Phase 2 (WP-D) / Phase 3 (WP-2): Link Profile picker candidates —
  // built directly from `analysisNodes` (not `measurePoints`) so each
  // candidate carries the radio identity (`sourceId`/`sourceIds`/`nodeNum`/
  // `isMeshCore`) that `useAutoRadioDefaults` needs to resolve a per-source
  // frequency/RX suggestion once picked. `sourceIds` carries the FULL
  // membership list (`node.sources`) — a unified-merged node's bare
  // `sourceId` is just whichever source most recently reported it, which is
  // frequently a radio-less MQTT bridge for a multi-source node (#4111 P3
  // WP-2 follow-up).
  const linkEndpointCandidates: LinkEndpoint[] = useMemo(
    () =>
      analysisNodes.map((a) => ({
        id: a.key,
        lat: a.latLng[0],
        lng: a.latLng[1],
        label: a.node.shortName ?? undefined,
        isNode: true,
        sourceId: a.node.sourceId,
        sourceIds: a.node.sources?.map((s) => s.sourceId) ?? (a.node.sourceId ? [a.node.sourceId] : []),
        nodeNum: a.node.nodeNum,
        isMeshCore: a.node.isMeshCore ?? false,
        altitudeM: resolveNodeAltitude(a.node) ?? undefined,
      })),
    [analysisNodes],
  );

  const center: [number, number] = [
    defaultMapCenterLat ?? FALLBACK_CENTER[0],
    defaultMapCenterLon ?? FALLBACK_CENTER[1],
  ];
  const zoom = defaultMapCenterZoom ?? FALLBACK_ZOOM;

  // #3826 Phase 2 WP-D: 3D branch (spec §3.10) + force-2D guard (spec §3.11).
  // A persisted `viewMode:'3d'` must never strand the user once capabilities
  // resolve unavailable (elevation disabled, or a JSON elevation source with
  // no DEM tiles): once the capabilities fetch settles unavailable, correct
  // the *persisted* config back to `'2d'` (effect) and use a
  // still-loading-safe `effectiveViewMode` for *this* render so a
  // legitimately-available 3D view doesn't flash to 2D while the
  // capabilities fetch is still in flight.
  const terrainCaps = useTerrainCapabilities();
  const capsUnavailable = !terrainCaps.isLoading && !(terrainCaps.enabled && terrainCaps.terrainTiles);
  const forced2d = config.viewMode === '3d' && capsUnavailable;
  useEffect(() => {
    if (forced2d) setViewMode('2d');
  }, [forced2d, setViewMode]);
  const effectiveViewMode = forced2d ? '2d' : config.viewMode;

  // Same shared `useAnalysisNodes()` data the 2D markers layer/picker use
  // (see `analysisNodes` above), mapped to the shape `Base3DMap` expects.
  const node3DFeatures: Node3DFeature[] = useMemo(
    () => analysisNodes.map((a) => ({
      key: a.key,
      lat: a.latLng[0],
      lng: a.latLng[1],
      label: a.node.shortName ?? undefined,
    })),
    [analysisNodes],
  );
  const basemap3D = useMemo(
    () => resolve3DBasemap(mapTileset, customTilesets),
    [mapTileset, customTilesets],
  );
  // `appBasename` is the same base-path prefix `ApiService` was seeded with
  // at startup (`src/init.ts`) — module-scope constant, never changes.
  const terrainTileUrl = useMemo(() => buildTerrainTileUrl(appBasename), []);
  const handleNode3DClick = useCallback(
    (key: string) => {
      const match = analysisNodes.find((a) => a.key === key);
      if (!match) return;
      setSelected({ type: 'node', nodeNum: Number(match.node.nodeNum), sourceId: match.node.sourceId });
    },
    [analysisNodes, setSelected],
  );

  // #3826 Phase 3 WP-3 (spec §3.4): neighbor + traceroute lines in 3D. Called
  // unconditionally (Rules of Hooks) — both hooks self-gate on their layer
  // toggle/time-window and return empties when off, matching the 2D panes'
  // `config.layers.*.enabled` guards above.
  const neighborLines3D = use3DNeighborLines();
  const tracerouteLines3D = use3DTracerouteLines();
  const lines3D: Line3DFeature[] = useMemo(
    () => [...neighborLines3D.lines, ...tracerouteLines3D.lines],
    [neighborLines3D.lines, tracerouteLines3D.lines],
  );
  const line3DSelectionByKey = useMemo(
    () => new Map<string, SelectedTarget>([
      ...neighborLines3D.selectionByKey,
      ...tracerouteLines3D.selectionByKey,
    ]),
    [neighborLines3D.selectionByKey, tracerouteLines3D.selectionByKey],
  );
  const handleLine3DClick = useCallback(
    (key: string) => {
      const target = line3DSelectionByKey.get(key);
      if (target) setSelected(target);
    },
    [line3DSelectionByKey, setSelected],
  );

  // WebGL unavailable on this machine (probe failed or map construction
  // threw): Base3DMap renders its own fallback message, but we also route
  // the user back to the working 2D map so they aren't stranded in 3D mode.
  const handle3DUnsupported = useCallback(() => setViewMode('2d'), [setViewMode]);

  if (effectiveViewMode === '3d') {
    return (
      <div className="map-analysis-canvas" style={{ position: 'relative' }}>
        <Base3DMap
          center={center}
          zoom={zoom}
          basemap={basemap3D}
          terrainTileUrl={terrainTileUrl}
          nodes={node3DFeatures}
          onNodeClick={handleNode3DClick}
          lines={lines3D}
          onLineClick={handleLine3DClick}
          onUnsupported={handle3DUnsupported}
          initialExaggeration={config.exaggeration}
          onExaggerationChange={setExaggeration}
        />
        {basemap3D.usedFallback && (
          <div className="map-analysis-3d-fallback-note">
            Showing default basemap in 3D — the selected map style is vector-only
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="map-analysis-canvas" style={{ position: 'relative' }}>
      <BaseMap
        center={center}
        zoom={zoom}
        tilesetId={mapTileset}
        customTilesets={customTilesets}
        showTilesetSelector
        onTilesetChange={setMapTileset}
      >
        <FollowController />
        {measureMode && (
          <MeasureDistanceController
            active={measureMode}
            points={measurePoints}
            onExit={() => setMeasureMode(false)}
          />
        )}
        {linkProfileMode && (
          <LinkProfileController
            active={linkProfileMode}
            points={linkEndpointCandidates}
            endpoints={linkEndpoints}
            onPick={setLinkEndpoints}
            onExit={() => setLinkProfileMode(false)}
            verdict={linkVerdict}
          />
        )}
        <Pane name="waypoints" style={{ zIndex: 650 }}>
          {config.layers.waypoints.enabled && <WaypointsLayer />}
        </Pane>
        {/* #4016: obscured-position accuracy squares, beneath the markers so the
            offset marker reads as sitting inside its uncertainty cell. */}
        <Pane name="accuracyRegions" style={{ zIndex: 580 }}>
          {config.layers.accuracyRegions.enabled && <AccuracyRegionsLayer />}
        </Pane>
        <Pane name="markers" style={{ zIndex: 600 }}>
          {config.layers.markers.enabled && <NodeMarkersLayer />}
        </Pane>
        <Pane name="paths" style={{ zIndex: 500 }}>
          {config.layers.traceroutes.enabled && <TraceroutePathsLayer />}
        </Pane>
        <Pane name="neighbors" style={{ zIndex: 450 }}>
          {config.layers.neighbors.enabled && <NeighborLinksLayer />}
          {config.layers.neighbors.enabled && <MeshCoreNeighborLinksLayer />}
        </Pane>
        <Pane name="snrOverlay" style={{ zIndex: 420 }}>
          {config.layers.snrOverlay.enabled && <SnrOverlayLayer />}
        </Pane>
        <Pane name="trails" style={{ zIndex: 400 }}>
          {config.layers.trails.enabled && <PositionTrailsLayer />}
        </Pane>
        <Pane name="heatmap" style={{ zIndex: 350 }}>
          {config.layers.heatmap.enabled && <CoverageHeatmapLayer />}
        </Pane>
        {/* Polar grid sits just below the node markers (z600) so its labels don't
            paint over them, but above the data layers so the range rings read. */}
        <Pane name="polarGrid" style={{ zIndex: 550 }}>
          {config.layers.polarGrid.enabled && <PolarGridLayer />}
        </Pane>
        {/* Link Profile graph-hover marker — highest z so the cursor point reads
            above every data layer. Renders only while hovering the graph. */}
        <Pane name="linkProfileHover" style={{ zIndex: 700 }}>
          <LinkProfileHoverLayer />
        </Pane>
      </BaseMap>
      <TimeSliderControl />
      <MapLegend />
      <FollowResumeButton />
      <LinkProfileDrawer />
    </div>
  );
}
