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
import { Popup, useMap } from 'react-leaflet';
import type { PathOptions } from 'leaflet';
import L from 'leaflet';
import { createNodeIcon } from '../../utils/mapIcons';
import { markerAgeOpacity } from '../../utils/markerAgeOpacity';
import { getNodeTypeCategory } from '../../utils/nodeTypeCategory';
import { NodeMarkersLayer, type NodeMarkerDescriptor } from '../map/layers/NodeMarkersLayer';
import type { CustomTileset } from '../../config/tilesets';
import DashboardWaypoints from './DashboardWaypoints';
import DashboardAtakContacts from './DashboardAtakContacts';
import DashboardNodePopup, { type NodeSourceRef } from './DashboardNodePopup';
import DashboardNeighborPopup from './DashboardNeighborPopup';
import GeoJsonOverlay from '../GeoJsonOverlay';
import PolarGridOverlay from '../PolarGridOverlay';
import MapLegend from '../MapLegend';
import MeasureDistanceController from '../MeasureDistanceController';
import type { MeasurePoint } from '../../utils/measureDistance';
import { precisionCellBounds, hasAccuracyCell, applyPrecisionCellOffsets } from '../../utils/precisionOffset';
import { unifiedNodeKey } from '../../utils/nodeIdentity';
import type { GeoJsonLayer } from '../../server/services/geojsonService.js';
import { useMapContext } from '../../contexts/MapContext';
import { useSettings } from '../../contexts/SettingsContext';
import {
  useDashboardSources,
  useSourceStatuses,
  UNIFIED_SOURCE_ID,
  type DashboardSource,
} from '../../hooks/useDashboardData';
import { getSourceColor, resolveSourceColor } from '../../utils/sourceColors';
import { getOwnNodePositions } from '../../utils/ownNodePositions';
import { nodePassesTransportFilter } from '../../utils/nodeTransport';
import { shouldDiscardPosition } from '../../utils/nullIsland';
import { getDiscardInvalidPositions } from '../../utils/positionDisplayConfig';
import { effectiveMapMaxAgeHours } from '../../utils/mapAge';
import { resolveMapEndpoint } from '../../utils/nodeHelpers';
import api from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { BaseMap } from '../map/BaseMap';
import { MapLoadingOverlay } from '../map/MapLoadingOverlay';
import { TraceroutePathsLayer } from '../map/layers/TraceroutePathsLayer';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from '../map/layers/NeighborLinksLayer';
import { AccuracyRegionsLayer, type AccuracyRegionDescriptor } from '../map/layers/AccuracyRegionsLayer';
import { snrToNeighborOpacity, dedupByUnorderedPair } from '../../utils/neighborLinks';
import { UiIcon } from '../icons';
import {
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  buildLiveNodePositionMap,
  decomposeTraceroute,
  type TracerouteRenderSegment,
} from '../../utils/tracerouteSegments';

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
  /**
   * True while the FIRST fetch of `nodes` for the current selection is still
   * in flight (from `useDashboardSourceData`/`useDashboardUnifiedData`'s
   * `isLoading`). Shows a loading overlay instead of the "No node positions"
   * empty state so a slow initial load doesn't flash a false-empty map.
   * Defaults to false so existing callers/tests are unaffected.
   */
  isLoading?: boolean;
}

