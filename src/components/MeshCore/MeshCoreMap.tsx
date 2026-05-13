import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { getTilesetById } from '../../config/tilesets';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';

const MESHCORE_COLOR = '#cba6f7';
const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 2;

interface MeshCoreMapProps {
  contacts: MeshCoreContact[];
  selectedPublicKey: string | null;
}

function makeIcon(name: string): L.DivIcon {
  return L.divIcon({
    className: 'meshcore-marker',
    html: `
      <div style="
        width: 24px;
        height: 24px;
        background: ${MESHCORE_COLOR};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #1e1e2e;
        font-size: 10px;
        font-weight: bold;
      ">MC</div>
      <div style="
        position: absolute;
        top: -20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${MESHCORE_COLOR}e6;
        color: #1e1e2e;
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        white-space: nowrap;
      ">${name}</div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export const MeshCoreMap: React.FC<MeshCoreMapProps> = ({ contacts, selectedPublicKey }) => {
  const { mapTileset, customTilesets } = useSettings();
  const tileset = getTilesetById(mapTileset, customTilesets);

  const positioned = useMemo(
    () => contacts.filter(c =>
      typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude)),
    [contacts],
  );

  const { center, zoom } = useMemo(() => {
    if (selectedPublicKey) {
      const sel = positioned.find(c => c.publicKey === selectedPublicKey);
      if (sel) return { center: [sel.latitude!, sel.longitude!] as [number, number], zoom: 12 };
    }
    if (positioned.length > 0) {
      const c = positioned[0];
      return { center: [c.latitude!, c.longitude!] as [number, number], zoom: 10 };
    }
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }, [positioned, selectedPublicKey]);

  return (
    <div className="meshcore-map-pane">
      <MapContainer
        key={`${center[0]}-${center[1]}-${zoom}`}
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution={tileset.attribution}
          url={tileset.url}
          maxZoom={tileset.maxZoom}
        />
        {positioned.map(c => {
          const name = c.advName || c.name || 'MeshCore';
          return (
            <Marker
              key={c.publicKey}
              position={[c.latitude!, c.longitude!]}
              icon={makeIcon(name)}
            >
              <Tooltip>
                <strong>{name}</strong>
                {typeof c.rssi === 'number' && <><br />RSSI: {c.rssi} dBm</>}
                {typeof c.snr === 'number' && <><br />SNR: {c.snr} dB</>}
              </Tooltip>
              <Popup>
                <div style={{ minWidth: 200 }}>
                  <strong>{name}</strong>
                  <br />
                  <small>MeshCore Device</small>
                  <br />
                  Key: {c.publicKey.substring(0, 16)}…
                  {typeof c.rssi === 'number' && <><br />RSSI: {c.rssi} dBm</>}
                  {typeof c.snr === 'number' && <><br />SNR: {c.snr} dB</>}
                  {c.lastSeen && <><br />Last seen: {new Date(c.lastSeen).toLocaleString()}</>}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
};
