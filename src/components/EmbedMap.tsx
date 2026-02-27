import { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TILESETS, isPredefinedTilesetId, DEFAULT_TILESET_ID } from '../config/tilesets';
import type { TilesetConfig } from '../config/tilesets';

// Fix default Leaflet marker icons (Vite bundling issue)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjZmY2NjY2Ii8+Cjwvc3ZnPg==',
  iconUrl:
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjNjY5OGY1Ii8+Cjwvc3ZnPg==',
  shadowUrl:
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9IjAuMyIvPgo8L3N2Zz4K',
  iconSize: [24, 24],
  iconAnchor: [12, 24],
});

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
  user?: {
    longName?: string;
    shortName?: string;
    hwModel?: string;
  };
  position?: {
    latitude?: number;
    longitude?: number;
  };
  lastHeard?: number;
  snr?: number;
  viaMqtt?: boolean;
  channel?: number;
}

interface EmbedMapProps {
  profileId: string;
}

/**
 * Resolve a tileset ID to a TilesetConfig for the embed context.
 * Only predefined (raster) tilesets are supported; custom/vector tilesets
 * fall back to the default OSM tileset since the embed doesn't have access
 * to custom tileset URLs.
 */
function getEmbedTileset(tilesetId: string): TilesetConfig {
  if (isPredefinedTilesetId(tilesetId)) {
    return TILESETS[tilesetId];
  }
  // Custom or vector tileset — fall back to OSM
  return TILESETS[DEFAULT_TILESET_ID];
}

/**
 * Format "last heard" timestamp into a human-readable relative time string.
 */
function formatLastHeard(lastHeard?: number): string {
  if (!lastHeard) return 'Unknown';
  const seconds = Math.floor(Date.now() / 1000) - lastHeard;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function EmbedMap({ profileId }: EmbedMapProps) {
  const [config, setConfig] = useState<EmbedConfig | null>(null);
  const [nodes, setNodes] = useState<EmbedNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derive the base URL from the current path
  // e.g. /meshmonitor/embed/abc123 -> /meshmonitor
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

  // Fetch nodes from the embed-specific nodes endpoint
  // This endpoint uses the profile ID as auth — no session required
  const fetchNodes = useCallback(async () => {
    if (!config) return;
    try {
      const res = await fetch(`${baseUrl}/api/embed/${profileId}/nodes`);
      if (!res.ok) return; // Silently ignore poll errors
      const data: EmbedNode[] = await res.json();
      setNodes(data);
    } catch {
      // Silently ignore poll errors — don't break the map
    }
  }, [config, baseUrl, profileId]);

  // Start polling when config is loaded
  useEffect(() => {
    if (!config) return;

    // Fetch immediately
    fetchNodes();

    // Set up polling interval
    const intervalMs = (config.pollIntervalSeconds || 30) * 1000;
    pollTimerRef.current = setInterval(fetchNodes, intervalMs);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [config, fetchNodes]);

  // Nodes are pre-filtered by the server endpoint (channels, MQTT, position)
  // Client-side filtering is a safety net only
  const filteredNodes = nodes.filter((node) => {
    return node.position?.latitude && node.position?.longitude;
  });

  // Loading state
  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a2e',
        color: '#a0a0b0',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '14px',
      }}>
        Loading map...
      </div>
    );
  }

  // Error state
  if (error || !config) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a2e',
        color: '#ff4444',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        padding: '20px',
        textAlign: 'center',
      }}>
        {error || 'Failed to load embed configuration'}
      </div>
    );
  }

  const tileset = getEmbedTileset(config.tileset);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
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

        {filteredNodes.map((node) => (
          <Marker
            key={node.nodeNum}
            position={[node.position!.latitude!, node.position!.longitude!]}
          >
            {config.showTooltips && (
              <Tooltip direction="top" offset={[0, -20]} permanent={false}>
                <span>{node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16)}`}</span>
              </Tooltip>
            )}
            {config.showPopups && (
              <Popup>
                <div style={{ minWidth: 150 }}>
                  <strong>{node.user?.longName || `!${node.nodeNum.toString(16)}`}</strong>
                  {node.user?.shortName && (
                    <div style={{ color: '#666', fontSize: '12px' }}>{node.user.shortName}</div>
                  )}
                  {node.user?.hwModel && (
                    <div style={{ fontSize: '12px', marginTop: '4px' }}>
                      <strong>Hardware:</strong> {node.user.hwModel}
                    </div>
                  )}
                  {node.snr !== undefined && (
                    <div style={{ fontSize: '12px' }}>
                      <strong>SNR:</strong> {node.snr} dB
                    </div>
                  )}
                  <div style={{ fontSize: '12px' }}>
                    <strong>Last heard:</strong> {formatLastHeard(node.lastHeard)}
                  </div>
                  {node.viaMqtt && (
                    <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>via MQTT</div>
                  )}
                </div>
              </Popup>
            )}
          </Marker>
        ))}
      </MapContainer>

      {/* Legend overlay */}
      {config.showLegend && filteredNodes.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '30px',
          left: '10px',
          backgroundColor: 'rgba(26, 26, 46, 0.85)',
          color: '#e0e0e0',
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          zIndex: 1000,
          pointerEvents: 'none',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          {filteredNodes.length} node{filteredNodes.length !== 1 ? 's' : ''} online
        </div>
      )}
    </div>
  );
}