/** Extract lat/lng from a node — handles both flat (API) and nested (position) shapes. */
function getNodeLatLng(node: any): { lat: number; lng: number } | null {
  // Flat shape from API: node.latitude, node.longitude
  const lat = node?.latitude ?? node?.position?.latitude;
  const lng = node?.longitude ?? node?.position?.longitude;
  // Skip "Null Island" (0,0) — uninitialized/stale GPS default (issue #3763).
  if (lat != null && lng != null && !shouldDiscardPosition(lat, lng, undefined, getDiscardInvalidPositions())) {
    return { lat, lng };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MapBoundsUpdater — internal helper that calls fitBounds inside the map ctx
// ---------------------------------------------------------------------------

interface MapBoundsUpdaterProps {
  positions: [number, number][];
  sourceId: string | null;
  /**
   * When true, an admin has configured a Default Map Center (lat/lon/zoom), so
   * the map should open there and we must NOT auto-fit to node bounds. Mirrors
   * the per-source classic map priority in NodesTab (issue #4125).
   */
  skip: boolean;
}

function MapBoundsUpdater({ positions, sourceId, skip }: MapBoundsUpdaterProps) {
  const map = useMap();
  const hasFittedRef = useRef(false);

  useEffect(() => {
    // A configured Default Map Center wins over auto-fit (issue #4125).
    if (skip) return;
    // Only auto-fit once on initial load, then let the user control the view
    if (hasFittedRef.current) return;
    if (positions.length === 0) return;
    const bounds = L.latLngBounds(positions);
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] });
      hasFittedRef.current = true;
    }
  }, [map, positions, sourceId, skip]);

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
  isLoading = false,
}: DashboardMapProps) {
  const {
    mapPinStyle,
    setMapTileset,
    overlayColors,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
  } = useSettings();

  // A Default Map Center is only "configured" when all three parts are set.
  // When configured, the map opens there and auto-fit-to-nodes is suppressed
  // (issue #4125 — parity with NodesTab.tsx's classic per-source map).
  const hasConfiguredDefaultCenter =
    defaultMapCenterLat != null &&
    defaultMapCenterLon != null &&
    defaultMapCenterZoom != null;

  // Polar grid (#3971): draw a grid centered on each source's own-node position.
  // On the Unified map (sourceId === UNIFIED_SOURCE_ID) that's every source, each
  // in its own color with a legend; on a single-source map it's just that source.
  const { data: allSources = [] } = useDashboardSources();
  const allSourceIds = allSources.map((s: DashboardSource) => s.id);
  // Stable, sorted id list drives per-source color assignment so a source keeps
  // the same color here as on the other Unified views.
  const colorSourceIds = [...allSourceIds].sort();
  const sourceNameById = new Map<string, string>(
    allSources.map((s: DashboardSource) => [s.id, s.name] as [string, string]),
  );
  const isUnified = sourceId === UNIFIED_SOURCE_ID;
  const polarSourceIds = isUnified ? allSourceIds : sourceId ? [sourceId] : [];
  const sourceStatuses = useSourceStatuses(polarSourceIds);

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

  // Collapse the Features panel — shares the NodesTab map's localStorage key
  // so the preference is unified across every map surface (issue #3912: on
  // mobile the panel's full checkbox list has no way to be dismissed).
  const [isMapControlsCollapsed, setIsMapControlsCollapsed] = useState(
    () => localStorage.getItem('isMapControlsCollapsed') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('isMapControlsCollapsed', String(isMapControlsCollapsed));
  }, [isMapControlsCollapsed]);

  // #3636: node-to-node LOS distance measurement tool.
  const [measureActive, setMeasureActive] = useState(false);

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
    showAtakContacts,
    setShowAtakContacts,
    showPolarGrid,
    setShowPolarGrid,
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
    void (async () => {
      try {
        const data = await api.get<GeoJsonLayer[]>('/api/geojson/layers');
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
  const nodesWithTruePos = nodes
    .filter((n) => !n.isIgnored)
    .filter((n) => !n.hideFromMap) // #3549: per-node "Hide from Map" suppresses the marker only
    .filter((n) => n.isFavorite || (n.lastHeard != null && n.lastHeard >= cutoffTime))
    .filter((n) => nodePassesTransportFilter(n, { showRfNodes, showUdpNodes, showMqttNodes }, cutoffTime))
    .map((n) => ({ node: n, truePos: getNodeLatLng(n) }))
    .filter((e): e is { node: any; truePos: { lat: number; lng: number } } => e.truePos !== null);

  // #4016/#4155: offset obscured low-precision markers within their accuracy cell
  // via the shared occupancy-gated helper — lone nodes stay centered, 2+ same-cell
  // nodes spread — identical to every other map surface. `pos` (used by the marker,
  // neighbor/traceroute endpoints, and the measurement tool) thus declutters. The
  // accuracy rectangle below recomputes the TRUE center from the node, so it stays put.
  const nodesWithPosition = applyPrecisionCellOffsets(
    nodesWithTruePos.map(({ node, truePos }) => ({
      item: node,
      id: unifiedNodeKey(node) ?? String(node.nodeNum),
      latLng: [truePos.lat, truePos.lng] as [number, number],
      bits: node.positionPrecisionBits,
      isOverride: node.positionIsOverride,
    })),
  ).map(({ item: node, latLng }) => ({ node, pos: { lat: latLng[0], lng: latLng[1] } }));

  // Array form of node positions for MapBoundsUpdater (fit bounds).
  const nodePositions: [number, number][] = nodesWithPosition.map((e) => [e.pos.lat, e.pos.lng]);

  // #3636: measurement endpoints — nearest-node snapping picks from these.
  const measurePoints: MeasurePoint[] = nodesWithPosition.map(({ node, pos }) => ({
    id: String(node.nodeId ?? node.user?.id ?? node.nodeNum),
    lat: pos.lat,
    lng: pos.lng,
    label: node.shortName ?? node.user?.shortName,
  }));

  // Own-node position per source for the polar grid. Resolved from the raw
  // `nodes` prop (not the age/transport-filtered marker list) so the grid center
  // survives even when the local node is stale or filtered off the map.
  const localNodeNumBySource = new Map<string, number | null | undefined>();
  for (const id of polarSourceIds) {
    localNodeNumBySource.set(id, sourceStatuses.get(id)?.nodeNum ?? null);
  }
  const ownNodePositions = getOwnNodePositions(nodes, localNodeNumBySource);
  const hasOwnNode = ownNodePositions.length > 0;

  // nodeNum → [lat, lng] map used to resolve traceroute hop positions. The
  // unified view merges per-source node rows by nodeNum (see mergeUnifiedSourceData
  // in useDashboardData.ts), so a single lookup table works across sources.
  // NOTE: `pos` here is the #4016 marker position, which for obscured low-precision
  // nodes is the within-cell OFFSET, not the true cell center. So neighbor/
  // traceroute polylines deliberately terminate at the (jittered) marker pin —
  // keeping edges visually attached to the markers. Only the accuracy Rectangle
  // re-derives the true center (getNodeLatLng) so the cell box stays put.
  const positionByNodeNum = useMemo(
    () =>
      buildLiveNodePositionMap(nodesWithPosition, ({ node, pos }) =>
        typeof node.nodeNum === 'number' ? { nodeNum: node.nodeNum, lat: pos.lat, lng: pos.lng } : null,
      ),
    [nodesWithPosition],
  );

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
  // unordered {publicKey, neighborPublicKey} pair (shared `dedupByUnorderedPair`,
  // #4047 Phase 7 WP7) so the same link reported by multiple sources (Unified
  // view) draws once. Emits descriptors for the shared `NeighborLinksLayer` —
  // fixed cyan/dashed look preserved verbatim, no `children` (no popup).
  //
  // #4042 note: unlike the Meshtastic `neighborInfo` links below, MeshCore
  // neighbor edges (`meshcoreNeighbors`) carry no embedded per-edge lat/lng at
  // all — only `publicKey`/`neighborPublicKey`/`snr` (see meshcore_neighbor_info
  // schema + getNeighbors() repo query). Endpoints are already resolved
  // exclusively through `positionByPublicKey` (the rendered-marker-position
  // map below), so there is no stale-embedded-coordinate fallback to fix here.
  const meshcoreNeighborLinks = useMemo<NeighborLinkDescriptor[]>(() => {
    if (!showNeighborInfo) return [];
    // Untyped intermediate (publicKey/neighborPublicKey/positions/snr only —
    // no `edge` reference kept) so the dedup + descriptor steps below never
    // need an explicit `any`; matches the implicit-any the original inline
    // `for (const e of meshcoreNeighbors)` loop relied on.
    const withPositions: {
      publicKey: string;
      neighborPublicKey: string;
      a: [number, number];
      b: [number, number];
      snr: number | null;
    }[] = [];
    for (const e of (meshcoreNeighbors ?? [])) {
      const pk = e?.publicKey;
      const npk = e?.neighborPublicKey;
      if (typeof pk !== 'string' || typeof npk !== 'string') continue;
      const a = positionByPublicKey.get(pk);
      const b = positionByPublicKey.get(npk);
      if (!a || !b) continue;
      withPositions.push({ publicKey: pk, neighborPublicKey: npk, a, b, snr: e?.snr ?? null });
    }
    const deduped = dedupByUnorderedPair(
      withPositions,
      (x) => x.publicKey,
      (x) => x.neighborPublicKey,
    );
    return deduped.map(({ publicKey: pk, neighborPublicKey: npk, a, b, snr }) => {
      const pairKey = pk < npk ? `${pk}~${npk}` : `${npk}~${pk}`;
      const positions: [[number, number], [number, number]] = [a, b];
      return {
        key: `mc-neighbor-${pairKey}`,
        positions,
        pathOptions: {
          color: '#06b6d4',
          weight: 1.5,
          opacity: snrToNeighborOpacity(snr),
          dashArray: '6 4',
        },
      };
    });
  }, [meshcoreNeighbors, positionByPublicKey, showNeighborInfo]);

  // Traceroute render segments: one TracerouteRenderSegment per hop, forward
  // AND return leg, built via the shared `decomposeTraceroute`.
  // `decomposeTraceroute` internally /4-scales `snrTowards`/`snrBack` — this
  // Dashboard's raw traceroute rows carry un-scaled SNR, unlike every other
  // consumer of this data — resolves #1862 snapshot positions ahead of live
  // `positionByNodeNum`, and gates the return leg on the #2051 guard. Empty
  // unless "Show Route Segments" or "Show Traceroute" is on. Each
  // traceroute's own key is prefixed onto the util's per-hop key
  // (`"forward:123-456"`) since multiple traceroute records can repeat the
  // same node pair and the util itself only decomposes one record at a time.
  const tracerouteRenderSegments = useMemo<TracerouteRenderSegment[]>(() => {
    if (!showPaths && !showRoute) return [];
    // Map Features age slider (#3322): hide traceroutes/route segments older
    // than the chosen age. Default (slider at max) keeps the prior behavior.
    const trCutoffMs = Date.now() - effectiveMaxAge * 60 * 60 * 1000;
    const segs: TracerouteRenderSegment[] = [];
    for (const tr of (traceroutes ?? [])) {
      const trTimestamp = Number(tr?.timestamp ?? tr?.createdAt ?? 0);
      if (trTimestamp && trTimestamp < trCutoffMs) continue;
      const fromNum = Number(tr?.fromNodeNum);
      const toNum = Number(tr?.toNodeNum);
      if (!Number.isFinite(fromNum) || !Number.isFinite(toNum)) continue;
      const snapshot = parseSnapshotRoutePositions(tr?.routePositions);
      // #4162: gate on the rendered-marker map (`positionByNodeNum` is built
      // from `nodesWithPosition`, which excludes hidden/aged nodes) so route
      // segments never dangle to a node that has no marker.
      const resolvePosition = (nodeNum: number): [number, number] | null =>
        resolveSegmentPosition(nodeNum, snapshot, positionByNodeNum, true);
      const keyPrefix = `tr-${tr.sourceId ?? 'x'}-${tr.id}`;
      const decomposed = decomposeTraceroute(
        {
          fromNodeNum: fromNum,
          toNodeNum: toNum,
          route: tr?.route,
          routeBack: tr?.routeBack,
          snrTowards: tr?.snrTowards,
          snrBack: tr?.snrBack,
          timestamp: tr?.timestamp,
          createdAt: tr?.createdAt,
        },
        { resolvePosition },
      );
      for (const seg of decomposed) {
        segs.push({ ...seg, key: `${keyPrefix}-${seg.key}` });
      }
    }
    return segs;
  }, [traceroutes, positionByNodeNum, showPaths, showRoute, effectiveMaxAge]);

  const hasNodes = nodesWithPosition.length > 0;

  // Node marker descriptors for the shared NodeMarkersLayer (#4047 Phase 4,
  // WP5) — the layer owns spiderfy wiring, stable icon/position caches,
  // removal reconciliation, OMS-click popup-open, and the `_openPopup` strip
  // that used to be duplicated inline here. `key` doubles as the spiderfier
  // tracking key (prefer the cross-source identity, fall back to nodeId so
  // MeshCore (no nodeNum) and unmerged rows still register).
  const nodeMarkers: NodeMarkerDescriptor[] = nodesWithPosition.map(({ node, pos }) => {
    const hops = node.hopsAway ?? 999;
    const shortName = node.shortName ?? node.user?.shortName;
    const nodeId = node.nodeId ?? node.user?.id;
    const isRouter = node.role === 2;
    // #4075: role category drives the repeater-tower glyph for ROUTER_LATE
    // (and REPEATER), not just ROUTER. Included in iconSig below so the icon
    // cache distinguishes it from a plain client with the same hops/name.
    const roleCategory = getNodeTypeCategory(node);
    // MeshCore nodes carry nodeNum 0 (they have no meshtastic nodeNum), so the
    // `${sourceId}:${nodeNum}` scheme would collapse EVERY MeshCore node on a
    // source onto the same key — React's duplicate-key reconciliation then
    // duplicates markers and leaks them across source switches (#4234: MeshCore
    // ghost markers visible on every source's map). Key them by their public-key
    // identity instead.
    const markerKey = String(
      node.isMeshCore
        ? unifiedNodeKey(node) ?? nodeId ?? node.publicKey
        : node.sourceId != null && node.nodeNum != null
          ? `${node.sourceId}:${node.nodeNum}`
          : nodeId ?? node.nodeNum,
    );
    // #3886: fade markers by recency instead of a flat opacity — full when
    // freshly heard, fading toward a floor as lastHeard nears the age cutoff
    // (cutoffTime, seconds). Favorites bypass the age gate above so they stay
    // fully opaque regardless of age. NOTE: here a missing lastHeard yields
    // full opacity ("assume fresh"), which differs on purpose from Map
    // Analysis where a missing timestamp sits at the floor — the Dashboard
    // already age-gates upstream, so anything that reaches this loop is
    // presumed current.
    const ageOpacity = node.isFavorite
      ? 1
      : markerAgeOpacity(
          nowMs,
          cutoffTime * 1000,
          node.lastHeard != null ? node.lastHeard * 1000 : null,
        );

    return {
      key: markerKey,
      position: [pos.lat, pos.lng],
      iconSig: `${hops}|${shortName ?? ''}|${isRouter ? 1 : 0}|${roleCategory}|${node.isUnmessagable ? 1 : 0}|${mapPinStyle}`,
      buildIcon: () =>
        createNodeIcon({
          variant: 'meshtastic',
          hops,
          isSelected: false,
          isRouter,
          roleCategory,
          isUnmessagable: !!node.isUnmessagable,
          shortName,
          showLabel: true,
          pinStyle: mapPinStyle,
        }),
      opacity: ageOpacity,
      children: (
        <Popup>
          <DashboardNodePopup node={node} pos={pos} onSourceSelect={onNodeSourceSelect} />
        </Popup>
      ),
    };
  });

  // Position accuracy regions — drawn from precision_bits, mirroring NodesTab.
  // Shares the cell geometry with Map Analysis via `precisionCellBounds`. Uses
  // the shared layer's canonical gray default (#4047 Phase 7 WP7) — no
  // `pathOptions` override needed since it's byte-identical to the prior inline
  // style.
  const accuracyRegions: AccuracyRegionDescriptor[] = showAccuracyRegions
    ? nodesWithPosition
        .filter(({ node }) => hasAccuracyCell(node.positionPrecisionBits, node.positionIsOverride))
        .map(({ node }) => {
          // Center on the node's TRUE reported position, not the offset marker
          // pos, so the offset marker reads as sitting inside its cell (#4016).
          const center = getNodeLatLng(node);
          if (!center) return null;
          const bounds = precisionCellBounds(center.lat, center.lng, node.positionPrecisionBits as number);
          return {
            key: `accuracy-${node.nodeNum ?? node.nodeId ?? node.user?.id}`,
            bounds,
          };
        })
        .filter((d): d is AccuracyRegionDescriptor => d !== null)
    : [];

  // Meshtastic neighbor links, transport-filtered by the Map Features toggles.
  // Emits descriptors for the shared `NeighborLinksLayer` (#4047 Phase 7 WP7) —
  // bidirectional solid vs unidirectional dashed transport-colored look and the
  // `DashboardNeighborPopup` popup preserved verbatim.
  //
  // #4042: endpoints are resolved through `resolveMapEndpoint` against
  // `positionByNodeNum` (the same rendered-marker-position map traceroute
  // hops use, built above from `nodesWithPosition`) rather than the link's
  // own embedded lat/lng. When a node appears on multiple sources at
  // different GPS coordinates, the marker renders at the merged position,
  // but the neighbor record carries source-specific coordinates — preferring
  // the rendered marker position keeps the line's end attached to the pin.
  // The embedded coordinates remain a fallback for a node that currently has
  // no marker on the map (filtered off by age/transport/etc).
  const meshtasticNeighborLinks: NeighborLinkDescriptor[] = showNeighborInfo
    ? neighborInfo
        .filter((link: any) => {
          const tc = link.transportClass ?? 'rf';
          if (tc === 'mqtt' && !showMqttNodes) return false;
          if (tc === 'udp' && !showUdpNodes) return false;
          if (tc === 'rf' && !showRfNodes) return false;
          return true;
        })
        .map((link: any, idx: number): NeighborLinkDescriptor | null => {
          const nodeEndpoint = resolveMapEndpoint(positionByNodeNum, link.nodeNum, link.nodeLatitude, link.nodeLongitude);
          const neighborEndpoint = resolveMapEndpoint(positionByNodeNum, link.neighborNodeNum, link.neighborLatitude, link.neighborLongitude);
          // Skip if either endpoint has no resolvable position (no marker AND no embedded coords).
          if (!nodeEndpoint || !neighborEndpoint) {
            return null;
          }

          const positions: [[number, number], [number, number]] = [nodeEndpoint, neighborEndpoint];

          const tc = link.transportClass ?? 'rf';
          const colorByTransport = tc === 'mqtt' ? '#22c55e' : tc === 'udp' ? '#f97316' : 'blue';
          const pathOptions: PathOptions = link.bidirectional
            ? { color: colorByTransport, weight: 2, opacity: 0.6 }
            : { color: colorByTransport, weight: 1, opacity: 0.6, dashArray: '5, 5' };

          // Stable key by canonical node-pair (not array index) so the deduped
          // line keeps its identity across polls.
          const pairKey = link.nodeNum != null && link.neighborNodeNum != null
            ? `${Math.min(Number(link.nodeNum), Number(link.neighborNodeNum))}-${Math.max(Number(link.nodeNum), Number(link.neighborNodeNum))}`
            : `idx-${idx}`;

          return {
            key: `neighbor-link-${pairKey}`,
            positions,
            pathOptions,
            children: (
              <Popup>
                <DashboardNeighborPopup link={link} />
              </Popup>
            ),
          };
        })
        .filter((d): d is NeighborLinkDescriptor => d !== null)
    : [];

  return (
    <div className="dashboard-map-container" style={{ position: 'relative' }}>
      <BaseMap
        center={[defaultCenter.lat, defaultCenter.lng]}
        zoom={hasConfiguredDefaultCenter ? defaultMapCenterZoom : 10}
        tilesetId={tilesetId}
        customTilesets={customTilesets}
        zoomControl
        showTilesetSelector={showTileSelector}
        onTilesetChange={setMapTileset}
      >
        {measureActive && (
          <MeasureDistanceController
            active={measureActive}
            points={measurePoints}
            onExit={() => setMeasureActive(false)}
          />
        )}

        <MapBoundsUpdater positions={nodePositions} sourceId={sourceId} skip={hasConfiguredDefaultCenter} />

        {showLegend && <MapLegend />}

        {geoJsonLayers.length > 0 && <GeoJsonOverlay layers={geoJsonLayers} />}

        {/* Polar grid — one per source with a known own-node position, each in
            that source's color so overlapping grids stay distinguishable (#3971). */}
        {showPolarGrid && ownNodePositions.map((op) => (
          <PolarGridOverlay
            key={`polar-${op.sourceId}`}
            center={{ lat: op.lat, lng: op.lng }}
            color={resolveSourceColor(op.sourceId, colorSourceIds)}
          />
        ))}

        {showWaypoints && <DashboardWaypoints sourceId={sourceId} />}

        {showAtakContacts && <DashboardAtakContacts sourceId={sourceId} />}

        <NodeMarkersLayer markers={nodeMarkers} />

        {/* Position accuracy regions — shared layer, canonical gray. */}
        <AccuracyRegionsLayer regions={accuracyRegions} />

        {/* Route segments — thin SNR-colored hop polylines (shared render
            layer). MQTT/unknown-SNR hops dash and get the distinguishing
            mqttColor, matching every other traceroute renderer. */}
        {showPaths && (
          <TraceroutePathsLayer
            segments={tracerouteRenderSegments}
            snrColors={overlayColors.snrColors}
            mqttColor={overlayColors.mqttSegment}
            colorMode="snr"
            weight={2}
            opacity={0.85}
            dashMode="mqtt-unknown"
          />
        )}

        {/* Traceroute overlay — thicker fixed-yellow highlight on top of the
            segments above. Highlight, not a data encoding, so it never dashes. */}
        {showRoute && (
          <TraceroutePathsLayer
            segments={tracerouteRenderSegments}
            snrColors={overlayColors.snrColors}
            colorMode="fixed"
            fixedColor="#facc15"
            weight={4}
            opacity={0.6}
            dashMode="never"
          />
        )}

        {/* MeshCore neighbor links — cyan dashed, resolved by public key. */}
        <NeighborLinksLayer links={meshcoreNeighborLinks} />

        {/* Meshtastic neighbor links — transport-colored, bidirectional solid vs
            unidirectional dashed. */}
        <NeighborLinksLayer links={meshtasticNeighborLinks} />
      </BaseMap>

      {/* Polar grid legend — names each source whose grid is drawn, with its
          color swatch, so overlapping grids on the Unified map aren't confused. */}
      {showPolarGrid && ownNodePositions.length > 0 && (
        <div className="dashboard-polar-grid-legend" role="note" aria-label="Polar grid sources">
          <div className="dashboard-polar-grid-legend__title">Polar Grid</div>
          {ownNodePositions.map((op) => (
            <div key={`legend-${op.sourceId}`} className="dashboard-polar-grid-legend__row">
              <span
                className="dashboard-polar-grid-legend__swatch"
                style={{ background: getSourceColor(op.sourceId, colorSourceIds) }}
              />
              <span className="dashboard-polar-grid-legend__name">
                {sourceNameById.get(op.sourceId) ?? op.sourceId}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Map Features control panel — mirrors NodesTab's "Features" panel but
          trimmed to the toggles meaningful on a cross-source map. */}
      <div className={`map-controls dashboard-map-controls ${isMapControlsCollapsed ? 'collapsed' : ''}`}>
        <div className="map-controls-body">
          <div className="map-controls-header">
            <div className="map-controls-title">Features</div>
            <button
              className="map-controls-collapse-btn"
              onClick={() => setIsMapControlsCollapsed(!isMapControlsCollapsed)}
              title={isMapControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
            >
              <UiIcon name={isMapControlsCollapsed ? 'chevronDown' : 'chevronUp'} size={16} />
            </button>
          </div>
          {!isMapControlsCollapsed && (
          <>
          {/* #3636: node-to-node LOS distance measurement toggle. Needs at least
              two positioned nodes to be meaningful. */}
          <label className="map-control-item" title="Measure straight-line distance between two nodes">
            <input
              type="checkbox"
              checked={measureActive}
              disabled={measurePoints.length < 2}
              onChange={(e) => setMeasureActive(e.target.checked)}
            />
            <span>Measure Distance</span>
          </label>
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
              checked={showAtakContacts}
              onChange={(e) => setShowAtakContacts(e.target.checked)}
            />
            <span>Show ATAK Contacts</span>
          </label>
          <label className="map-control-item">
            <input
              type="checkbox"
              checked={showPolarGrid && hasOwnNode}
              disabled={!hasOwnNode}
              onChange={(e) => setShowPolarGrid(e.target.checked)}
            />
            <span title={!hasOwnNode ? 'No source has a known own-node position' : undefined}>
              Show Polar Grid
            </span>
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
          </>
          )}
        </div>
      </div>

      {isLoading && <MapLoadingOverlay />}

      {!isLoading && !hasNodes && (
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
