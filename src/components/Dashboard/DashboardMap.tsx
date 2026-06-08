/**
 * DashboardMap — self-contained map component for the Dashboard page.
 *
 * Renders node markers, marker popups, neighbor link polylines, traceroute
 * paths, and position-accuracy regions on a react-leaflet MapContainer.
 * Automatically fits the map bounds to nodes that have valid GPS positions.
 *
 * Map feature toggles (Show RF / UDP / MQTT, Show Traceroute, Show Route
 * Segments, Show Accuracy Regions) are read from MapContext so they
 * round-trip through `/api/user/map-preferences` alongside the per-source
 * NodesTab toggles. DashboardPage wraps this component in a MapProvider.
 */

import { useEffect, useMemo, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Rectangle, useMap } from 'react-leaflet';
import L from 'leaflet';
import { createNodeIcon } from '../../utils/mapIcons';
import { getTilesetById } from '../../config/tilesets';
import type { CustomTileset } from '../../config/tilesets';
import DashboardWaypoints from './DashboardWaypoints';
import DashboardNodePopup from './DashboardNodePopup';
import { useMapContext } from '../../contexts/MapContext';
import { useSettings } from '../../contexts/SettingsContext';
import { nodePassesTransportFilter } from '../../utils/nodeTransport';

export interface DashboardMapProps {
  nodes: any[];
  neighborInfo: any[];
  /**
   * MeshCore neighbor edges (from `/api/sources/:id/meshcore/neighbors`), keyed
   * by publicKey. Rendered as links between MeshCore node markers when the
   * "Show Neighbors" toggle is on. Empty for non-MeshCore sources.
   */
  meshcoreNeighbors?: any[];
  traceroutes: any[];
  channels: any[];
  tilesetId: string;
  customTilesets: CustomTileset[];
  defaultCenter: { lat: number; lng: number };
  sourceId: string | null;
  /** Hours since lastHeard to count a node as "active". Favorites bypass this gate. */
  maxNodeAgeHours: number;
}

/** Extract lat/lng from a node — handles both flat (API) and nested (position) shapes. */
function getNodeLatLng(node: any): { lat: number; lng: number } | null {
  // Flat shape from API: node.latitude, node.longitude
  let lat = node?.latitude ?? node?.position?.latitude;
  let lng = node?.longitude ?? node?.position?.longitude;
  if (lat != null && lng != null && (lat !== 0 || lng !== 0)) {
    return { lat, lng };
  }
  return null;
}

/** SNR → color, matching the per-hop coloring used in MapAnalysis/TraceroutePathsLayer. */
function snrToColor(snr: number): string {
  if (snr >= 5) return '#22c55e';
  if (snr >= 0) return '#eab308';
  if (snr >= -5) return '#f97316';
  return '#ef4444';
}

/** SNR → line opacity for MeshCore neighbor links, matching MeshCoreNeighborLinksLayer. */
function snrToOpacity(snr: number | null | undefined): number {
  if (snr == null) return 0.4;
  return Math.max(0.2, Math.min(1, (snr + 10) / 20));
}

/** Safe JSON.parse that yields [] on bad/empty input. */
function parseJsonArray(value: unknown): number[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse the `routePositions` JSON snapshot stored on a traceroute row.
 * Shape: `{ [nodeNum]: { lat, lng, alt? } }`. Backend emits this so the
 * frontend can draw the route even if a hop's node has gone stale and
 * been filtered out of the live nodes list.
 */
function parseRoutePositions(value: unknown): Record<number, { lat: number; lng: number }> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<number, { lat: number; lng: number }>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

// ---------------------------------------------------------------------------
// MapBoundsUpdater — internal helper that calls fitBounds inside the map ctx
// ---------------------------------------------------------------------------

interface MapBoundsUpdaterProps {
  positions: [number, number][];
  sourceId: string | null;
}

function MapBoundsUpdater({ positions, sourceId }: MapBoundsUpdaterProps) {
  const map = useMap();
  const hasFittedRef = useRef(false);

  useEffect(() => {
    // Only auto-fit once on initial load, then let the user control the view
    if (hasFittedRef.current) return;
    if (positions.length === 0) return;
    const bounds = L.latLngBounds(positions);
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] });
      hasFittedRef.current = true;
    }
  }, [map, positions, sourceId]);

  return null;
}

// ---------------------------------------------------------------------------
// DashboardMap
// ---------------------------------------------------------------------------

