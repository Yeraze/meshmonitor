import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Marker, Tooltip, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DEFAULT_TILESET_ID } from '../config/tilesets';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { getHardwareModelName, getRoleName } from '../utils/nodeHelpers';
import GeoJsonOverlay from './GeoJsonOverlay';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';
import { getOverlayColors, getSchemeForTileset } from '../config/overlayColors';
import { BaseMap } from './map/BaseMap';
import { TraceroutePathsLayer } from './map/layers/TraceroutePathsLayer';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from './map/layers/NeighborLinksLayer';
import type { TracerouteRenderSegment } from '../utils/tracerouteSegments';
import { UiIcon } from './icons';
import api from '../services/api';

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
  // Additive fields (#4047 P6 WP1) — the server now emits these on every
  // response, but they're typed optional here so a stale/cached response
  // from a not-yet-upgraded server (old shape) is tolerated defensively,
  // mirroring the server's own tolerance of old (pre-WP1) embed clients.
  leg?: 'forward' | 'return';
  avgSnr?: number | null;
  isMqtt?: boolean;
}

interface EmbedMapProps {
  profileId: string;
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
  const [geoJsonLayers, setGeoJsonLayers] = useState<GeoJsonLayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The embed route is a standalone public page (src/embed.tsx) — it's the
  // only consumer of ApiService in this bundle, so pinning the singleton's
  // base URL here (skipping ApiService's own /api/config auto-detection,
  // which isn't guaranteed to resolve the same prefix on this route) is
  // safe. The lazy useState initializer runs exactly once, so setBaseUrl
  // fires on mount only, not on every render.
  const [baseUrl] = useState(() => {
    const b = window.location.pathname.replace(/\/embed\/.*$/, '');
    api.setBaseUrl(b);
    return b;
  });

