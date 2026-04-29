import { MapContainer, TileLayer, Pane } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import NodeMarkersLayer from './layers/NodeMarkersLayer';
import TraceroutePathsLayer from './layers/TraceroutePathsLayer';

const FALLBACK_CENTER: [number, number] = [30, -90];
const FALLBACK_ZOOM = 10;

export default function MapAnalysisCanvas() {
  const { defaultMapCenterLat, defaultMapCenterLon, defaultMapCenterZoom } = useSettings();
  const { config } = useMapAnalysisCtx();

  const center: [number, number] = [
    defaultMapCenterLat ?? FALLBACK_CENTER[0],
    defaultMapCenterLon ?? FALLBACK_CENTER[1],
  ];
  const zoom = defaultMapCenterZoom ?? FALLBACK_ZOOM;

  return (
    <div className="map-analysis-canvas">
      <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap"
        />
        <Pane name="markers" style={{ zIndex: 600 }}>
          {config.layers.markers.enabled && <NodeMarkersLayer />}
        </Pane>
        <Pane name="paths" style={{ zIndex: 500 }}>
          {config.layers.traceroutes.enabled && <TraceroutePathsLayer />}
        </Pane>
      </MapContainer>
    </div>
  );
}