export default function DashboardMap({
  nodes,
  neighborInfo,
  meshcoreNeighbors = [],
  traceroutes,
  tilesetId,
  customTilesets,
  defaultCenter,
  sourceId,
  maxNodeAgeHours,
}: DashboardMapProps) {
  const tileset = getTilesetById(tilesetId, customTilesets);
  const { mapPinStyle } = useSettings();

  const {
    showPaths,
    setShowPaths,
    showRoute,
    setShowRoute,
    showAccuracyRegions,
    setShowAccuracyRegions,
    showRfNodes,
    setShowRfNodes,
    showUdpNodes,
    setShowUdpNodes,
    showMqttNodes,
    setShowMqttNodes,
    showNeighborInfo,
    setShowNeighborInfo,
    showWaypoints,
    setShowWaypoints,
  } = useMapContext();

  // Build array of nodes that have valid positions, with their resolved lat/lng.
  // Mirrors NodesTab's processedNodes pipeline (App.tsx): ignored hidden, age cutoff
  // bypassed by favorites, transport-class filter from the Map Features panel.
  const cutoffTime = Date.now() / 1000 - maxNodeAgeHours * 60 * 60;
  const nodesWithPosition = nodes
    .filter((n) => !n.isIgnored)
    .filter((n) => n.isFavorite || (n.lastHeard != null && n.lastHeard >= cutoffTime))
    .filter((n) => nodePassesTransportFilter(n, { showRfNodes, showUdpNodes, showMqttNodes }))
    .map((n) => ({ node: n, pos: getNodeLatLng(n) }))
    .filter((entry): entry is { node: any; pos: { lat: number; lng: number } } => entry.pos !== null);

  const nodePositions: [number, number][] = nodesWithPosition.map((e) => [e.pos.lat, e.pos.lng]);

  // nodeNum → [lat, lng] map used to resolve traceroute hop positions. The
  // unified view merges per-source node rows by nodeNum (see mergeUnifiedSourceData
  // in useDashboardData.ts), so a single lookup table works across sources.
  const positionByNodeNum = useMemo(() => {
    const map = new Map<number, [number, number]>();
    for (const { node, pos } of nodesWithPosition) {
      if (typeof node.nodeNum === 'number') {
        map.set(node.nodeNum, [pos.lat, pos.lng]);
      }
    }
    return map;
  }, [nodesWithPosition]);

  // publicKey → [lat, lng] for resolving MeshCore neighbor-link endpoints.
  // MeshCore nodes carry no meshtastic nodeNum; their stable identity (and the
  // key the neighbor edges reference) is the public key.
  const positionByPublicKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const { node, pos } of nodesWithPosition) {
      if (node.isMeshCore && typeof node.publicKey === 'string' && node.publicKey.length > 0) {
        map.set(node.publicKey, [pos.lat, pos.lng]);
      }
    }
    return map;
  }, [nodesWithPosition]);

  // MeshCore neighbor links: one Polyline per edge whose BOTH endpoints resolve
  // to a currently-visible MeshCore node. Gated by the "Show Neighbors" toggle.
  // Endpoints are filtered through the same node pipeline above, so links to a
  // hidden node (stale / ignored / RF off) naturally drop out. Deduped by the
  // unordered {publicKey, neighborPublicKey} pair so the same link reported by
  // multiple sources (Unified view) draws once.
  const meshcoreSegments = useMemo(() => {
    if (!showNeighborInfo) return [];
    const seen = new Set<string>();
    const segs: Array<{ key: string; positions: [number, number][]; opacity: number }> = [];
    for (const e of (meshcoreNeighbors ?? [])) {
      const pk = e?.publicKey;
      const npk = e?.neighborPublicKey;
      if (typeof pk !== 'string' || typeof npk !== 'string') continue;
      const a = positionByPublicKey.get(pk);
      const b = positionByPublicKey.get(npk);
      if (!a || !b) continue;
      const pairKey = pk < npk ? `${pk}~${npk}` : `${npk}~${pk}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      segs.push({ key: pairKey, positions: [a, b], opacity: snrToOpacity(e?.snr) });
    }
    return segs;
  }, [meshcoreNeighbors, positionByPublicKey, showNeighborInfo]);

  // Traceroute segments: one Polyline per hop, colored by snrTowards. Empty
  // unless the user has enabled "Show Route Segments" or "Show Traceroute".
  //
  // Position resolution order for each hop:
  //   1. `tr.routePositions` — JSON snapshot of positions at traceroute time.
  //      Backend stamps this so the line still draws even when a hop's node
  //      has aged out of the live nodes list.
  //   2. live `positionByNodeNum` — current node positions.
  const tracerouteSegments = useMemo(() => {
    if (!showPaths && !showRoute) return [];
    const segs: Array<{
      key: string;
      positions: [number, number][];
      color: string;
    }> = [];
    for (const tr of (traceroutes ?? [])) {
      const route = parseJsonArray(tr?.route);
      const snrTowards = parseJsonArray(tr?.snrTowards);
      const fromNum = Number(tr?.fromNodeNum);
      const toNum = Number(tr?.toNodeNum);
      if (!Number.isFinite(fromNum) || !Number.isFinite(toNum)) continue;
      const snapshot = parseRoutePositions(tr?.routePositions);
      const lookup = (nodeNum: number): [number, number] | undefined => {
        const snap = snapshot[nodeNum];
        if (snap && typeof snap.lat === 'number' && typeof snap.lng === 'number') {
          return [snap.lat, snap.lng];
        }
        return positionByNodeNum.get(nodeNum);
      };
      const path = [fromNum, ...route.map((n) => Number(n)), toNum];
      for (let i = 0; i < path.length - 1; i++) {
        const a = lookup(path[i]);
        const b = lookup(path[i + 1]);
        if (!a || !b) continue;
        const snr = typeof snrTowards[i] === 'number' ? snrTowards[i] : 0;
        segs.push({
          key: `tr-${tr.sourceId ?? 'x'}-${tr.id}-${i}`,
          positions: [a, b],
          color: snrToColor(snr),
        });
      }
    }
    return segs;
  }, [traceroutes, positionByNodeNum, showPaths, showRoute]);

  const hasNodes = nodesWithPosition.length > 0;

  return (
    <div className="dashboard-map-container" style={{ position: 'relative' }}>
      <MapContainer
        center={[defaultCenter.lat, defaultCenter.lng]}
        zoom={10}
        style={{ height: '100%', width: '100%' }}
        zoomControl
      >
        <TileLayer
          key={tilesetId}
          url={tileset.url}
          attribution={tileset.attribution}
          maxZoom={tileset.maxZoom}
        />

        <MapBoundsUpdater positions={nodePositions} sourceId={sourceId} />

        {showWaypoints && <DashboardWaypoints sourceId={sourceId} />}

        {nodesWithPosition.map(({ node, pos }) => {
          const hops = node.hopsAway ?? 999;
          const shortName = node.shortName ?? node.user?.shortName;
          const nodeId = node.nodeId ?? node.user?.id;
          const isRouter = node.role === 2;
          const icon = createNodeIcon({
            hops,
            isSelected: false,
            isRouter,
            shortName,
            showLabel: true,
            pinStyle: mapPinStyle,
          });

          return (
            <Marker
              key={nodeId}
              position={[pos.lat, pos.lng]}
              icon={icon}
            >
              <Popup>
                <DashboardNodePopup node={node} pos={pos} />
              </Popup>
            </Marker>
          );
        })}

        {/* Position accuracy regions — drawn from precision_bits, mirroring NodesTab. */}
        {showAccuracyRegions && nodesWithPosition
          .filter(({ node }) => {
            const bits = node.positionPrecisionBits;
            if (bits === undefined || bits === null) return false;
            if (bits <= 0 || bits >= 32) return false;
            // Don't show accuracy region for nodes with user-overridden positions
            if (node.positionIsOverride) return false;
            return true;
          })
          .map(({ node, pos }) => {
            // Meshtastic encodes lat/lon as int32 (1 unit = 1e-7 degrees).
            // With N precision bits, the grid cell side = 2^(32-N) * 1e-7 * 111111 m.
            // Accuracy (max deviation) is half the grid cell.
            const metersPerDegree = 111_111;
            const sizeMeters = Math.pow(2, 32 - node.positionPrecisionBits) * 1e-7 * metersPerDegree;
            const halfSizeMeters = sizeMeters / 2;
            const latOffset = halfSizeMeters / metersPerDegree;
            const metersPerDegreeLng = metersPerDegree * Math.cos(pos.lat * Math.PI / 180);
            const lngOffset = halfSizeMeters / metersPerDegreeLng;
            const bounds: [[number, number], [number, number]] = [
              [pos.lat - latOffset, pos.lng - lngOffset],
              [pos.lat + latOffset, pos.lng + lngOffset],
            ];
            return (
              <Rectangle
                key={`accuracy-${node.nodeNum ?? node.nodeId ?? node.user?.id}`}
                bounds={bounds}
                pathOptions={{
                  color: '#888',
                  fillColor: '#888',
                  fillOpacity: 0.08,
                  opacity: 0.5,
                  weight: 1,
                }}
              />
            );
          })}

        {/* Route segments — thin SNR-colored hop polylines. */}
        {showPaths && tracerouteSegments.map((s) => (
          <Polyline
            key={`seg-${s.key}`}
            positions={s.positions}
            pathOptions={{ color: s.color, weight: 2, opacity: 0.85 }}
          />
        ))}

        {/* Traceroute overlay — thicker highlight on top of segments. */}
        {showRoute && tracerouteSegments.map((s) => (
          <Polyline
            key={`route-${s.key}`}
            positions={s.positions}
            pathOptions={{ color: '#facc15', weight: 4, opacity: 0.6 }}
          />
        ))}

        {/* MeshCore neighbor links — cyan dashed, resolved by public key. */}
        {meshcoreSegments.map((s) => (
          <Polyline
            key={`mc-neighbor-${s.key}`}
            positions={s.positions}
            pathOptions={{ color: '#06b6d4', weight: 1.5, opacity: s.opacity, dashArray: '6 4' }}
          />
        ))}

        {showNeighborInfo && neighborInfo
          .filter((link: any) => {
            const tc = link.transportClass ?? 'rf';
            if (tc === 'mqtt' && !showMqttNodes) return false;
            if (tc === 'udp' && !showUdpNodes) return false;
            if (tc === 'rf' && !showRfNodes) return false;
            return true;
          })
          .map((link: any, idx: number) => {
          const { nodeLatitude, nodeLongitude, neighborLatitude, neighborLongitude, bidirectional, transportClass } = link;
          if (
            nodeLatitude == null ||
            nodeLongitude == null ||
            neighborLatitude == null ||
            neighborLongitude == null
          ) {
            return null;
          }

          const positions: [number, number][] = [
            [nodeLatitude, nodeLongitude],
            [neighborLatitude, neighborLongitude],
          ];

          const tc = transportClass ?? 'rf';
          const colorByTransport = tc === 'mqtt' ? '#22c55e' : tc === 'udp' ? '#f97316' : 'blue';
          const pathOptions = bidirectional
            ? { color: colorByTransport, weight: 2, opacity: 0.6 }
            : { color: colorByTransport, weight: 1, opacity: 0.6, dashArray: '5, 5' };

          return (
            <Polyline
              key={`neighbor-link-${idx}`}
              positions={positions}
              pathOptions={pathOptions}
            />
          );
        })}
      </MapContainer>

      {/* Map Features control panel — mirrors NodesTab's "Features" panel but
          trimmed to the toggles meaningful on a cross-source map. */}
      <div className="map-controls dashboard-map-controls">
        <div className="map-controls-body">
          <div className="map-controls-title">Features</div>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showPaths}
              onChange={(e) => setShowPaths(e.target.checked)}
            />
            <span>Show Route Segments</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showRoute}
              onChange={(e) => setShowRoute(e.target.checked)}
            />
            <span>Show Traceroute</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showNeighborInfo}
              onChange={(e) => setShowNeighborInfo(e.target.checked)}
            />
            <span>Show Neighbors</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showAccuracyRegions}
              onChange={(e) => setShowAccuracyRegions(e.target.checked)}
            />
            <span>Show Accuracy Regions</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showRfNodes}
              onChange={(e) => setShowRfNodes(e.target.checked)}
            />
            <span>Show RF</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showUdpNodes}
              onChange={(e) => setShowUdpNodes(e.target.checked)}
            />
            <span>Show UDP</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showMqttNodes}
              onChange={(e) => setShowMqttNodes(e.target.checked)}
            />
            <span>Show MQTT</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showWaypoints}
              onChange={(e) => setShowWaypoints(e.target.checked)}
            />
            <span>Show Waypoints</span>
          </label>
        </div>
      </div>

      {!hasNodes && (
        <div className="dashboard-map-empty">
          <div className="dashboard-map-empty-content">
            <h3>No node positions</h3>
            <p>Select a source with nodes that have GPS positions to see them on the map.</p>
          </div>
        </div>
      )}
    </div>
  );
}
