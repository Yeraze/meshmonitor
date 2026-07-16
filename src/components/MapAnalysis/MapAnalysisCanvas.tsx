import { useMemo } from 'react';
import { Pane } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useAnalysisNodes } from './useAnalysisNodes';
import MeasureDistanceController from '../MeasureDistanceController';
import type { MeasurePoint } from '../../utils/measureDistance';
import LinkProfileController from './LinkProfileController';
import LinkProfileDrawer from './LinkProfileDrawer';
import type { LinkEndpoint } from '../../utils/linkProfile';
import { BaseMap } from '../map/BaseMap';
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
    measureMode,
    setMeasureMode,
    linkProfileMode,
    setLinkProfileMode,
    linkEndpoints,
    setLinkEndpoints,
    linkVerdict,
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
  // candidate carries the radio identity (`sourceId`/`nodeNum`/`isMeshCore`)
  // that `useAutoRadioDefaults` needs to resolve a per-source frequency/RX
  // suggestion once picked.
  const linkEndpointCandidates: LinkEndpoint[] = useMemo(
    () =>
      analysisNodes.map((a) => ({
        id: a.key,
        lat: a.latLng[0],
        lng: a.latLng[1],
        label: a.node.shortName ?? undefined,
        isNode: true,
        sourceId: a.node.sourceId,
        nodeNum: a.node.nodeNum,
        isMeshCore: a.node.isMeshCore ?? false,
      })),
    [analysisNodes],
  );

  const center: [number, number] = [
    defaultMapCenterLat ?? FALLBACK_CENTER[0],
    defaultMapCenterLon ?? FALLBACK_CENTER[1],
  ];
  const zoom = defaultMapCenterZoom ?? FALLBACK_ZOOM;

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
      </BaseMap>
      <TimeSliderControl />
      <MapLegend />
      <FollowResumeButton />
      <LinkProfileDrawer />
    </div>
  );
}