  // Fetch embed config on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchConfig() {
      try {
        const data = await api.get<EmbedConfig>(`/api/embed/${profileId}/config`);
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
    void fetchConfig();
    return () => { cancelled = true; };
  }, [profileId, baseUrl]);

  // Fetch nodes
  const fetchNodes = useCallback(async () => {
    if (!config) return;
    try {
      const data = await api.get<EmbedNode[]>(`/api/embed/${profileId}/nodes`);
      setNodes(data);
    } catch {
      // Silently ignore poll errors
    }
  }, [config, baseUrl, profileId]);

  // Fetch neighbor info
  const fetchNeighborInfo = useCallback(async () => {
    if (!config || !config.showNeighborInfo) return;
    try {
      const data = await api.get<EmbedNeighborSegment[]>(`/api/embed/${profileId}/neighborinfo`);
      setNeighborSegments(data);
    } catch {
      // Silently ignore
    }
  }, [config, baseUrl, profileId]);

  // Fetch traceroute segments
  const fetchTraceroutes = useCallback(async () => {
    if (!config || !config.showPaths) return;
    try {
      const data = await api.get<EmbedTracerouteSegment[]>(`/api/embed/${profileId}/traceroutes`);
      setTracerouteSegments(data);
    } catch {
      // Silently ignore
    }
  }, [config, baseUrl, profileId]);

  // Fetch public GeoJSON overlay layers once config is available (issue #3407).
  // Only layers flagged publiclyVisible are returned by the embed endpoint.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<GeoJsonLayer[]>(`/api/embed/${profileId}/geojson/layers`);
        if (!cancelled) setGeoJsonLayers(data);
      } catch {
        // Silently ignore — overlays are optional
      }
    })();
    return () => { cancelled = true; };
  }, [config, baseUrl, profileId]);

  // Start polling when config is loaded
  useEffect(() => {
    if (!config) return;

    void fetchNodes();
    void fetchNeighborInfo();
    void fetchTraceroutes();

    const intervalMs = (config.pollIntervalSeconds || 30) * 1000;
    pollTimerRef.current = setInterval(() => {
      void fetchNodes();
      void fetchNeighborInfo();
      void fetchTraceroutes();
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

  // Traceroute palette (#4047 P6 §3.1) — the embed bundle has no
  // SettingsProvider, so the SNR palette is derived directly from the
  // profile's tileset rather than useSettings(). Falls back to the default
  // tileset id before config loads (getSchemeForTileset defaults unknown
  // tileset ids to 'dark' anyway).
  const overlay = useMemo(
    () => getOverlayColors(getSchemeForTileset(config?.tileset ?? DEFAULT_TILESET_ID)),
    [config?.tileset],
  );
  const snrColors = overlay.snrColors;
  const mqttColor = overlay.mqttSegment;

  // Wire segment -> shared TracerouteRenderSegment mapping (#4047 P6 §3.2).
  // Positions are already resolved server-side; this is a pure field rename,
  // no client-side decomposition. `leg` defaults to 'forward' for a stale
  // pre-WP1 response (old shape has no leg — everything it sent was a single
  // forward-only line).
  const renderSegments: TracerouteRenderSegment[] = useMemo(
    () => tracerouteSegments.map((s) => {
      const leg = s.leg ?? 'forward';
      return {
        key: `${leg}:${s.fromNum}-${s.toNum}`,
        from: [s.fromLat, s.fromLng] as [number, number],
        to: [s.toLat, s.toLng] as [number, number],
        fromNodeNum: s.fromNum,
        toNodeNum: s.toNum,
        leg,
        avgSnr: s.avgSnr !== undefined ? s.avgSnr : s.snr,
        isMqtt: s.isMqtt ?? false,
        timestamp: s.timestamp,
      };
    }),
    [tracerouteSegments],
  );

  // Popup lookup by the same key so the popup can show fromName/toName
  // (already on the wire object — zero extra plumbing per §3.3).
  const tracerouteSegmentsByKey = useMemo(() => {
    const map = new Map<string, EmbedTracerouteSegment>();
    for (const s of tracerouteSegments) {
      const leg = s.leg ?? 'forward';
      map.set(`${leg}:${s.fromNum}-${s.toNum}`, s);
    }
    return map;
  }, [tracerouteSegments]);

  const renderTraceroutePopup = useCallback((seg: TracerouteRenderSegment) => {
    const wire = tracerouteSegmentsByKey.get(seg.key);
    return (
      <Popup>
        <div className="embed-popup">
          <div className="embed-popup-header">Traceroute Segment</div>
          <div className="embed-popup-grid">
            <div className="embed-popup-item embed-popup-item-full">
              <span className="embed-popup-icon"><UiIcon name="route" size={16} /></span>
              <span className="embed-popup-value">
                {wire ? `${wire.fromName} ↔ ${wire.toName}` : `Node ${seg.fromNodeNum} ↔ Node ${seg.toNodeNum}`}
              </span>
            </div>
            {seg.avgSnr != null && (
              <div className="embed-popup-item">
                <span className="embed-popup-icon"><UiIcon name="wifi" size={16} /></span>
                <span className="embed-popup-value">{seg.avgSnr.toFixed(1)} dB</span>
              </div>
            )}
            {seg.isMqtt && (
              <div className="embed-popup-item embed-popup-item-full">
                <span className="embed-popup-icon"><UiIcon name="network" size={16} /></span>
                <span className="embed-popup-value">via MQTT</span>
              </div>
            )}
          </div>
        </div>
      </Popup>
    );
  }, [tracerouteSegmentsByKey]);

  // Neighbor-info connection lines -> shared NeighborLinksLayer descriptors
  // (#4047 P7 §4.1/§3.4): the flat color/weight/opacity/dashArray props this
  // block used to pass straight to <Polyline> are wrapped into a single
  // `pathOptions` object, byte-for-byte preserving the amber/w3/o.7/dash
  // '5, 5' look; the popup JSX moves into `children` unchanged.
  const neighborLinks: NeighborLinkDescriptor[] = useMemo(() => {
    if (!config?.showNeighborInfo) return [];
    return neighborSegments.map((seg, idx) => ({
      key: `nb-${idx}`,
      positions: [
        [seg.nodeLatitude, seg.nodeLongitude],
        [seg.neighborLatitude, seg.neighborLongitude],
      ] as [[number, number], [number, number]],
      pathOptions: { color: '#f5a623', weight: 3, opacity: 0.7, dashArray: '5, 5' },
      children: config.showPopups ? (
        <Popup>
          <div className="embed-popup">
            <div className="embed-popup-header">Neighbor Connection</div>
            <div className="embed-popup-grid">
              <div className="embed-popup-item embed-popup-item-full">
                <span className="embed-popup-icon"><UiIcon name="link" size={16} /></span>
                <span className="embed-popup-value">{seg.nodeName} &harr; {seg.neighborName}</span>
              </div>
              {seg.snr != null && (
                <div className="embed-popup-item">
                  <span className="embed-popup-icon"><UiIcon name="wifi" size={16} /></span>
                  <span className="embed-popup-value">{seg.snr} dB</span>
                </div>
              )}
            </div>
          </div>
        </Popup>
      ) : undefined,
    }));
  }, [config?.showNeighborInfo, config?.showPopups, neighborSegments]);

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

  // Optional URL-parameter overrides (issue #2668): ?lat=&lon=&zoom= let
  // embedders pin a location without creating a new profile.
  const urlParams = new URLSearchParams(window.location.search);
  const urlLat = parseFloat(urlParams.get('lat') ?? '');
  const urlLon = parseFloat(urlParams.get('lon') ?? '');
  const urlZoom = parseInt(urlParams.get('zoom') ?? '', 10);
  const centerLat = Number.isFinite(urlLat) ? urlLat : config.defaultLat;
  const centerLng = Number.isFinite(urlLon) ? urlLon : config.defaultLng;
  const centerZoom = Number.isFinite(urlZoom) ? urlZoom : config.defaultZoom;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <style>{embedPopupCss}</style>
      <BaseMap
        center={[centerLat, centerLng]}
        zoom={centerZoom}
        tilesetId={config.tileset}
        customTilesets={[]}
        zoomControl
        attributionControl
      >
        {/* Public GeoJSON overlay layers (issue #3407) */}
        {geoJsonLayers.length > 0 && (
          <GeoJsonOverlay
            layers={geoJsonLayers}
            baseUrl={baseUrl}
            dataPathPrefix={`/api/embed/${profileId}/geojson/layers`}
          />
        )}

        {/* Traceroute path segments — rendered through the shared layer
            (#4047 P6) with the flat consumer preset (D3): SNR-colored,
            MQTT/unknown-dashed, no arrows — matching the app's canonical
            all-segments-overview look (NodesTab base layer / Dashboard
            paths pass), not the single-route arrowed preset. */}
        {config.showPaths && (
          <TraceroutePathsLayer
            segments={renderSegments}
            snrColors={snrColors}
            colorMode="snr"
            mqttColor={mqttColor}
            curvature={0}
            weight={2}
            opacity={0.85}
            dashMode="mqtt-unknown"
            renderPopup={config.showPopups ? renderTraceroutePopup : undefined}
          />
        )}

        {/* Neighbor info connection lines — rendered through the shared
            NeighborLinksLayer (#4047 P7 §4.1); descriptors built above
            preserve the amber/w3/o.7/dash '5, 5' look byte-for-byte. */}
        {config.showNeighborInfo && <NeighborLinksLayer links={neighborLinks} />}

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
                          <span className="embed-popup-icon"><UiIcon name="identity" size={16} /></span>
                          <span className="embed-popup-value">{node.nodeId}</span>
                        </div>
                      )}

                      {/* Role */}
                      {roleName && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon"><UiIcon name="user" size={16} /></span>
                          <span className="embed-popup-value">{roleName}</span>
                        </div>
                      )}

                      {/* Hardware model - full width */}
                      {hwModelName && (
                        <div className="embed-popup-item embed-popup-item-full">
                          <span className="embed-popup-icon"><UiIcon name="monitor" size={16} /></span>
                          <span className="embed-popup-value">{hwModelName}</span>
                        </div>
                      )}

                      {/* Hops */}
                      {hops < 999 && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon"><UiIcon name="link" size={16} /></span>
                          <span className="embed-popup-value">{hops} hop{hops !== 1 ? 's' : ''}</span>
                        </div>
                      )}

                      {/* Altitude */}
                      {node.position?.altitude != null && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon"><UiIcon name="altitude" size={16} /></span>
                          <span className="embed-popup-value">{node.position.altitude}m</span>
                        </div>
                      )}

                      {/* SNR */}
                      {node.snr != null && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon"><UiIcon name="wifi" size={16} /></span>
                          <span className="embed-popup-value">{node.snr} dB</span>
                        </div>
                      )}

                      {/* Channel */}
                      {node.channel != null && (
                        <div className="embed-popup-item">
                          <span className="embed-popup-icon"><UiIcon name="radio" size={16} /></span>
                          <span className="embed-popup-value">Ch {node.channel}</span>
                        </div>
                      )}
                    </div>

                    {/* Footer: last heard */}
                    <div className="embed-popup-footer">
                      <span className="embed-popup-icon"><UiIcon name="time" size={16} /></span>
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
      </BaseMap>

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
    padding: 1px !important;
  }

  .leaflet-popup-content {
    margin: 13px 19px !important;
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
