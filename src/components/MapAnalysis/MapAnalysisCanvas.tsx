import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pane } from 'react-leaflet';
import type * as maplibregl from 'maplibre-gl';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useSource } from '../../contexts/SourceContext';
import { useAnalysisNodes } from './useAnalysisNodes';
import MeasureDistanceController from '../MeasureDistanceController';
import type { MeasurePoint } from '../../utils/measureDistance';
import LinkProfileController from './LinkProfileController';
import LinkProfileDrawer from './LinkProfileDrawer';
import SitePlannerOriginController from './SitePlannerOriginController';
import SitePlannerPanel from './SitePlannerPanel';
import GnssDopPanel from './GnssDopPanel';
import PredictedCoverageLayer from '../map/layers/PredictedCoverageLayer';
import GnssDopLayer from '../map/layers/GnssDopLayer';
import LinkProfileHoverLayer from './LinkProfileHoverLayer';
import type { LinkEndpoint } from '../../utils/linkProfile';
import { BaseMap } from '../map/BaseMap';
import { Base3DMap, type Node3DFeature, type Line3DFeature, type Map3DViewState } from '../map/Base3DMap';
import { TilesetSelector } from '../TilesetSelector';
import { resolve3DBasemap, buildTerrainTileUrl } from '../../config/basemap3d';
import { useEffectiveViewMode } from './useEffectiveViewMode';
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
import AtakContactsLayer from '../map/layers/AtakContactsLayer';
import PolarGridLayer from './layers/PolarGridLayer';
import AccuracyRegionsLayer from './layers/AccuracyRegionsLayer';
import TimeSliderControl from './TimeSliderControl';
import MapLegend from './MapLegend';
import FollowController from './FollowController';
import Follow3DController from './Follow3DController';
import FollowResumeButton from './FollowResumeButton';
import MapViewStateController from './MapViewStateController';

const FALLBACK_CENTER: [number, number] = [30, -90];
const FALLBACK_ZOOM = 10;

/** Stable empty list so toggling the markers layer off doesn't churn Base3DMap's source. */
const NO_3D_NODES: Node3DFeature[] = [];

