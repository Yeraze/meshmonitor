import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TILESETS, isPredefinedTilesetId, DEFAULT_TILESET_ID } from '../config/tilesets';
import type { TilesetConfig } from '../config/tilesets';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { getHardwareModelName, getRoleName } from '../utils/nodeHelpers';

interface EmbedConfig {
  id: string;
  channels: number[];
  tileset: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  showTooltips: boolean;
  showPopups: boolean;
  showLegend: boolean;
  showPaths: boolean;
  showNeighborInfo: boolean;
  showMqttNodes: boolean;
  pollIntervalSeconds: number;
}

interface EmbedNode {
  nodeNum: number;
  nodeId?: string;
  user?: {
    longName?: string;
    shortName?: string;
    hwModel?: number;
  };
  position?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };
  lastHeard?: number;
  snr?: number;
  hopsAway?: number;
  role?: number;
  viaMqtt?: boolean;
  channel?: number;
}

interface EmbedNeighborSegment {
  nodeNum: number;
  neighborNodeNum: number;
  snr: number | null;
  nodeLatitude: number;
  nodeLongitude: number;
  nodeName: string;
  neighborLatitude: number;
  neighborLongitude: number;
  neighborName: string;
}

interface EmbedTracerouteSegment {
  fromNum: number;
  toNum: number;
  fromLat: number;
  fromLng: number;
  fromName: string;
  toLat: number;
  toLng: number;
  toName: string;
  snr: number | null;
  timestamp: number;
}

interface EmbedMapProps {
  profileId: string;
}

function getEmbedTileset(tilesetId: string): TilesetConfig {
  if (isPredefinedTilesetId(tilesetId)) {
    return TILESETS[tilesetId];
  }
  return TILESETS[DEFAULT_TILESET_ID];
}

