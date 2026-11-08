import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LeafletEvent, Marker as LeafletMarker } from 'leaflet';
import { Popup, Tooltip, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings, useDisplaySettings } from '../../contexts/SettingsContext';
import { useBaseMapSettings } from '../map/useBaseMapSettings';
import {
  getNodeTypeCategory,
  categoryGlyphFamily,
  nodePassesTypeFilter,
  type NodeTypeCategory,
} from '../../utils/nodeTypeCategory';
import { createNodeIcon } from '../map/markerIcons';
import { BaseMap } from '../map/BaseMap';
import { PacketFlightsLayer } from '../map/layers/PacketFlightsLayer';
import DuctingLayer from '../map/layers/DuctingLayer';
import { useMapContextOptional } from '../../contexts/MapContext';
import type { FlightNodeEntry, PacketFlightStats } from '../../utils/packetFlightEdges';
import { MapLoadingOverlay } from '../map/MapLoadingOverlay';
import { NodeMarkersLayer, type NodeMarkerDescriptor } from '../map/layers/NodeMarkersLayer';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from '../map/layers/NeighborLinksLayer';
import PolarGridOverlay from '../PolarGridOverlay';
import { useSource } from '../../contexts/SourceContext';
import { useAuth } from '../../contexts/AuthContext';
import { NodeMarkerCluster } from '../map/layers/NodeMarkerCluster';
import { CrossSourceLinksLayer } from '../map/layers/CrossSourceLinksLayer';
import { LocalMarkers } from '../map/layers/MapMarkersLayer';
import LocalMarkerPlacementBridge from '../map/LocalMarkerPlacementBridge';
import LocalMarkerAuthoringUi from '../map/LocalMarkerAuthoringUi';
import { MapInstanceBridge } from '../map/MapInstanceBridge';
import { Map3DView } from '../map/Map3DView';
import type { Node3DFeature } from '../map/Base3DMap';
import { AssetPlaybackBar } from '../map/AssetPlaybackBar';
import { MeshCoreMapControls } from './MeshCoreMapControls';
import { useLocalMarkerAuthoring } from '../../hooks/useLocalMarkerAuthoring';
import { useMap3DToggle } from '../../hooks/useMap3DToggle';
import { indexAtOrBefore, shouldShowAssetPlayback } from '../../utils/trackPlayback';
import { resolveClusterZoomThreshold, resolveClusteredMapCenterTargetZoom } from '../../utils/mapZoomAnimation';
import type L from 'leaflet';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { shouldDiscardPosition } from '../../utils/nullIsland';
import { getDiscardInvalidPositions } from '../../utils/positionDisplayConfig';
import { getPositionHistoryColor } from '../../utils/mapHelpers';
import api from '../../services/api';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import GeoJsonOverlay from '../GeoJsonOverlay';
import type { GeoJsonLayer } from '../../server/services/geojsonService.js';
import {
  isHiddenByPositionlessAdvert,
  readHidePositionlessAdverts,
  writeHidePositionlessAdverts,
} from '../../utils/meshcoreAdvertPosition';
import MeasureDistanceController from '../MeasureDistanceController';
import type { MeasurePoint } from '../../utils/measureDistance';
import { NodeCard } from '../map/popups/NodeCard';
import { toNodeCardModel } from '../map/popups/nodeCardModel';
import { MeshCoreDetails, LastHeardFooter, NodeActions, type NodeActionSpec } from '../map/popups/sections';
import { hopCountLabel } from '../../utils/hopLabel';

const MESHCORE_COLOR = '#cba6f7';
const NEIGHBOR_COLOR = '#06b6d4';
const DEFAULT_CENTER: [number, number] = [0, 0];
const DEFAULT_ZOOM = 2;
/** Selected-contact zoom before the cluster-gate raise. */
const SELECTED_CONTACT_ZOOM = 12;
/** Cross-source link window: the server default (24 h). MeshCore contacts are
 *  age-filtered upstream, so this map has no window of its own. */
const CROSS_SOURCE_LOOKBACK_HOURS = 24;

/** One stored position fix; timestamps feed the playback bar. */
interface HistoryFix {
  latitude: number;
  longitude: number;
  /** ms since the epoch. */
  timestamp: number;
}

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

interface NeighborEdge {
  publicKey: string;
  neighborPublicKey: string;
  nodeName: string | null;
  neighborName: string | null;
  snr: number | null;
}

