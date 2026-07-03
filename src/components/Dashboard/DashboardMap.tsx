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

import { useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Rectangle, useMap } from 'react-leaflet';
import L, { type Marker as LeafletMarker } from 'leaflet';
import { createNodeIcon } from '../../utils/mapIcons';
import { markerAgeOpacity } from '../../utils/markerAgeOpacity';
import { SpiderfierController, type SpiderfierControllerRef } from '../SpiderfierController';
import { getTilesetById } from '../../config/tilesets';
import type { CustomTileset, TilesetId } from '../../config/tilesets';
import DashboardWaypoints from './DashboardWaypoints';
import DashboardNodePopup, { type NodeSourceRef } from './DashboardNodePopup';
import DashboardNeighborPopup from './DashboardNeighborPopup';
import GeoJsonOverlay from '../GeoJsonOverlay';
import { TilesetSelector } from '../TilesetSelector';
import MapLegend from '../MapLegend';
import type { GeoJsonLayer } from '../../server/services/geojsonService.js';
import { useMapContext } from '../../contexts/MapContext';
import { useSettings } from '../../contexts/SettingsContext';
import { nodePassesTransportFilter } from '../../utils/nodeTransport';
import { isNullIsland } from '../../utils/nullIsland';
import { effectiveMapMaxAgeHours } from '../../utils/mapAge';
import api from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';

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
  /**
   * On the Unified map, called when a node popup's source row is clicked so the
   * page can navigate to that source's Node Details view for the node.
   */
  onNodeSourceSelect?: (source: NodeSourceRef, nodeId: string | undefined) => void;
}

