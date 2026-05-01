import { MapContainer, TileLayer, Pane } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { getTilesetById } from '../../config/tilesets';
import { TilesetSelector } from '../TilesetSelector';
import NodeMarkersLayer from './layers/NodeMarkersLayer';
import TraceroutePathsLayer from './layers/TraceroutePathsLayer';
import NeighborLinksLayer from './layers/NeighborLinksLayer';
import PositionTrailsLayer from './layers/PositionTrailsLayer';
import CoverageHeatmapLayer from './layers/CoverageHeatmapLayer';
import SnrOverlayLayer from './layers/SnrOverlayLayer';
import TimeSliderControl from './TimeSliderControl';
import MapLegend from './MapLegend';

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
  const { config } = useMapAnalysisCtx();

  const center: [number, number] = [
    defaultMapCenterLat ?? FALLBACK_CENTER[0],
    defaultMapCenterLon ?? FALLBACK_CENTER[1],
  ];
  const zoom = defaultMapCenterZoom ?? FALLBACK_ZOOM;

  const tileset = getTilesetById(mapTileset, customTilesets);

  return (
    <div className="map-analysis-canvas" style={{ position: 'relative' }}>
      <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url={tileset.url}
          attribution={tileset.attribution}
          maxZoom={tileset.maxZoom}
        />
        <Pane name="markers" style={{ zIndex: 600 }}>
          {config.layers.markers.enabled && <NodeMarkersLayer />}
        </Pane>
        <Pane name="paths" style={{ zIndex: 500 }}>
          {config.layers.traceroutes.enabled && <TraceroutePathsLayer />}
        </Pane>
        <Pane name="neighbors" style={{ zIndex: 450 }}>
          {config.layers.neighbors.enabled && <NeighborLinksLayer />}
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
      </MapContainer>
      <TilesetSelector selectedTilesetId={mapTileset} onTilesetChange={setMapTileset} />
      <TimeSliderControl />
      <MapLegend />
    </div>
  );
}