export default function MapAnalysisCanvas() {
  const {
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapTileset,
    customTilesets,
    setMapTileset,
    activeStyleJson,
  } = useSettings();
  const {
    config,
    setViewMode,
    selected,
    setSelected,
    nodeFilter,
    measureMode,
    setMeasureMode,
    linkProfileMode,
    sitePlannerMode,
    setSitePlannerMode,
    sitePlannerOrigin,
    setSitePlannerOrigin,
    predictedCoverage,
    setPredictedCoverage,
    gnssDopMode,
    setGnssDopMode,
    gnssDopParams,
    setGnssDopParams,
    gnssDopMeta,
    setGnssDopMeta,
    setLinkProfileMode,
    linkEndpoints,
    setLinkEndpoints,
    linkVerdict,
    setExaggeration,
    mapViewRef,
  } = useMapAnalysisCtx();
  // Seeds the Site Planner's radio parameters (#4727). Null outside a
  // SourceProvider, which the panel handles by falling back to assumed values
  // rather than inventing a config.
  const { sourceId: activeSourceId } = useSource();

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

  // #4371 A: mount the incoming branch at the view the outgoing one was
  // showing, so switching 2D↔3D doesn't snap back to the Default Map Center
  // (or, with none configured, to the [30, -90] fallback). `mapViewRef` is
  // written on every `moveend` by whichever map is mounted, and is null until
  // one has reported — reading it during render is deliberate: both BaseMap
  // and Base3DMap consume center/zoom at mount only, so this is a seed, not
  // reactive state.
  const liveView = mapViewRef.current;
  const center: [number, number] = liveView?.center ?? [
    defaultMapCenterLat ?? FALLBACK_CENTER[0],
    defaultMapCenterLon ?? FALLBACK_CENTER[1],
  ];
  const zoom = liveView?.zoom ?? defaultMapCenterZoom ?? FALLBACK_ZOOM;

  // #3826 Phase 2 WP-D: 3D branch (spec §3.10) + force-2D guard (spec §3.11).
  // The derivation lives in `useEffectiveViewMode` so the toolbar's layer
  // gating describes the same surface this branch renders (#4371); the
  // correcting write-back to the persisted config stays here, in the one
  // component that owns the branch.
  const { effectiveViewMode, forced2d } = useEffectiveViewMode();
  useEffect(() => {
    if (forced2d) setViewMode('2d');
  }, [forced2d, setViewMode]);

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
  const neighborLines3D = use3DNeighborLines({
    layer: config.layers.neighbors,
    sources: config.sources,
    timeSlider: config.timeSlider,
  });
  const tracerouteLines3D = use3DTracerouteLines({
    layer: config.layers.traceroutes,
    sources: config.sources,
    timeSlider: config.timeSlider,
    selected,
    nodeFilter,
  });
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

  // #4371 A: record the 3D camera so the 2D map can pick it up on switch back.
  const handle3DViewChange = useCallback(
    (view: Map3DViewState) => {
      mapViewRef.current = view;
    },
    [mapViewRef],
  );

  // #4371 B: MapLibre has no `useMap()` child context, so the map instance is
  // held in state and handed to Follow3DController once Base3DMap reports it.
  const [map3D, setMap3D] = useState<maplibregl.Map | null>(null);

  if (effectiveViewMode === '3d') {
    return (
      <div className="map-analysis-canvas" style={{ position: 'relative' }}>
        <Base3DMap
          center={center}
          zoom={zoom}
          pitch={liveView?.pitch}
          bearing={liveView?.bearing}
          basemap={basemap3D}
          terrainTileUrl={terrainTileUrl}
          nodes={config.layers.markers.enabled ? node3DFeatures : NO_3D_NODES}
          onNodeClick={handleNode3DClick}
          lines={lines3D}
          onLineClick={handleLine3DClick}
          onUnsupported={handle3DUnsupported}
          initialExaggeration={config.exaggeration}
          onExaggerationChange={setExaggeration}
          onViewChange={handle3DViewChange}
          onMapReady={setMap3D}
        />
        {/* #4371 C: basemap switching in 3D. The same controlled selector the
            2D branch gets via BaseMap's `showTilesetSelector` — Base3DMap
            takes an already-resolved `basemap`, so it's mounted here as a
            sibling rather than behind a prop. `basemap3D` recomputes from
            `mapTileset` and Base3DMap swaps its raster source in place. */}
        <TilesetSelector selectedTilesetId={mapTileset} onTilesetChange={setMapTileset} />
        <Follow3DController map={map3D} />
        <FollowResumeButton />
        {/* `TimeSliderControl` and `MapLegend` are intentionally 2D-only, and
            stay that way here: both are documented non-goals of the #3826 3D
            epic (the persisted time-slider WINDOW is still honored by the 3D
            data hooks, so 2D↔3D never changes which links show — you just
            can't drag the handles from the 3D canvas). Their absence is
            asserted in MapAnalysisCanvas.test.tsx so an accidental add is
            caught rather than silently shipping a half-wired control. */}
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
        styleJson={activeStyleJson ?? undefined}
        showTilesetSelector
        onTilesetChange={setMapTileset}
      >
        <MapViewStateController />
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
        {/* Site Planner (#4727). The predicted-coverage polygon sits BELOW the
            node markers so a prediction never hides the real data it is
            reasoning about. */}
        {sitePlannerMode && (
          <SitePlannerOriginController
            active={sitePlannerMode}
            points={linkEndpointCandidates}
            origin={sitePlannerOrigin}
            onPick={setSitePlannerOrigin}
            onExit={() => setSitePlannerMode(false)}
          />
        )}
        <Pane name="predictedCoverage" style={{ zIndex: 420 }}>
          <PredictedCoverageLayer coverage={predictedCoverage} visible={sitePlannerMode} />
        </Pane>
        {/* GNSS DOP heatmap (#4729). Sits low so the basemap and node markers
            stay readable over it; it fetches server-side only, so it adds no
            mesh traffic. */}
        <Pane name="gnssDop" style={{ zIndex: 340 }}>
          <GnssDopLayer visible={gnssDopMode} params={gnssDopParams} onMeta={setGnssDopMeta} />
        </Pane>
        <Pane name="waypoints" style={{ zIndex: 650 }}>
          {config.layers.waypoints.enabled && <WaypointsLayer />}
        </Pane>
        <Pane name="atakContacts" style={{ zIndex: 640 }}>
          {config.layers.atakContacts.enabled && <AtakContactsLayer />}
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
      <SitePlannerPanel
        open={sitePlannerMode}
        sourceId={activeSourceId}
        origin={sitePlannerOrigin}
        onClose={() => setSitePlannerMode(false)}
        onCoverage={setPredictedCoverage}
      />
      <GnssDopPanel
        open={gnssDopMode}
        params={gnssDopParams}
        meta={gnssDopMeta}
        onChange={setGnssDopParams}
        onClose={() => setGnssDopMode(false)}
      />
    </div>
  );
}