interface MeshCoreMapProps {
  /**
   * Contacts to render. Already age-filtered by the caller
   * (MeshCoreNodesView applies the per-source `maxNodeAgeHours` with the
   * favorite / local-node exemptions before passing them down — #4412 Phase 4
   * §3.4). This component does NOT filter by age; a future second caller must
   * filter upstream too.
   */
  contacts: MeshCoreContact[];
  selectedPublicKey: string | null;
  localNodePosition?: { lat: number; lng: number } | null;
  onNavigateToDm?: (publicKey: string) => void;
  /**
   * True while the FIRST contacts snapshot fetch is still in flight (see
   * `useMeshCore`'s `hasLoadedOnce`). Shows a loading overlay so a slow
   * initial connect doesn't render an apparently-empty world map before
   * contacts have a chance to arrive. Defaults to false so existing
   * callers/tests are unaffected.
   */
  isLoading?: boolean;
  /**
   * Forwarded to `BaseMap`'s `resizeTrigger` (issue: mobile node-list
   * collapse toggle). When this value changes, the underlying Leaflet map
   * calls `invalidateSize()` so the canvas fills its new container size
   * after the list pane collapses/expands or the mobile list↔map pane swap
   * fires — otherwise the map can render at its stale size (grey/blank
   * edges) until the next manual resize. Omit ⇒ no resize handler mounted
   * (matches BaseMap's own opt-in default).
   */
  resizeTrigger?: unknown;
  /**
   * #5964: open this node's popup once its marker is on the map, then call
   * `onPendingPopupHandled`. Set by Node Details' Show on Map. The popup
   * opens at most once per request: the map drops the key as soon as it
   * opens it, so a later remount or re-render does not reopen it.
   */
  pendingPopupPublicKey?: string | null;
  /** Called once the pending popup has opened, or once it is clear the map
   *  will not draw that node. The owner should clear the pending key. */
  onPendingPopupHandled?: () => void;
  /**
   * #6258: per-node marker opacity (age dimming), keyed by public key. Missing
   * keys render at full opacity. Routed through `NodeMarkerDescriptor.opacity`,
   * never `iconSig`, so a dimming change does not rebuild icons (#3685).
   */
  markerOpacityByKey?: ReadonlyMap<string, number>;
}

