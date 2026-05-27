import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useSource } from '../../contexts/SourceContext';
import { getTilesetById } from '../../config/tilesets';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import api from '../../services/api';

const MESHCORE_COLOR = '#cba6f7';
const NEIGHBOR_COLOR = '#06b6d4';
const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 2;

const PATH_COLORS: Record<string, string> = {
  direct: '#a6e3a1',
  short: '#89b4fa',
  long: '#fab387',
  unknown: '#6c7086',
};

function hopCountColor(hops: number | null | undefined): string {
  if (hops === null || hops === undefined) return PATH_COLORS.unknown;
  if (hops === 0) return PATH_COLORS.direct;
  if (hops <= 2) return PATH_COLORS.short;
  return PATH_COLORS.long;
}

function hopCountLabel(hops: number | null | undefined): string {
  if (hops === null || hops === undefined) return 'Unknown';
  if (hops === 0) return 'Direct';
  return `${hops} hop${hops > 1 ? 's' : ''}`;
}

interface NeighborEdge {
  publicKey: string;
  neighborPublicKey: string;
  nodeName: string | null;
  neighborName: string | null;
  snr: number | null;
}

interface MeshCoreMapProps {
  contacts: MeshCoreContact[];
  selectedPublicKey: string | null;
  localNodePosition?: { lat: number; lng: number } | null;
  onNavigateToDm?: (publicKey: string) => void;
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

export const MeshCoreMap: React.FC<MeshCoreMapProps> = ({ contacts, selectedPublicKey, localNodePosition, onNavigateToDm }) => {
  const { mapTileset, customTilesets } = useSettings();
  const { sourceId } = useSource();
  const tileset = getTilesetById(mapTileset, customTilesets);
  const [showPaths, setShowPaths] = useState(true);
  const [showNeighbors, setShowNeighbors] = useState(true);
  const [neighborEdges, setNeighborEdges] = useState<NeighborEdge[]>([]);

  const positioned = useMemo(
    () => contacts.filter(c =>
      typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude)),
    [contacts],
  );

  const localPos = useMemo((): [number, number] | null => {
    if (localNodePosition?.lat != null && localNodePosition?.lng != null) {
      return [localNodePosition.lat, localNodePosition.lng];
    }
    const local = positioned.find(c => c.advName?.includes('(local)'));
    if (local) return [local.latitude!, local.longitude!];
    return null;
  }, [localNodePosition, positioned]);

  const pathSegments = useMemo(() => {
    if (!showPaths || !localPos) return [];
    return positioned
      .filter(c => !c.advName?.includes('(local)') && typeof c.pathLen === 'number')
      .map(c => ({
        key: c.publicKey,
        from: localPos,
        to: [c.latitude!, c.longitude!] as [number, number],
        color: hopCountColor(c.pathLen),
        label: `${c.advName || c.name || c.publicKey.substring(0, 8)}: ${hopCountLabel(c.pathLen)}`,
        hops: c.pathLen ?? -1,
      }));
  }, [showPaths, localPos, positioned]);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    api.get<{ success: boolean; data: { items: NeighborEdge[] } }>(
      `/api/sources/${sourceId}/meshcore/neighbors?since=0`,
    ).then((resp) => {
      if (!cancelled && resp.success) setNeighborEdges(resp.data.items);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sourceId]);

  const neighborSegments = useMemo(() => {
    if (!showNeighbors || neighborEdges.length === 0) return [];
    const posByKey = new Map<string, [number, number]>();
    for (const c of positioned) {
      posByKey.set(c.publicKey, [c.latitude!, c.longitude!]);
    }
    return neighborEdges
      .map((e) => {
        const a = posByKey.get(e.publicKey);
        const b = posByKey.get(e.neighborPublicKey);
        if (!a || !b) return null;
        const label = `${e.nodeName || e.publicKey.substring(0, 8)} ↔ ${e.neighborName || e.neighborPublicKey.substring(0, 8)}${e.snr != null ? ` (${e.snr.toFixed(1)} dB)` : ''}`;
        return { key: `nb-${e.publicKey}-${e.neighborPublicKey}`, from: a, to: b, label };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [showNeighbors, neighborEdges, positioned]);

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
    <div className="meshcore-map-pane" style={{ position: 'relative' }}>
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
                {typeof c.pathLen === 'number' && <><br />Path: {hopCountLabel(c.pathLen)}</>}
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
                  {typeof c.pathLen === 'number' && <><br />Path: {hopCountLabel(c.pathLen)}</>}
                  {c.outPath && <><br />Route: {c.outPath}</>}
                  {c.lastSeen && <><br />Last seen: {new Date(c.lastSeen).toLocaleString()}</>}
                  {onNavigateToDm && (
                    <>
                      <br />
                      <button
                        onClick={() => onNavigateToDm(c.publicKey)}
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.3rem 0.7rem',
                          background: MESHCORE_COLOR,
                          color: '#1e1e2e',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          fontSize: '0.85em',
                          width: '100%',
                        }}
                      >
                        More Details
                      </button>
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {pathSegments.map(s => (
          <Polyline
            key={`path-${s.key}`}
            positions={[s.from, s.to]}
            pathOptions={{
              color: s.color,
              weight: 3,
              opacity: 0.8,
              dashArray: s.hops === 0 ? undefined : '8 4',
            }}
          >
            <Tooltip sticky>{s.label}</Tooltip>
          </Polyline>
        ))}

        {neighborSegments.map(s => (
          <Polyline
            key={s.key}
            positions={[s.from, s.to]}
            pathOptions={{
              color: NEIGHBOR_COLOR,
              weight: 1.5,
              opacity: 0.7,
              dashArray: '6 4',
            }}
          >
            <Tooltip sticky>{s.label}</Tooltip>
          </Polyline>
        ))}
      </MapContainer>

      <div className="map-controls dashboard-map-controls">
        <div className="map-controls-body">
          <div className="map-controls-title">Features</div>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showPaths}
              onChange={(e) => setShowPaths(e.target.checked)}
            />
            <span>Show Paths</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showNeighbors}
              onChange={(e) => setShowNeighbors(e.target.checked)}
            />
            <span>Show Neighbors</span>
          </label>
        </div>
      </div>
    </div>
  );
};
