import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import {
  getNodeTypeCategory,
  nodePassesTypeFilter,
  NODE_TYPE_CATEGORIES,
  NODE_TYPE_CATEGORY_META,
  type NodeTypeCategory,
} from '../../utils/nodeTypeCategory';
import { roleGlyphMarkerSvg } from '../../utils/mapIcons';
import { useSource } from '../../contexts/SourceContext';
import { getTilesetById, type TilesetId } from '../../config/tilesets';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import api from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import GeoJsonOverlay from '../GeoJsonOverlay';
import type { GeoJsonLayer } from '../../server/services/geojsonService.js';
import { TilesetSelector } from '../TilesetSelector';
import MapLegend from '../MapLegend';

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

/**
 * Marker body: a node-type role glyph (repeater/room/sensor/companion) on a
 * white circle when the contact's advert type is known (issue #3546), else the
 * original purple "MC" badge for standard/unknown nodes. The name label is
 * unchanged so existing behavior is preserved.
 */
function makeIcon(name: string, category: NodeTypeCategory): L.DivIcon {
  const glyph = roleGlyphMarkerSvg(category, MESHCORE_COLOR, 24);
  const body = glyph
    ? `<div style="width:24px;height:24px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">${glyph}</div>`
    : `
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
      ">MC</div>`;
  return L.divIcon({
    className: 'meshcore-marker',
    html: `
      ${body}
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
  const { t } = useTranslation();
  const { mapTileset, customTilesets, setMapTileset } = useSettings();
  const { sourceId } = useSource();
  const csrfFetch = useCsrfFetch();
  const tileset = getTilesetById(mapTileset, customTilesets);
  const [showPaths, setShowPaths] = useState(true);
  const [showNeighbors, setShowNeighbors] = useState(true);
  const [neighborEdges, setNeighborEdges] = useState<NeighborEdge[]>([]);

  // Per-node-type visibility filter (issue #3546), persisted like the other map
  // toggles. Missing/true => visible; a category is hidden only when explicitly
  // set false. Mirrors the Map Analysis workspace so behavior matches there.
  const [nodeTypeFilter, setNodeTypeFilter] = useState<Partial<Record<NodeTypeCategory, boolean>>>(() => {
    try {
      const raw = localStorage.getItem('meshmonitor-meshcore-nodeTypeFilter');
      return raw ? (JSON.parse(raw) as Partial<Record<NodeTypeCategory, boolean>>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-nodeTypeFilter', JSON.stringify(nodeTypeFilter));
  }, [nodeTypeFilter]);
  const setNodeTypeEnabled = (category: NodeTypeCategory, enabled: boolean) =>
    setNodeTypeFilter((prev) => ({ ...prev, [category]: enabled }));

  // Tile selector + legend overlays — hidden by default, toggled from the Map
  // Features panel. Persisted under the same localStorage keys the other maps
  // use so the preference is unified across every map surface.
  const [showTileSelector, setShowTileSelector] = useState(
    () => localStorage.getItem('meshmonitor-showTileSelector') === 'true',
  );
  const [showLegend, setShowLegend] = useState(
    () => localStorage.getItem('meshmonitor-showLegend') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('meshmonitor-showTileSelector', String(showTileSelector));
  }, [showTileSelector]);
  useEffect(() => {
    localStorage.setItem('meshmonitor-showLegend', String(showLegend));
  }, [showLegend]);

  // GeoJSON overlay layers (global, file-based) — fetched and toggled here so
  // the MeshCore map matches the NodesTab and Dashboard maps. Layer visibility
  // is global and shared with those maps' controls.
  const [geoJsonLayers, setGeoJsonLayers] = useState<GeoJsonLayer[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const baseUrl = await api.getBaseUrl();
        const response = await fetch(`${baseUrl}/api/geojson/layers`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setGeoJsonLayers(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error('Failed to fetch GeoJSON layers:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleGeoJsonLayer = (id: string, visible: boolean) => {
    setGeoJsonLayers(prev => prev.map(l => (l.id === id ? { ...l, visible } : l)));
    api.getBaseUrl().then(baseUrl => {
      csrfFetch(`${baseUrl}/api/geojson/layers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible }),
      }).catch(err => console.error('Failed to update layer visibility:', err));
    }).catch(err => console.error('Failed to get base URL:', err));
  };

  const positioned = useMemo(
    () => contacts.filter(c =>
      typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude)),
    [contacts],
  );

  // Markers visible after the node-type filter. Paths/neighbor lines keep using
  // `positioned` so the filter only hides markers — matching the Map Analysis
  // workspace, where the type filter never removes route/neighbor overlays.
  const visibleContacts = useMemo(
    () => positioned.filter(c => nodePassesTypeFilter({ advType: c.advType }, nodeTypeFilter)),
    [positioned, nodeTypeFilter],
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
      if (!cancelled && resp.success && Array.isArray(resp.data?.items)) {
        setNeighborEdges(resp.data.items);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sourceId]);

  const neighborSegments = useMemo(() => {
    if (!showNeighbors || !neighborEdges?.length) return [];
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
        {showLegend && <MapLegend showNodeTypes />}
        {geoJsonLayers.length > 0 && <GeoJsonOverlay layers={geoJsonLayers} />}
        {visibleContacts.map(c => {
          const name = c.advName || c.name || 'MeshCore';
          return (
            <Marker
              key={c.publicKey}
              position={[c.latitude!, c.longitude!]}
              icon={makeIcon(name, getNodeTypeCategory({ advType: c.advType }))}
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

      {showTileSelector && (
        <TilesetSelector
          selectedTilesetId={mapTileset as TilesetId}
          onTilesetChange={setMapTileset}
        />
      )}

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
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showTileSelector}
              onChange={(e) => setShowTileSelector(e.target.checked)}
            />
            <span>Show Tile Selection</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showLegend}
              onChange={(e) => setShowLegend(e.target.checked)}
            />
            <span>Show Legend</span>
          </label>
          {/* Per-node-type visibility (issue #3546) — hide infrastructure or
              end-user nodes to focus the map. Same categories as the legend. */}
          <div className="map-controls-title" style={{ marginTop: '0.5rem' }}>
            {t('map.nodeType.legendTitle', 'Node Types')}
          </div>
          {NODE_TYPE_CATEGORIES.map((category) => {
            const meta = NODE_TYPE_CATEGORY_META[category];
            return (
              <label key={category} className="map-control-item">
                <input
                  type="checkbox"
                  checked={nodeTypeFilter[category] !== false}
                  onChange={(e) => setNodeTypeEnabled(category, e.target.checked)}
                />
                <span>{t(meta.labelKey, meta.label)}</span>
              </label>
            );
          })}
          {/* GeoJSON overlay layers — per-layer on/off, mirroring the other maps. */}
          {geoJsonLayers.map(layer => (
            <label key={layer.id} className="map-control-item">
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) => toggleGeoJsonLayer(layer.id, e.target.checked)}
              />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{
                  display: 'inline-block', width: '8px', height: '8px',
                  borderRadius: '50%', backgroundColor: layer.style.color,
                }} />
                {layer.name}
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
};