export const MeshCoreMap: React.FC<MeshCoreMapProps> = ({
  contacts,
  selectedPublicKey,
  localNodePosition,
  onNavigateToDm,
  isLoading = false,
  resizeTrigger,
  pendingPopupPublicKey = null,
  onPendingPopupHandled,
  markerOpacityByKey,
}) => {
  const {
    mapTileset,
    setMapTileset,
    mapZoomGateThreshold,
    mapClusteringEnabled,
    distanceUnit,
  } = useSettings();
  const baseMapSettings = useBaseMapSettings();
  const { timeFormat, dateFormat } = useDisplaySettings();
  const { sourceId } = useSource();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const [showPaths, setShowPaths] = useState(true);
  const [showNeighbors, setShowNeighbors] = useState(true);
  // #3636: node-to-node LOS distance measurement tool.
  const [measureActive, setMeasureActive] = useState(false);
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

  // Position-history trail overlay (#3852) — the MeshCore analogue of the
  // Meshtastic node-motion trail. Toggle + window length are per-browser
  // (localStorage), matching the other MeshCore map toggles. The window length
  // is clamped to the backend's rolling retention (7 days); points older than
  // that are swept server-side and simply won't be returned.
  const [showPositionHistory, setShowPositionHistory] = useState(
    () => localStorage.getItem('meshmonitor-meshcore-showPositionHistory') === 'true',
  );
  const [positionHistoryHours, setPositionHistoryHours] = useState<number>(() => {
    const raw = localStorage.getItem('meshmonitor-meshcore-positionHistoryHours');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(n, 168) : 24;
  });
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-showPositionHistory', String(showPositionHistory));
  }, [showPositionHistory]);
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-positionHistoryHours', String(positionHistoryHours));
  }, [positionHistoryHours]);
  // publicKey -> ordered (oldest→newest) [lat, lng] trail points.
  // #5578: hide nodes whose latest advert had no position. Per browser
  // (localStorage), default off; the Dashboard map reads the same key.
  const [hidePositionlessAdverts, setHidePositionlessAdverts] = useState(readHidePositionlessAdverts);
  useEffect(() => {
    writeHidePositionlessAdverts(hidePositionlessAdverts);
  }, [hidePositionlessAdverts]);

  const [positionHistory, setPositionHistory] = useState<Map<string, HistoryFix[]>>(new Map());

  // Live packet traffic (#4835). Same per-browser keys as MapContext uses for
  // the other maps (this map sits outside a MapProvider). Off by default;
  // the rate defaults to all (0).
  const [showPacketFlights, setShowPacketFlights] = useState(() => {
    try {
      return localStorage.getItem('showPacketFlights') === 'true';
    } catch {
      return false;
    }
  });
  const [packetFlightRate, setPacketFlightRate] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('packetFlightRate'));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  });
  const [packetFlightsStats, setPacketFlightsStats] = useState<PacketFlightStats | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('showPacketFlights', String(showPacketFlights));
      localStorage.setItem('packetFlightRate', String(packetFlightRate));
    } catch {
      // storage unavailable: the toggle still works for this session
    }
  }, [showPacketFlights, packetFlightRate]);

  // Tropospheric ducting overlay (#5972). The same toggle and step as the
  // other maps: MeshCoreSourcePage wraps this map in a MapProvider. The local
  // fallback only serves a bare render (component tests) with no provider.
  const mapContext = useMapContextOptional();
  const [localShowDucting, setLocalShowDucting] = useState(false);
  const [localDuctingHoursAhead, setLocalDuctingHoursAhead] = useState(0);
  const showDucting = mapContext?.showDucting ?? localShowDucting;
  const setShowDucting = mapContext?.setShowDucting ?? setLocalShowDucting;
  const ductingHoursAhead = mapContext?.ductingHoursAhead ?? localDuctingHoursAhead;
  const setDuctingHoursAhead = mapContext?.setDuctingHoursAhead ?? setLocalDuctingHoursAhead;

  // Local markers (#5686) and cross-source links (#5561): the shared MapContext
  // toggles, with a local fallback for a bare render with no provider.
  const [localShowLocalMarkers, setLocalShowLocalMarkers] = useState(true);
  const [localShowCrossSourceLinks, setLocalShowCrossSourceLinks] = useState(false);
  const showLocalMarkers = mapContext?.showLocalMarkers ?? localShowLocalMarkers;
  const setShowLocalMarkers = mapContext?.setShowLocalMarkers ?? setLocalShowLocalMarkers;
  const showCrossSourceLinks = mapContext?.showCrossSourceLinks ?? localShowCrossSourceLinks;
  const setShowCrossSourceLinks = mapContext?.setShowCrossSourceLinks ?? setLocalShowCrossSourceLinks;

  // Local marker authoring: same per-source grant as waypoints.
  const canWriteLocalMarkers = Boolean(sourceId) && hasPermission('waypoints', 'write');
  const markerAuthoring = useLocalMarkerAuthoring(sourceId, canWriteLocalMarkers);

  // 2D/3D toggle (#4704), shared with NodesTab and DashboardMap.
  const { canUse3D, viewMode, setViewMode, effective3D, basemap3D, terrainTileUrl } = useMap3DToggle(
    baseMapSettings.tilesetId,
    baseMapSettings.customTilesets,
    baseMapSettings.cartoApiKey,
  );

  // Marker clustering (#5284/#5404): the same resolution NodesTab uses.
  const clusterZoomThreshold = resolveClusterZoomThreshold(mapZoomGateThreshold, mapClusteringEnabled);

  // Polar grid overlay (#4047 follow-up) — the same shared range-ring/azimuth-
  // sector grid NodesTab/DashboardMap/Map Analysis draw, centered on the LOCAL
  // MeshCore node's position. Persisted per-browser like the other MeshCore
  // map toggles above (MeshCoreMap doesn't sit inside a `MapProvider`, so it
  // can't reuse MapContext's server-persisted `showPolarGrid`).
  const [showPolarGrid, setShowPolarGrid] = useState(
    () => localStorage.getItem('meshmonitor-meshcore-showPolarGrid') === 'true',
  );
  useEffect(() => {
    localStorage.setItem('meshmonitor-meshcore-showPolarGrid', String(showPolarGrid));
  }, [showPolarGrid]);

  // Server-side rolling retention window (days) for stored trail points. This
  // is a global setting (`meshcore_position_history_retention_days`, default 7)
  // — points older than this are swept server-side. Loaded once; saved via the
  // shared /api/settings endpoint (requires settings:write, like the packet
  // monitor's max-age control).
  const [retentionDays, setRetentionDays] = useState(7);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.get<Record<string, string>>('/api/settings');
        const raw = settings?.meshcore_position_history_retention_days;
        const n = raw ? parseInt(raw, 10) : NaN;
        if (!cancelled && Number.isFinite(n) && n > 0) setRetentionDays(n);
      } catch {
        // best-effort: fall back to the default display value
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const saveRetentionDays = (days: number) => {
    const clamped = Math.max(1, Math.min(365, Math.round(days)));
    setRetentionDays(clamped);
    api.getBaseUrl().then(baseUrl => {
      csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meshcore_position_history_retention_days: String(clamped) }),
      }).catch(err => console.error('Failed to save position-history retention:', err));
    }).catch(err => console.error('Failed to get base URL:', err));
  };

  // GeoJSON overlay layers (global, file-based) — fetched and toggled here so
  // the MeshCore map matches the NodesTab and Dashboard maps. Layer visibility
  // is global and shared with those maps' controls.
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

  // Seam for estimated positions (#6260 WP5): merge estimated contacts into
  // `contacts` here, ahead of this filter, so markers, lines, 3D and the node
  // type filter all see them.
  const positioned = useMemo(
    () => contacts.filter(c =>
      typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude)
      // Skip bogus positions: "Null Island" (0,0) GPS defaults (issue #3763)
      // AND out-of-range junk MeshCore adverts carry (e.g. lat 1853, lng -1598)
      // that would blow the map's fit-bounds out to nothing. The DB store
      // filters these too, but live in-memory contacts reaching the map via
      // getAllNodes() can still carry them.
      && !shouldDiscardPosition(c.latitude, c.longitude, undefined, getDiscardInvalidPositions())),
    [contacts],
  );

  // Markers visible after the node-type filter. Paths/neighbor lines keep using
  // `positioned` so the filter only hides markers — matching the Map Analysis
  // workspace, where the type filter never removes route/neighbor overlays.
  // #5578: the same split applies to "hide nodes without a current position
  // advert" — the marker goes, the lines stay. The local node is never hidden.
  const visibleContacts = useMemo(
    () => positioned.filter(c =>
      nodePassesTypeFilter({ advType: c.advType }, nodeTypeFilter)
      && (c.isLocal === true || !isHiddenByPositionlessAdvert(c, hidePositionlessAdverts))),
    [positioned, nodeTypeFilter, hidePositionlessAdverts],
  );

  // #4835: flights resolve against the contacts this map draws a marker for.
  const packetFlightNodes: FlightNodeEntry[] = useMemo(
    () => (showPacketFlights
      ? visibleContacts.map(c => ({ publicKey: c.publicKey, lat: c.latitude as number, lng: c.longitude as number }))
      : []),
    [showPacketFlights, visibleContacts],
  );

  // #3636: measurement endpoints — nearest-node snapping picks from these.
  const measurePoints: MeasurePoint[] = useMemo(
    () => visibleContacts.map(c => ({
      id: c.publicKey,
      lat: c.latitude as number,
      lng: c.longitude as number,
      label: c.advName || c.name,
    })),
    [visibleContacts],
  );

  // Node-marker descriptors for the shared `NodeMarkersLayer` (#4047 Phase 4,
  // WP4). `iconSig`/`buildIcon` mirror the pre-migration `stableIcon(publicKey,
  // \`${name}|${category}\`, () => makeIcon(name, category))` recipe exactly —
  // `variant:'meshcore'` is the moved `makeIcon` body verbatim, so output is
  // pixel-identical. Popup/Tooltip content (Phase 5, unchanged) stays here as
  // `children`.
  //
  // #5964 pending popup (Node Details → Show on Map). Mirrors Meshtastic's
  // `pendingCenterNodeNum`: the request survives the BaseMap remount that
  // selecting a node causes (the remount is keyed on center/zoom), and the
  // marker's Leaflet `add` event opens the popup on whichever mount draws it.
  // A ref, not state, so the `markers` memo does not rebuild when it changes.
  // Synced in a layout effect: react-leaflet adds markers in passive effects,
  // and every layout effect of a commit runs before any passive one.
  const pendingPopupRef = useRef<string | null>(pendingPopupPublicKey);
  const onPendingPopupHandledRef = useRef(onPendingPopupHandled);
  useLayoutEffect(() => {
    pendingPopupRef.current = pendingPopupPublicKey;
  }, [pendingPopupPublicKey]);
  useLayoutEffect(() => {
    onPendingPopupHandledRef.current = onPendingPopupHandled;
  }, [onPendingPopupHandled]);
  const openPendingPopup = useCallback((publicKey: string, e: LeafletEvent) => {
    if (pendingPopupRef.current !== publicKey) return;
    // Drop the request before opening, so a later remount or re-render of
    // this marker cannot open the popup a second time.
    pendingPopupRef.current = null;
    (e.target as LeafletMarker).openPopup();
    onPendingPopupHandledRef.current?.();
  }, []);
  // The map does not draw the requested node (filtered out by node type, the
  // #5578 toggle or the caller's age filter): drop the request so it cannot
  // fire on a later, unrelated selection of that node.
  useEffect(() => {
    if (!pendingPopupPublicKey || isLoading) return;
    if (visibleContacts.some(c => c.publicKey === pendingPopupPublicKey)) return;
    pendingPopupRef.current = null;
    onPendingPopupHandledRef.current?.();
  }, [pendingPopupPublicKey, isLoading, visibleContacts]);

  // One popup body for the 2D `<Popup>` and the 3D maplibre popup.
  const renderContactPopup = useCallback((c: MeshCoreContact) => {
    const model = toNodeCardModel(c, 'meshcore');
    const actions: NodeActionSpec[] = onNavigateToDm
      ? [{ kind: 'navigate-to-dm', onClick: () => onNavigateToDm(c.publicKey) }]
      : [];
    return (
      <NodeCard
        model={model}
        sections={
          <>
            <div className="node-popup-grid">
              <MeshCoreDetails model={model} />
            </div>
            <LastHeardFooter lastHeard={model.lastHeard} firstHeard={model.firstHeard} mode="absolute" timeFormat={timeFormat} dateFormat={dateFormat} />
          </>
        }
        actions={<NodeActions actions={actions} />}
      />
    );
  }, [onNavigateToDm, timeFormat, dateFormat]);

  const markers: NodeMarkerDescriptor[] = useMemo(
    () => visibleContacts.map(c => {
      const name = c.advName || c.name || 'MeshCore';
      const category = getNodeTypeCategory({ advType: c.advType });
      return {
        key: c.publicKey,
        position: [c.latitude!, c.longitude!] as [number, number],
        iconSig: `${name}|${category}`,
        opacity: markerOpacityByKey?.get(c.publicKey) ?? 1,
        buildIcon: () =>
          createNodeIcon({
            variant: 'meshcore',
            fixedColor: MESHCORE_COLOR,
            roleCategory: category,
            labelName: name,
          }),
        eventHandlers: { add: (e: LeafletEvent) => openPendingPopup(c.publicKey, e) },
        children: (
          <>
            <Tooltip>
              <strong>{name}</strong>
              {typeof c.rssi === 'number' && <><br />RSSI: {c.rssi} dBm</>}
              {typeof c.snr === 'number' && <><br />SNR: {c.snr} dB</>}
              {typeof c.pathLen === 'number' && <><br />Path: {hopCountLabel(c.pathLen)}</>}
            </Tooltip>
            <Popup>{renderContactPopup(c)}</Popup>
          </>
        ),
      };
    }),
    [visibleContacts, renderContactPopup, openPendingPopup, markerOpacityByKey],
  );

  const localPos = useMemo((): [number, number] | null => {
    if (localNodePosition?.lat != null && localNodePosition?.lng != null) {
      return [localNodePosition.lat, localNodePosition.lng];
    }
    const local = positioned.find(c => c.isLocal === true);
    if (local) return [local.latitude!, local.longitude!];
    return null;
  }, [localNodePosition, positioned]);

  // DIVERGENT-BY-DESIGN (#4047 Phase 7, §5.1): a star topology from the local
  // node to every contact, colored AND dashed by `pathLen` (hop count). No
  // other map draws local→node lines keyed on path-length — this is the
  // MeshCore-only "hop-count concept" the Phase-7 spec confirmed divergent
  // (not a duplicate of the neighbor-link promotion below, which renders
  // peer↔peer edges, not local→node hop paths). Left inline, not promoted.
  const pathSegments = useMemo(() => {
    if (!showPaths || !localPos) return [];
    return positioned
      .filter(c => c.isLocal !== true && typeof c.pathLen === 'number')
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

  // Fetch movement trails for the currently-positioned, visible nodes whenever
  // the overlay is on (or its window changes). One request per node against
  // `/nodes/:publicKey/position-history?since=`; cheap because the set of
  // positioned nodes is small and the backend dedupes stationary fixes. When
  // the overlay is off we drop the cache so re-enabling refetches fresh.
  const historyKeysSig = visibleContacts.map(c => c.publicKey).join('|');
  useEffect(() => {
    if (!showPositionHistory || !sourceId) {
      setPositionHistory(new Map());
      return;
    }
    let cancelled = false;
    const keys = historyKeysSig ? historyKeysSig.split('|') : [];
    const since = Date.now() - positionHistoryHours * 60 * 60 * 1000;
    void (async () => {
      const next = new Map<string, HistoryFix[]>();
      await Promise.all(keys.map(async (publicKey) => {
        try {
          const resp = await api.get<{
            success: boolean;
            data: { latitude: number; longitude: number; timestamp: number }[];
          }>(`/api/sources/${sourceId}/meshcore/nodes/${publicKey}/position-history?since=${since}`);
          if (resp.success && Array.isArray(resp.data)) {
            // Drop Null Island fixes first, then keep only trails with enough
            // real points to draw a segment (a 2-point response that's all
            // Null Island would otherwise store a degenerate 1-point trail).
            // Timestamps stay: the playback bar needs them.
            const pts = resp.data
              .filter(p => !shouldDiscardPosition(p.latitude, p.longitude, undefined, getDiscardInvalidPositions()))
              .map(p => ({ latitude: p.latitude, longitude: p.longitude, timestamp: Number(p.timestamp) }))
              .filter(p => Number.isFinite(p.timestamp))
              .sort((a, b) => a.timestamp - b.timestamp);
            if (pts.length >= 2) next.set(publicKey, pts);
          }
        } catch {
          // best-effort: a failed trail fetch shouldn't break the map
        }
      }));
      if (!cancelled) setPositionHistory(next);
    })();
    return () => { cancelled = true; };
  }, [showPositionHistory, positionHistoryHours, sourceId, historyKeysSig]);

  // Per-node trail segments, colored oldest→newest like the Meshtastic trail.
  // DIVERGENT-BY-DESIGN (#4047 Phase 7, §5.3): unlike NodesTab's single-
  // selected-node rich trail (spline/points-only/arrows/per-segment popups)
  // and MapAnalysis's `PositionTrailsLayer` (many nodes, one hash-colored
  // polyline each, no age gradient), this is MeshCore's own third form —
  // many nodes, arrowless age-gradient segments, reusing only the shared
  // `getPositionHistoryColor` helper. Not a candidate for promotion; the
  // three forms would have to fuse genuinely different features to share
  // rendering. Left inline per the Phase-2 divergence verdict (unchanged).
  // Playback (#5354 Phase 3 shell, shared with NodesTab): shown for the selected
  // contact while Show Position History is on and it holds 2+ fixes. 2D only.
  const selectedFixes = useMemo(
    () => (selectedPublicKey ? positionHistory.get(selectedPublicKey) ?? [] : []),
    [selectedPublicKey, positionHistory],
  );
  const showPlayback = !effective3D && Boolean(selectedPublicKey) && shouldShowAssetPlayback({
    isAsset: true,
    assetTrackLoaded: true,
    showPositionHistory,
    fixCount: selectedFixes.length,
  });
  const [playbackTrailCursor, setPlaybackTrailCursor] = useState<number | null>(null);
  const [playbackMap, setPlaybackMap] = useState<L.Map | null>(null);
  // Cut by fix INDEX so the ~5 Hz cursor only rebuilds polylines on a new fix.
  const trailCutIndex = showPlayback && playbackTrailCursor !== null
    ? indexAtOrBefore(selectedFixes, playbackTrailCursor)
    : null;

  const historySegments = useMemo(() => {
    if (!showPositionHistory) return [];
    const segs: { key: string; positions: [number, number][]; color: string }[] = [];
    for (const [publicKey, allPoints] of positionHistory) {
      const fixes = publicKey === selectedPublicKey && trailCutIndex !== null
        ? allPoints.slice(0, trailCutIndex + 1)
        : allPoints;
      const points = fixes.map(f => [f.latitude, f.longitude] as [number, number]);
      if (points.length < 2) continue;
      const segCount = points.length - 1;
      for (let i = 0; i < segCount; i++) {
        segs.push({
          key: `hist-${publicKey}-${i}`,
          positions: [points[i], points[i + 1]],
          color: getPositionHistoryColor(i, segCount),
        });
      }
    }
    return segs;
  }, [showPositionHistory, positionHistory, selectedPublicKey, trailCutIndex]);

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

  // Neighbor-link descriptors for the shared `NeighborLinksLayer` (#4047
  // Phase 7, WP8). PURE REFACTOR — `pathOptions`/`children` reproduce the
  // pre-migration fixed cyan style and sticky tooltip verbatim (MeshCoreMap
  // is a "fixed style" consumer: unlike DashboardMap/NodesTab it does not
  // vary opacity by SNR). No `arrows` (MeshCore-only today).
  const neighborLinks: NeighborLinkDescriptor[] = useMemo(
    () => neighborSegments.map((s) => ({
      key: s.key,
      positions: [s.from, s.to],
      pathOptions: { color: NEIGHBOR_COLOR, weight: 1.5, opacity: 0.7, dashArray: '6 4' },
      children: <Tooltip sticky>{s.label}</Tooltip>,
    })),
    [neighborSegments],
  );

  const { center, zoom } = useMemo(() => {
    if (selectedPublicKey) {
      const sel = positioned.find(c => c.publicKey === selectedPublicKey);
      if (sel) return { center: [sel.latitude!, sel.longitude!] as [number, number], zoom: resolveClusteredMapCenterTargetZoom(SELECTED_CONTACT_ZOOM, clusterZoomThreshold) };
    }
    if (positioned.length > 0) {
      const c = positioned[0];
      return { center: [c.latitude!, c.longitude!] as [number, number], zoom: 10 };
    }
    return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
  }, [positioned, selectedPublicKey, clusterZoomThreshold]);

  // 3D surface inputs (#4704): the same visible contacts the 2D markers use.
  const node3DFeatures: Node3DFeature[] = useMemo(
    () => visibleContacts.map(c => ({
      key: c.publicKey,
      lat: c.latitude as number,
      lng: c.longitude as number,
      label: c.advName || c.name || undefined,
      color: MESHCORE_COLOR,
      category: categoryGlyphFamily(getNodeTypeCategory({ advType: c.advType })),
      opacity: markerOpacityByKey?.get(c.publicKey) ?? 1,
    })),
    [visibleContacts, markerOpacityByKey],
  );
  const visible3DMeshCoreKeys = useMemo(
    () => new Set(visibleContacts.map(c => c.publicKey)),
    [visibleContacts],
  );
  const contactByKey = useMemo(
    () => new Map(visibleContacts.map(c => [c.publicKey, c] as const)),
    [visibleContacts],
  );

  return (
    <div className="meshcore-map-pane" style={{ position: 'relative' }}>
      {effective3D ? (
        // #4704: 3D terrain surface. Nodes, neighbor lines and cross-source
        // edges only (no traceroutes: MeshCore has none in `traceroutes`).
        <Map3DView
          key={`3d-${center[0]}-${center[1]}-${zoom}`}
          center={center}
          zoom={zoom}
          basemap={basemap3D}
          terrainTileUrl={terrainTileUrl}
          nodes={node3DFeatures}
          // An empty list means "all sources" to the 3D hooks, so a map with no
          // source gates its edges off instead.
          sourceIds={sourceId ? [sourceId] : []}
          showNeighbors={showNeighbors && Boolean(sourceId)}
          showTraceroutes={false}
          showCrossSourceLinks={showCrossSourceLinks && Boolean(sourceId)}
          lookbackHours={CROSS_SOURCE_LOOKBACK_HOURS}
          visibleMeshCoreKeys={visible3DMeshCoreKeys}
          renderPopup={(key) => {
            const c = contactByKey.get(key);
            return c ? renderContactPopup(c) : null;
          }}
          onUnsupported={() => setViewMode('2d')}
        />
      ) : (
      /* Caller-keyed remount (#4047 Phase 7, §3.3): MeshCoreMap force-fits by
          remounting the whole shell on center/zoom change (e.g. selecting a
          node) rather than an imperative flyTo — same effect as the
          pre-migration `<MapContainer key={...}>`, moved to key the BaseMap
          element itself. */
      <BaseMap
        key={`${center[0]}-${center[1]}-${zoom}`}
        center={center}
        zoom={zoom}
        {...baseMapSettings}
        resizeTrigger={resizeTrigger}
      >
        <MapInstanceBridge onMap={setPlaybackMap} />
        {measureActive && (
          <MeasureDistanceController
            active={measureActive}
            points={measurePoints}
            onExit={() => setMeasureActive(false)}
          />
        )}
        {geoJsonLayers.length > 0 && <GeoJsonOverlay layers={geoJsonLayers} />}
        {showPolarGrid && localPos && (
          <PolarGridOverlay center={{ lat: localPos[0], lng: localPos[1] }} />
        )}
        <LocalMarkerPlacementBridge placing={markerAuthoring.placing} onPick={markerAuthoring.pickSpot} />
        {showLocalMarkers && sourceId && (
          <LocalMarkers sourceId={sourceId} actions={markerAuthoring.actions} />
        )}
        {clusterZoomThreshold != null ? (
          <NodeMarkerCluster disableClusteringAtZoom={clusterZoomThreshold}>
            <NodeMarkersLayer markers={markers} />
          </NodeMarkerCluster>
        ) : (
          <NodeMarkersLayer markers={markers} />
        )}

        {historySegments.map(s => (
          <Polyline
            key={s.key}
            positions={s.positions}
            pathOptions={{ color: s.color, weight: 3, opacity: 0.8 }}
          />
        ))}

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

        <NeighborLinksLayer links={neighborLinks} />

        {/* Cross-source "heard here" edges (#5561): mounted only while on, so
            it fetches nothing when off. The server applies the two-source rule. */}
        {showCrossSourceLinks && sourceId && (
          <CrossSourceLinksLayer
            enabled
            sourceIds={[sourceId]}
            lookbackHours={CROSS_SOURCE_LOOKBACK_HOURS}
          />
        )}

        {/* Live packet traffic (#4835): mounted only while on. */}
        {showPacketFlights && sourceId && (
          <PacketFlightsLayer
            sourceIds={[sourceId]}
            nodes={packetFlightNodes}
            maxPerSecond={packetFlightRate}
            onStatsChange={setPacketFlightsStats}
          />
        )}

        {/* Tropospheric ducting overlay (#5972): mounted only while on. The
            area comes from this source's own nodes (`sourceId`), since the
            default area holds only Meshtastic nodes. */}
        {showDucting && sourceId && (
          <DuctingLayer hoursAhead={ductingHoursAhead} sourceId={sourceId} />
        )}
      </BaseMap>
      )}

      {showPlayback && selectedPublicKey && (
        <AssetPlaybackBar
          fixes={selectedFixes}
          map={playbackMap}
          resetKey={selectedPublicKey}
          timeFormat={timeFormat}
          dateFormat={dateFormat}
          distanceUnit={distanceUnit ?? 'km'}
          onTrailCursorChange={setPlaybackTrailCursor}
        />
      )}

      {isLoading && <MapLoadingOverlay />}

      <LocalMarkerAuthoringUi authoring={markerAuthoring} />

      <MeshCoreMapControls
        sourceId={sourceId}
        effective3D={effective3D}
        canUse3D={canUse3D}
        viewMode={viewMode}
        setViewMode={setViewMode}
        measureActive={measureActive}
        setMeasureActive={setMeasureActive}
        measurePointCount={measurePoints.length}
        showPaths={showPaths}
        setShowPaths={setShowPaths}
        showNeighbors={showNeighbors}
        setShowNeighbors={setShowNeighbors}
        showCrossSourceLinks={showCrossSourceLinks}
        setShowCrossSourceLinks={setShowCrossSourceLinks}
        showLocalMarkers={showLocalMarkers}
        setShowLocalMarkers={setShowLocalMarkers}
        canWriteLocalMarkers={canWriteLocalMarkers}
        placingLocalMarker={markerAuthoring.placing}
        onAddLocalMarker={() => {
          markerAuthoring.setPlacing(true);
          if (!showLocalMarkers) setShowLocalMarkers(true);
        }}
        showPacketFlights={showPacketFlights}
        setShowPacketFlights={setShowPacketFlights}
        packetFlightRate={packetFlightRate}
        setPacketFlightRate={setPacketFlightRate}
        packetFlightsStats={packetFlightsStats}
        showDucting={showDucting}
        setShowDucting={setShowDucting}
        ductingHoursAhead={ductingHoursAhead}
        setDuctingHoursAhead={setDuctingHoursAhead}
        showPositionHistory={showPositionHistory}
        setShowPositionHistory={setShowPositionHistory}
        positionHistoryHours={positionHistoryHours}
        setPositionHistoryHours={setPositionHistoryHours}
        retentionDays={retentionDays}
        setRetentionDays={setRetentionDays}
        saveRetentionDays={saveRetentionDays}
        hidePositionlessAdverts={hidePositionlessAdverts}
        setHidePositionlessAdverts={setHidePositionlessAdverts}
        showPolarGrid={showPolarGrid}
        setShowPolarGrid={setShowPolarGrid}
        hasLocalPosition={localPos !== null}
        showTileSelector={showTileSelector}
        setShowTileSelector={setShowTileSelector}
        showLegend={showLegend}
        setShowLegend={setShowLegend}
        mapTileset={mapTileset}
        setMapTileset={setMapTileset}
        nodeTypeFilter={nodeTypeFilter}
        setNodeTypeEnabled={setNodeTypeEnabled}
        geoJsonLayers={geoJsonLayers}
        toggleGeoJsonLayer={toggleGeoJsonLayer}
      />
    </div>
  );
};