/** Extract lat/lng from a node — handles both flat (API) and nested (position) shapes. */
function getNodeLatLng(node: any): { lat: number; lng: number } | null {
  // Flat shape from API: node.latitude, node.longitude
  let lat = node?.latitude ?? node?.position?.latitude;
  let lng = node?.longitude ?? node?.position?.longitude;
  // Skip "Null Island" (0,0) — uninitialized/stale GPS default (issue #3763).
  if (lat != null && lng != null && !isNullIsland(lat, lng)) {
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
  onNodeSourceSelect,
}: DashboardMapProps) {
  const tileset = getTilesetById(tilesetId, customTilesets);
  const { mapPinStyle, setMapTileset } = useSettings();

  // Spiderfier: fan out co-located markers so each node (incl. estimated-position
  // nodes that collapse onto the same anchor) is individually selectable (#3612).
  // Reuses the SAME shared SpiderfierController + tuning as the per-source NodesTab
  // map and Map Analysis. Stable per-key ref handlers bridge react-leaflet's
  // declarative <Marker> to the imperative Leaflet markers the spiderfier tracks.
  const spiderfierRef = useRef<SpiderfierControllerRef>(null);
  const markerByKey = useRef<Map<string, LeafletMarker>>(new Map());
  const refHandlers = useRef<Map<string, (m: LeafletMarker | null) => void>>(new Map());
  // Stable position/icon refs keyed by the spiderfier key — fixes the fan
  // auto-collapsing a few seconds after spiderfying (issue #3685). react-leaflet
  // only calls marker.setLatLng()/setIcon() when the prop *reference* changes,
  // and doing either on a spiderfied marker snaps it back to its anchor,
  // collapsing the fan. The unified node list refetches on every poll and
  // rebuilds these objects even when nothing actually moved, so we cache them by
  // value: an unchanged marker keeps identical refs across refreshes and the fan
  // persists. (The per-source NodesTab map solves the same churn via a memoized
  // marker.)
  const positionCacheRef = useRef<Map<string, [number, number]>>(new Map());
  const iconCacheRef = useRef<Map<string, { sig: string; icon: L.DivIcon }>>(new Map());
  const stablePosition = (key: string, lat: number, lng: number): [number, number] => {
    const cached = positionCacheRef.current.get(key);
    if (cached && cached[0] === lat && cached[1] === lng) return cached;
    const next: [number, number] = [lat, lng];
    positionCacheRef.current.set(key, next);
    return next;
  };
  const stableIcon = (key: string, sig: string, build: () => L.DivIcon): L.DivIcon => {
    const cached = iconCacheRef.current.get(key);
    if (cached && cached.sig === sig) return cached.icon;
    const icon = build();
    iconCacheRef.current.set(key, { sig, icon });
    return icon;
  };
  const getMarkerRef = (key: string) => {
    let h = refHandlers.current.get(key);
    if (!h) {
      h = (m: LeafletMarker | null) => {
        // react-leaflet forwards its ref via `useImperativeHandle(ref, () =>
        // instance)` with NO dependency array, so React bounces this callback
        // `null → instance` on EVERY re-render — not just mount/unmount.
        // Treating `null` as "removed" would call removeMarker on a still-present
        // (often spiderfied) marker on every poll/selection change, and OMS
        // auto-unspiderfies when a spiderfied marker is removed → the fan
        // collapses (issue #3685). Register on an instance only (addMarker is
        // idempotent); genuine removals are reconciled by the effect below.
        if (m) {
          markerByKey.current.set(key, m);
          spiderfierRef.current?.addMarker(m, key);
        }
      };
      refHandlers.current.set(key, h);
    }
    return h;
  };

  // Tile selector + legend overlays — hidden by default, toggled from the Map
  // Features panel. Persisted under the same localStorage keys the NodesTab map
  // uses so the preference is unified across every map surface.
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
    mapMaxAgeHours,
    setMapMaxAgeHours,
  } = useMapContext();

  // Effective map age cap from the Map Features age slider (#3322), clamped to
  // [1, maxNodeAgeHours]. null = follow the setting, so default is unchanged.
  const effectiveMaxAge = effectiveMapMaxAgeHours(mapMaxAgeHours, maxNodeAgeHours);

  // GeoJSON overlay layers (global, file-based). Fetched here so the dashboard
  // map can render and toggle them, mirroring the per-source NodesTab map.
  const csrfFetch = useCsrfFetch();
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

  // Toggle a layer's visibility and persist it (visible is global, shared with
  // the node map's control).
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

  // Build array of nodes that have valid positions, with their resolved lat/lng.
  // Mirrors NodesTab's processedNodes pipeline (App.tsx): ignored hidden, age cutoff
  // bypassed by favorites, transport-class filter from the Map Features panel.
  // Single "now" for this render so every marker's age fade (#3886) shares one
  // reference instead of drifting per-node inside the marker map loop below.
  const nowMs = Date.now();
  const cutoffTime = nowMs / 1000 - effectiveMaxAge * 60 * 60;
  const nodesWithPosition = nodes
    .filter((n) => !n.isIgnored)
    .filter((n) => !n.hideFromMap) // #3549: per-node "Hide from Map" suppresses the marker only
    .filter((n) => n.isFavorite || (n.lastHeard != null && n.lastHeard >= cutoffTime))
    .filter((n) => nodePassesTransportFilter(n, { showRfNodes, showUdpNodes, showMqttNodes }))
    .map((n) => ({ node: n, pos: getNodeLatLng(n) }))
    .filter((entry): entry is { node: any; pos: { lat: number; lng: number } } => entry.pos !== null);

  const nodePositions: [number, number][] = nodesWithPosition.map((e) => [e.pos.lat, e.pos.lng]);

  // Genuine removals (a node aged out / filtered away) are reconciled here
  // rather than from the ref `null` bounce (see getMarkerRef): drop any tracked
  // marker whose key is no longer rendered, and unregister it from the
  // spiderfier. Keyed off the rendered key SET so it only does work when
  // membership actually changes — must match the markerKey used in the JSX.
  const renderedKeysSig = nodesWithPosition
    .map(({ node }) => {
      const nodeId = node.nodeId ?? node.user?.id;
      return String(
        node.sourceId != null && node.nodeNum != null
          ? `${node.sourceId}:${node.nodeNum}`
          : nodeId ?? node.nodeNum,
      );
    })
    .join('|');
  useEffect(() => {
    const rendered = new Set(renderedKeysSig ? renderedKeysSig.split('|') : []);
    for (const key of [...markerByKey.current.keys()]) {
      if (rendered.has(key)) continue;
      const m = markerByKey.current.get(key);
      if (m) spiderfierRef.current?.removeMarker(m);
      markerByKey.current.delete(key);
      refHandlers.current.delete(key);
      positionCacheRef.current.delete(key);
      iconCacheRef.current.delete(key);
    }
  }, [renderedKeysSig]);

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
    // Map Features age slider (#3322): hide traceroutes/route segments older
    // than the chosen age. Default (slider at max) keeps the prior behavior.
    const trCutoffMs = Date.now() - effectiveMaxAge * 60 * 60 * 1000;
    const segs: Array<{
      key: string;
      positions: [number, number][];
      color: string;
    }> = [];
    for (const tr of (traceroutes ?? [])) {
      const trTimestamp = Number(tr?.timestamp ?? tr?.createdAt ?? 0);
      if (trTimestamp && trTimestamp < trCutoffMs) continue;
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
  }, [traceroutes, positionByNodeNum, showPaths, showRoute, effectiveMaxAge]);

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

        <SpiderfierController ref={spiderfierRef} />

        <MapBoundsUpdater positions={nodePositions} sourceId={sourceId} />

        {showLegend && <MapLegend />}

        {geoJsonLayers.length > 0 && <GeoJsonOverlay layers={geoJsonLayers} />}

        {showWaypoints && <DashboardWaypoints sourceId={sourceId} />}

        {nodesWithPosition.map(({ node, pos }) => {
          const hops = node.hopsAway ?? 999;
          const shortName = node.shortName ?? node.user?.shortName;
          const nodeId = node.nodeId ?? node.user?.id;
          const isRouter = node.role === 2;
          // Stable spiderfier key — prefer the cross-source identity, fall back to
          // nodeId so MeshCore (no nodeNum) and unmerged rows still register.
          const markerKey = String(
            node.sourceId != null && node.nodeNum != null
              ? `${node.sourceId}:${node.nodeNum}`
              : nodeId ?? node.nodeNum,
          );
          // Reuse the cached icon/position unless an input actually changed, so a
          // poll that returns identical data doesn't churn the marker and collapse
          // any active spiderfy fan.
          const iconSig = `${hops}|${shortName ?? ''}|${isRouter ? 1 : 0}|${mapPinStyle}`;
          const icon = stableIcon(markerKey, iconSig, () =>
            createNodeIcon({
              hops,
              isSelected: false,
              isRouter,
              shortName,
              showLabel: true,
              pinStyle: mapPinStyle,
            }),
          );
          // #3886: fade markers by recency instead of a flat opacity — full when
          // freshly heard, fading toward a floor as lastHeard nears the age
          // cutoff (cutoffTime, seconds). Favorites bypass the age gate above so
          // they stay fully opaque regardless of age. NOTE: here a missing
          // lastHeard yields full opacity ("assume fresh"), which differs on
          // purpose from Map Analysis where a missing timestamp sits at the
          // floor — the Dashboard already age-gates upstream, so anything that
          // reaches this loop is presumed current.
          const ageOpacity = node.isFavorite
            ? 1
            : markerAgeOpacity(
                nowMs,
                cutoffTime * 1000,
                node.lastHeard != null ? node.lastHeard * 1000 : null,
              );

          return (
            <Marker
              key={nodeId}
              ref={getMarkerRef(markerKey)}
              position={stablePosition(markerKey, pos.lat, pos.lng)}
              icon={icon}
              opacity={ageOpacity}
            >
              <Popup>
                <DashboardNodePopup node={node} pos={pos} onSourceSelect={onNodeSourceSelect} />
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

          // Stable key by canonical node-pair (not array index) so the deduped
          // line keeps its identity across polls.
          const pairKey = link.nodeNum != null && link.neighborNodeNum != null
            ? `${Math.min(Number(link.nodeNum), Number(link.neighborNodeNum))}-${Math.max(Number(link.nodeNum), Number(link.neighborNodeNum))}`
            : `idx-${idx}`;

          return (
            <Polyline
              key={`neighbor-link-${pairKey}`}
              positions={positions}
              pathOptions={pathOptions}
            >
              <Popup>
                <DashboardNeighborPopup link={link} />
              </Popup>
            </Polyline>
          );
        })}
      </MapContainer>

      {showTileSelector && (
        <TilesetSelector
          selectedTilesetId={tilesetId as TilesetId}
          onTilesetChange={setMapTileset}
        />
      )}

      {/* Map Features control panel — mirrors NodesTab's "Features" panel but
          trimmed to the toggles meaningful on a cross-source map. */}
      <div className="map-controls dashboard-map-controls">
        <div className="map-controls-body">
          <div className="map-controls-title">Features</div>
          {/* Map Features age slider (#3322): hides node markers, traceroutes,
              and route segments older than the chosen age. Ranges 1h–maxNodeAge. */}
          {(() => {
            const maxHours = Math.max(1, Math.round(maxNodeAgeHours));
            const currentHours = Math.min(Math.max(1, Math.round(effectiveMaxAge)), maxHours);
            const formatDuration = (hours: number): string => {
              if (hours >= maxHours) return 'All';
              if (hours < 24) return `${hours}h`;
              const days = Math.floor(hours / 24);
              const remainingHours = hours % 24;
              return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
            };
            return (
              <div className="map-control-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }}>
                <span>Maximum age</span>
                <div className="position-history-slider">
                  <input
                    type="range"
                    min={1}
                    max={maxHours}
                    value={currentHours}
                    aria-label="Maximum age"
                    aria-valuemin={1}
                    aria-valuemax={maxHours}
                    aria-valuenow={currentHours}
                    aria-valuetext={formatDuration(currentHours)}
                    disabled={maxHours <= 1}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10);
                      setMapMaxAgeHours(value >= maxHours ? null : value);
                    }}
                  />
                  <span className="slider-value">{formatDuration(currentHours)}</span>
                </div>
              </div>
            );
          })()}
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
          {/* GeoJSON overlay layers — per-layer on/off, mirroring NodesTab. */}
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