function formatLastHeard(lastHeard?: number): string {
  if (!lastHeard) return 'Unknown';
  const seconds = Math.floor(Date.now() / 1000) - lastHeard;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTimestamp(ts?: number): string {
  if (!ts) return 'Unknown';
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const HOP_LEGEND = [
  { label: 'Local', hops: 0 },
  { label: '1 hop', hops: 1 },
  { label: '2 hops', hops: 2 },
  { label: '3 hops', hops: 3 },
  { label: '4+ hops', hops: 4 },
  { label: 'Unknown', hops: 999 },
];

export function EmbedMap({ profileId }: EmbedMapProps) {
  const [config, setConfig] = useState<EmbedConfig | null>(null);
  const [nodes, setNodes] = useState<EmbedNode[]>([]);
  const [neighborSegments, setNeighborSegments] = useState<EmbedNeighborSegment[]>([]);
  const [tracerouteSegments, setTracerouteSegments] = useState<EmbedTracerouteSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const baseUrl = useRef(
    window.location.pathname.replace(/\/embed\/.*$/, '')
  ).current;

  // Fetch embed config on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchConfig() {
      try {
        const res = await fetch(`${baseUrl}/api/embed/${profileId}/config`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Failed to load embed configuration' }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setConfig(data);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load embed configuration');
          setLoading(false);
        }
      }
    }
    fetchConfig();
    return () => { cancelled = true; };
  }, [profileId, baseUrl]);

  // Fetch nodes
  const fetchNodes = useCallback(async () => {
    if (!config) return;
    try {
      const res = await fetch(`${baseUrl}/api/embed/${profileId}/nodes`);
      if (!res.ok) return;
      const data: EmbedNode[] = await res.json();
      setNodes(data);
    } catch {
      // Silently ignore poll errors
    }
  }, [config, baseUrl, profileId]);

  // Fetch neighbor info
  const fetchNeighborInfo = useCallback(async () => {
    if (!config || !config.showNeighborInfo) return;
    try {
      const res = await fetch(`${baseUrl}/api/embed/${profileId}/neighborinfo`);
      if (!res.ok) return;
      const data: EmbedNeighborSegment[] = await res.json();
      setNeighborSegments(data);
    } catch {
      // Silently ignore
    }
  }, [config, baseUrl, profileId]);

  // Fetch traceroute segments
  const fetchTraceroutes = useCallback(async () => {
    if (!config || !config.showPaths) return;
    try {
      const res = await fetch(`${baseUrl}/api/embed/${profileId}/traceroutes`);
      if (!res.ok) return;
      const data: EmbedTracerouteSegment[] = await res.json();
      setTracerouteSegments(data);
    } catch {
      // Silently ignore
    }
  }, [config, baseUrl, profileId]);

  // Start polling when config is loaded
  useEffect(() => {
    if (!config) return;

    fetchNodes();
    fetchNeighborInfo();
    fetchTraceroutes();

    const intervalMs = (config.pollIntervalSeconds || 30) * 1000;
    pollTimerRef.current = setInterval(() => {
      fetchNodes();
      fetchNeighborInfo();
      fetchTraceroutes();
    }, intervalMs);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [config, fetchNodes, fetchNeighborInfo, fetchTraceroutes]);

  const filteredNodes = nodes.filter((node) => {
    return node.position?.latitude != null && node.position?.longitude != null;
  });

  // Build icon map
  const iconMap = useMemo(() => {
    const map = new Map<number, L.DivIcon>();
    for (const node of filteredNodes) {
      const hops = node.hopsAway ?? 999;
      const isRouter = (node.role ?? 0) === 2;
      const icon = createNodeIcon({
        hops,
        isSelected: false,
        isRouter,
        shortName: node.user?.shortName,
        showLabel: false,
        pinStyle: 'meshmonitor',
      });
      map.set(node.nodeNum, icon);
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes.map(n => `${n.nodeNum}-${n.hopsAway}-${n.role}-${n.user?.shortName}`).join(',')]);

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%',
        backgroundColor: '#1a1a2e', color: '#a0a0b0',
        fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '14px',
      }}>
        Loading map...
      </div>
    );
  }

  if (error || !config) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%',
        backgroundColor: '#1a1a2e', color: '#ff4444',
        fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '14px',
        padding: '20px', textAlign: 'center',
      }}>
        {error || 'Failed to load embed configuration'}
      </div>
    );
  }

  const tileset = getEmbedTileset(config.tileset);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <style>{embedPopupCss}</style>
      <MapContainer
        center={[config.defaultLat, config.defaultLng]}
        zoom={config.defaultZoom}
        style={{ width: '100%', height: '100%' }}
        zoomControl={true}
        attributionControl={true}
      >
        <TileLayer
          url={tileset.url}
          attribution={tileset.attribution}
          maxZoom={tileset.maxZoom}
        />

        {/* Traceroute path segments */}
        {config.showPaths && tracerouteSegments.map((seg, idx) => (
          <Polyline
            key={`tr-${idx}`}
            positions={[
              [seg.fromLat, seg.fromLng],
              [seg.toLat, seg.toLng],
            ]}
            color="#cba6f7"
            weight={3}
            opacity={0.8}
          >
            {config.showPopups && (
              <Popup>
                <div className="embed-popup">
                  <div className="embed-popup-header">Traceroute Segment</div>
                  <div className="embed-popup-grid">
                    <div className="embed-popup-item embed-popup-item-full">
                      <span className="embed-popup-icon">📡</span>
                      <span className="embed-popup-value">{seg.fromName} &harr; {seg.toName}</span>
                    </div>
                    {seg.snr != null && (
                      <div className="embed-popup-item">
                        <span className="embed-popup-icon">📶</span>
                        <span className="embed-popup-value">{seg.snr} dB</span>
                      </div>
                    )}
                  </div>
                </div>
              </Popup>
            )}
          </Polyline>
        ))}

        {/* Neighbor info connection lines */}
        {config.showNeighborInfo && neighborSegments.map((seg, idx) => (
          <Polyline
            key={`nb-${idx}`}
            positions={[
              [seg.nodeLatitude, seg.nodeLongitude],
              [seg.neighborLatitude, seg.neighborLongitude],
            ]}
            color="#f5a623"
            weight={3}
            opacity={0.7}
            dashArray="5, 5"
          >
            {config.showPopups && (
              <Popup>
                <div className="embed-popup">
                  <div className="embed-popup-header">Neighbor Connection</div>
                  <div className="embed-popup-grid">
                    <div className="embed-popup-item embed-popup-item-full">
                      <span className="embed-popup-icon">🔗</span>
                      <span className="embed-popup-value">{seg.nodeName} &harr; {seg.neighborName}</span>
                    </div>
                    {seg.snr != null && (
                      <div className="embed-popup-item">
                        <span className="embed-popup-icon">📶</span>
                        <span className="embed-popup-value">{seg.snr} dB</span>
                      </div>
                    )}
                  </div>
                </div>
              </Popup>
            )}
          </Polyline>
        ))}

        {/* Node markers */}
        {filteredNodes.map((node) => {
          const icon = iconMap.get(node.nodeNum);
          const hops = node.hopsAway ?? 999;
          const hwModelName = getHardwareModelName(node.user?.hwModel);
          const roleName = getRoleName(node.role);

          return (
            <Marker
              key={node.nodeNum}
              position={[node.position!.latitude!, node.position!.longitude!]}
              icon={icon}
            >
              {config.showTooltips && (
                <Tooltip direction="top" offset={[0, -20]} permanent={false}>
                  <span>{node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16)}`}</span>
                </Tooltip>
              )}
              {config.showPopups && (
                <Popup autoPan={false}>
                  <div className="embed-popup">
                    {/* Header */}
                    <div className="embed-popup-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div className="embed-popup-title">
                        {node.user?.longName || `Node ${node.nodeNum}`}
                      </div>
                      {node.user?.shortName && (
                        <div className="embed-popup-subtitle">{node.user.shortName}</div>
                      )}
                    </div>

                    {/* Info grid */}
                    <div className="embed-popup-grid">
                      {/* Node ID */}
                      {node.nodeId && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon">🆔</span>
                          <span className="embed-popup-value">{node.nodeId}</span>
                        </div>
                      )}

                      {/* Role */}
                      {roleName && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon">👤</span>
                          <span className="embed-popup-value">{roleName}</span>
                        </div>
                      )}

                      {/* Hardware model - full width */}
                      {hwModelName && (
                        <div className="embed-popup-item embed-popup-item-full">
                          <span className="embed-popup-icon">🖥️</span>
                          <span className="embed-popup-value">{hwModelName}</span>
                        </div>
                      )}

                      {/* Hops */}
                      {hops < 999 && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon">🔗</span>
                          <span className="embed-popup-value">{hops} hop{hops !== 1 ? 's' : ''}</span>
                        </div>
                      )}

                      {/* Altitude */}
                      {node.position?.altitude != null && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon">⛰️</span>
                          <span className="embed-popup-value">{node.position.altitude}m</span>
                        </div>
                      )}

                      {/* SNR */}
                      {node.snr != null && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon">📶</span>
                          <span className="embed-popup-value">{node.snr} dB</span>
                        </div>
                      )}

                      {/* Channel */}
                      {node.channel != null && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon">📻</span>
                          <span className="embed-popup-value">Ch {node.channel}</span>
                        </div>
                      )}
                    </div>

                    {/* Footer: last heard */}
                    <div className="embed-popup-footer">
                      <span className="embed-popup-icon">🕐</span>
                      <span>{formatTimestamp(node.lastHeard)}</span>
                      <span className="embed-popup-ago">({formatLastHeard(node.lastHeard)})</span>
                    </div>

                    {/* MQTT badge */}
                    {node.viaMqtt && (
                      <div className="embed-popup-badge">via MQTT</div>
                    )}
                  </div>
                </Popup>
              )}
            </Marker>
          );
        })}
      </MapContainer>

      {/* Hop count legend overlay */}
      {config.showLegend && filteredNodes.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '30px',
          left: '10px',
          backgroundColor: 'rgba(26, 26, 46, 0.9)',
          color: '#e0e0e0',
          padding: '10px 14px',
          borderRadius: '6px',
          fontSize: '12px',
          zIndex: 1000,
          pointerEvents: 'none',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '6px' }}>
            {filteredNodes.length} node{filteredNodes.length !== 1 ? 's' : ''} online
          </div>
          {HOP_LEGEND.map(({ label, hops }) => (
            <div key={hops} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
              <span style={{
                display: 'inline-block', width: '12px', height: '12px',
                borderRadius: '50%', backgroundColor: getHopColor(hops),
              }} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Inline CSS for embed popups — matches the MeshMonitor Catppuccin theme.
 * Uses hardcoded values since the embed doesn't load the main app's CSS variables.
 */
const embedPopupCss = `
  .embed-popup {
    background: #1e1e2e;
    border-radius: 8px;
    padding: 0.75rem;
    min-width: 200px;
    max-width: 300px;
    font-family: system-ui, -apple-system, sans-serif;
    color: #cdd6f4;
  }

  .embed-popup-header {
    margin-bottom: 0.5rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid #313244;
  }

  .embed-popup-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: #cdd6f4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .embed-popup-subtitle {
    font-size: 0.8rem;
    font-weight: 600;
    color: #89b4fa;
    background: #313244;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .embed-popup-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3rem;
  }

  .embed-popup-item-full {
    grid-column: 1 / -1;
  }

  .embed-popup-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.35rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .embed-popup-item:hover {
    background: #313244;
  }

  .embed-popup-icon {
    font-size: 1rem;
    line-height: 1;
  }

  .embed-popup-value {
    color: #cdd6f4;
    font-weight: 500;
    font-size: 0.8rem;
  }

  .embed-popup-footer {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px solid #313244;
    font-size: 0.8rem;
    color: #a6adc8;
  }

  .embed-popup-ago {
    color: #6c7086;
    font-size: 0.75rem;
  }

  .embed-popup-badge {
    display: inline-block;
    margin-top: 0.35rem;
    padding: 0.15rem 0.5rem;
    background: #313244;
    color: #6c7086;
    border-radius: 4px;
    font-size: 0.7rem;
  }

  /* Override Leaflet popup styles for dark theme */
  .leaflet-popup-content-wrapper {
    background: #1e1e2e !important;
    border: 1px solid #313244 !important;
    border-radius: 8px !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4) !important;
    padding: 0 !important;
  }

  .leaflet-popup-content {
    margin: 0 !important;
    color: #cdd6f4 !important;
  }

  .leaflet-popup-tip {
    background: #1e1e2e !important;
    border: 1px solid #313244 !important;
  }

  .leaflet-popup-close-button {
    color: #6c7086 !important;
  }

  .leaflet-popup-close-button:hover {
    color: #cdd6f4 !important;
  }
`;
