import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/nodes.css';
import { Popup, Tooltip, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Marker as LeafletMarker } from 'leaflet';
import { DeviceInfo } from '../types/device';
import { TabType } from '../types/ui';
import { nodePassesTransportFilter, transportCutoffSec } from '../utils/nodeTransport';
import { getNodeTypeCategory, categoryGlyphFamily } from '../utils/nodeTypeCategory';
import { effectiveMapMaxAgeHours } from '../utils/mapAge';
import { ageFilterStops, nearestAgeStopIndex, formatAgeStop } from '../utils/mapAgeSteps';
import { downsamplePositionHistory, MAX_RENDERED_POSITION_POINTS } from '../utils/positionHistoryDownsample';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { getPositionHistoryColor, generateHeadingAwarePath, generatePositionHistoryArrows, snrToColor } from '../utils/mapHelpers.tsx';
import { convertSpeed } from '../utils/speedConversion';
import { getEffectivePosition, getRoleName, hasValidEffectivePosition, isNodeComplete, parseNodeId, resolveMapEndpoint, resolveMarkerCenterTarget, TRACEROUTE_DISPLAY_HOURS } from '../utils/nodeHelpers';
import { applyPrecisionCellOffsets, hasAccuracyCell, precisionCellBounds } from '../utils/precisionOffset';
import { unifiedNodeKey } from '../utils/nodeIdentity';
import MapLegend from './MapLegend';
import { MapSidebar } from './map/MapSidebar';
import { formatTime, formatDateTime } from '../utils/datetime';
import { getDistanceToNode, calculateDistance, formatDistance } from '../utils/distance';
import { getTilesetById } from '../config/tilesets';
import { getEffectiveHops, getMapHoverTooltipMeta } from '../utils/nodeHops';
import { buildNodeExportRows, nodesToCsv, nodesToHtml, downloadTextFile } from '../utils/nodeExport';
import { useMapContext } from '../contexts/MapContext';
import { useTelemetryNodes, useDeviceConfig, useNodes, useChannels, setNodeFieldInCache } from '../hooks/useServerData';
import { useQueryClient } from '@tanstack/react-query';
import { useUI } from '../contexts/UIContext';
import { useSettings } from '../contexts/SettingsContext';
import { nodeColorStyle } from '../utils/nodeColor';
import { useAuth } from '../contexts/AuthContext';
import { useSource } from '../contexts/SourceContext';
import DashboardWaypoints from './Dashboard/DashboardWaypoints';
import DashboardAtakContacts from './Dashboard/DashboardAtakContacts';
import WaypointEditorModal from './WaypointEditorModal';
import { useWaypoints } from '../hooks/useWaypoints';
import type { Waypoint, WaypointInput } from '../types/waypoint';
import { useResizable } from '../hooks/useResizable';
import { resolveNodeSidebarMaxWidth, isMobileLayout, NODE_SIDEBAR_MIN_WIDTH_PX } from '../utils/sidebarWidth';
import ZoomHandler from './ZoomHandler';
import MapPositionHandler from './MapPositionHandler';
import PolarGridOverlay from './PolarGridOverlay.js';
import GeoJsonOverlay from './GeoJsonOverlay';
import { NodeMarkersLayer, type NodeMarkerDescriptor } from './map/layers/NodeMarkersLayer';
import MeasureDistanceController from './MeasureDistanceController';
import type { MeasurePoint } from '../utils/measureDistance';
import { MapCenterController } from './MapCenterController';
import PacketMonitorPanel from './PacketMonitorPanel';
import { getPacketStats } from '../services/packetApi';

import { BaseMap } from './map/BaseMap';
import { Map3DView } from './map/Map3DView';
import DashboardNodePopup from './Dashboard/DashboardNodePopup';
import type { Node3DFeature } from './map/Base3DMap';
import { TilesetSelector } from './TilesetSelector';
import { resolve3DBasemap, buildTerrainTileUrl } from '../config/basemap3d';
import { useTerrainCapabilities } from '../hooks/useTerrainCapabilities';
import { appBasename } from '../init';
import { MapLoadingOverlay } from './map/MapLoadingOverlay';
import { MapModeIndicator } from './map/MapModeIndicator';
import { NodeUnmessageableBadge } from './NodeUnmessageableBadge';
import { NodeIncompleteBadge } from './NodeIncompleteBadge';
import { NodeDetailsButton } from './NodeDetailsButton';
import nodeRowStyles from './NodeRowActions.module.css';
import nodeStatusStyles from './NodeStatusLine.module.css';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from './map/layers/NeighborLinksLayer';
import { AccuracyRegionsLayer, type AccuracyRegionDescriptor } from './map/layers/AccuracyRegionsLayer';
import { NodeCard } from './map/popups/NodeCard';
import { IdentityItems, SignalItems, LastHeardFooter, TracerouteBody, NodeActions, type NodeActionSpec } from './map/popups/sections';
import { toNodeCardModel, type NodeCardModel } from './map/popups/nodeCardModel';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import api from '../services/api';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';
import { CopyNodeInfoModal } from './CopyNodeInfoModal';
import { UiIcon } from './icons';
import { useToast } from './ToastContainer';
import { logger } from '../utils/logger';

interface NodesTabProps {
  processedNodes: DeviceInfo[];
  shouldShowData: () => boolean;
  centerMapOnNode: (node: DeviceInfo) => void;
  toggleFavorite: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  toggleFavoriteLock?: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  setActiveTab: (tab: TabType) => void;
  setSelectedDMNode: (nodeId: string) => void;
  /** Select a node for a new DM and ask the DM view to focus its compose box (#4325). */
  openDmForCompose: (nodeId: string) => void;
  markerRefs: React.MutableRefObject<Map<string, LeafletMarker>>;
  traceroutePathsElements: React.ReactNode;
  selectedNodeTraceroute: React.ReactNode;
  /** Set of visible node numbers for filtering neighbor info segments (Issue #1149) */
  visibleNodeNums?: Set<number>;
  /** Set of node numbers involved in the selected traceroute (for filtering map markers) */
  tracerouteNodeNums?: Set<number> | null;
  /** Bounding box of the selected traceroute for zoom-to-fit */
  tracerouteBounds?: [[number, number], [number, number]] | null;
  /** Handler for initiating a traceroute to a node */
  onTraceroute?: (nodeId: string) => void;
  /** Current connection status */
  connectionStatus?: string;
  /** TX disabled on this source (epic #4294 Phase 2) — ORed into the traceroute run button's disabled state. */
  txDisabled?: boolean;
  /**
   * Pre-computed tooltip for disabled TX controls (#4547 Phase 2 WP5). App.tsx
   * picks the MeshCore receive-only wording or the Meshtastic LoRa-config
   * wording based on source type. Optional — falls back to
   * `t('tx_disabled.control_tooltip')` at each call site when omitted, so
   * existing callers/tests are unaffected.
   */
  txDisabledTooltip?: string;
  /** Node ID currently being tracerouted (for loading state) */
  tracerouteLoading?: string | null;
  /** Handler for deleting a node from local database */
  onDeleteNode?: (nodeNum: number) => void;
  /** Handler for purging a node from device and local database */
  onPurgeNodeFromDevice?: (nodeNum: number) => void;
}

// Helper function to check if a date is today
const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
};

// Helper function to calculate node opacity based on last heard time
const calculateNodeOpacity = (
  lastHeard: number | undefined,
  enabled: boolean,
  startHours: number,
  minOpacity: number,
  maxNodeAgeHours: number
): number => {
  if (!enabled || !lastHeard) return 1;

  const now = Date.now();
  const lastHeardMs = lastHeard * 1000;
  const ageHours = (now - lastHeardMs) / (1000 * 60 * 60);

  // No dimming if node was heard within the start threshold
  if (ageHours <= startHours) return 1;

  // Calculate opacity linearly from 1 at startHours to minOpacity at maxNodeAgeHours
  const dimmingRange = maxNodeAgeHours - startHours;
  if (dimmingRange <= 0) return 1;

  const ageInDimmingRange = ageHours - startHours;
  const dimmingProgress = Math.min(1, ageInDimmingRange / dimmingRange);

  // Linear interpolation from 1 to minOpacity
  return 1 - (dimmingProgress * (1 - minOpacity));
};

// Memoized distance display component to avoid recalculating on every render
const DistanceDisplay = React.memo<{
  homeNode: DeviceInfo | undefined;
  targetNode: DeviceInfo;
  distanceUnit: 'km' | 'mi';
  t: (key: string) => string;
}>(({ homeNode, targetNode, distanceUnit, t }) => {
  const distance = React.useMemo(
    () => getDistanceToNode(homeNode, targetNode, distanceUnit),
    [homeNode?.position?.latitude, homeNode?.position?.longitude,
     targetNode.position?.latitude, targetNode.position?.longitude, distanceUnit]
  );

  if (!distance) return null;

  return (
    <span className="stat" title={t('nodes.distance')}>
      <UiIcon name="ruler" size={14} /> {distance}
    </span>
  );
});

// Separate components for traceroutes that can update independently
// These prevent marker re-renders when only the traceroute paths change
// Renamed from TraceroutePathsLayer/SelectedTracerouteLayer (#4047 Phase 7
// WP13) — those names shadowed the shared `map/layers/TraceroutePathsLayer`;
// these are thin pass-through wrappers of pre-built nodes, not that layer.
const TraceroutePathsContainer = React.memo<{ paths: React.ReactNode; enabled: boolean }>(
  ({ paths }) => {
    return <>{paths}</>;
  }
);

const SelectedTracerouteContainer = React.memo<{ traceroute: React.ReactNode; enabled: boolean }>(
  ({ traceroute }) => {
    return <>{traceroute}</>;
  }
);

/**
 * NodesTab's neighbor-link SNR encoding (#4047 Phase 7 WP11): a 4-tier
 * weight/opacity table plus a uniform amber color (`overlayColors.neighborLine`),
 * unlike the shared `NeighborLinksLayer`'s other consumers, which use the
 * continuous `snrToNeighborOpacity` curve (`utils/neighborLinks.ts`) — the two
 * are deliberately NOT unified (spec §4.1: "NodesTab uses a different 4-tier
 * SNR→weight/opacity table — that stays in the NodesTab adapter"). Direction
 * arrows are unidirectional-only, matching the shared layer's `arrows` gate.
 * Extracted as a pure function (module-scope, exported) so this table and the
 * arrow gate can be pinned with a unit test independent of the full
 * component render.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #4047 pure helper co-located with its only consumer for adapter unit testing; not a component
export function computeNeighborLinkStyle(
  snr: number | null,
  isBidirectional: boolean,
  lineColor: string,
): { pathOptions: L.PathOptions; arrows?: { color: string } } {
  let weight: number;
  let opacity: number;
  if (snr != null) {
    if (snr > 10) { weight = 4; opacity = 0.85; }
    else if (snr >= 0) { weight = 3; opacity = 0.6; }
    else { weight = 2; opacity = 0.4; }
  } else { weight = 2; opacity = 0.3; }

  return {
    pathOptions: {
      color: lineColor,
      weight,
      opacity,
      dashArray: isBidirectional ? undefined : '5, 5',
    },
    arrows: isBidirectional ? undefined : { color: lineColor },
  };
}

/**
 * Traceroute run-button gating for the map node popup (epic #4294 Phase 2).
 * Extracted as a pure function (module-scope, exported) — the popup lives
 * inside a Leaflet Popup/Marker/MapContainer tree that isn't practical to
 * fully render in jsdom (see NodesTab.test.tsx's helper-only pattern), so
 * the gating logic is pinned with a unit test independent of the render.
 */
// eslint-disable-next-line react-refresh/only-export-components -- #4294 pure helper co-located with its only consumer for adapter unit testing; not a component
export function isTracerouteRunDisabled(
  connectionStatus: string | undefined,
  tracerouteLoading: string | null | undefined,
  nodeUserId: string | undefined,
  txDisabled: boolean,
): boolean {
  return connectionStatus !== 'connected' || tracerouteLoading === nodeUserId || txDisabled;
}

/**
 * Controller that applies the configured default map center once server settings load.
 * Only acts when there was no saved localStorage position at mount time (new session / anonymous).
 * The configured default takes priority over auto-calculated node positions.
 */
const DefaultCenterController: React.FC<{
  lat: number | null;
  lon: number | null;
  zoom: number | null;
}> = ({ lat, lon, zoom }) => {
  const map = useMap();
  const applied = useRef(false);
  // Capture whether localStorage had a saved map position at mount time.
  // MapPositionHandler updates mapCenter immediately on mount, so we can't
  // rely on the current mapCenter value — check localStorage directly.
  const hadSavedPosition = useRef(localStorage.getItem('mapCenter') !== null);

  useEffect(() => {
    logger.debug('[DefaultCenterController] effect fired', {
      applied: applied.current,
      hadSaved: hadSavedPosition.current,
      lat, lon, zoom,
    });
    if (applied.current || hadSavedPosition.current) return;
    if (lat !== null && lon !== null && zoom !== null) {
      logger.debug('[DefaultCenterController] applying configured default', lat, lon, zoom);
      applied.current = true;
      map.setView([lat, lon], zoom, { animate: false });
    }
  }, [map, lat, lon, zoom]);

  return null;
};

/**
 * Zooms the map to fit every positioned node (#4496).
 *
 * The button lives in `.map-controls`, a SIBLING of MapContainer with no access
 * to the map instance. Rather than plumb the instance outward, this follows the
 * same shape as TracerouteBoundsController below — a controller inside the map
 * reacting to a prop. `request` is a monotonically increasing counter so
 * repeated clicks re-fit even when the node set hasn't changed; a boolean would
 * only ever fire once.
 */
const FitAllNodesController: React.FC<{
  request: number;
  positions: Array<[number, number]>;
}> = ({ request, positions }) => {
  const map = useMap();
  const lastHandled = useRef(0);

  useEffect(() => {
    if (request === 0 || request === lastHandled.current) return;
    lastHandled.current = request;
    if (positions.length === 0) return;

    if (positions.length === 1) {
      // fitBounds on zero-area bounds snaps to max zoom; centring reads better.
      map.setView(positions[0], Math.max(map.getZoom(), 14), { animate: true });
      return;
    }

    map.fitBounds(positions, {
      padding: [50, 50],
      animate: true,
      duration: 0.5,
      // Matches TracerouteBoundsController: a tight cluster shouldn't slam to
      // street level.
      maxZoom: 15,
    });
  }, [request, positions, map]);

  return null;
};

/**
 * Controller component that zooms the map to fit the traceroute bounds
 * Must be placed inside MapContainer to access the map instance
 */
const TracerouteBoundsController: React.FC<{
  bounds: [[number, number], [number, number]] | null | undefined;
}> = ({ bounds }) => {
  const map = useMap();
  const prevBoundsRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bounds) {
      prevBoundsRef.current = null;
      return;
    }

    // Create a string key for the bounds to detect changes
    const boundsKey = JSON.stringify(bounds);

    // Only zoom if bounds actually changed (prevents re-zoom on every render)
    if (boundsKey !== prevBoundsRef.current) {
      prevBoundsRef.current = boundsKey;

      // Use fitBounds to zoom to show the entire traceroute
      map.fitBounds(bounds, {
        padding: [50, 50], // Add padding around the bounds
        animate: true,
        duration: 0.5,
        maxZoom: 15, // Don't zoom in too close for short routes
      });
    }
  }, [bounds, map]);

  return null;
};

/**
 * WaypointMapEventBridge — captures map clicks for waypoint authoring.
 *
 * - When `placing` is true, the next left-click drops a pin at the click
 *   location and exits placement mode.
 * - Right-click anywhere (when `canCreate`) opens the editor with that
 *   location seeded as the new waypoint's coordinates.
 *
 * Toggles the `waypoint-placing` class on the leaflet container. That class
 * drives the crosshair cursor AND (issue #4342) makes interactive overlay
 * geometry click-through, so the pick below always wins over a feature popup —
 * see the rule in WaypointEditorModal.css for why that is load-bearing.
 */
const WaypointMapEventBridge: React.FC<{
  placing: boolean;
  canCreate: boolean;
  onPick: (lat: number, lon: number) => void;
}> = ({ placing, canCreate, onPick }) => {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (placing) {
      container.classList.add('waypoint-placing');
      // A popup left open from a previous click floats above the map with its
      // own pointer-events, so it would eat the placement click (#4342).
      map.closePopup();
    } else {
      container.classList.remove('waypoint-placing');
    }
    return () => container.classList.remove('waypoint-placing');
  }, [placing, map]);

  useEffect(() => {
    if (!canCreate) return;
    const handleClick = (e: any) => {
      if (!placing) return;
      const { lat, lng } = e.latlng;
      onPick(lat, lng);
    };
    const handleContextMenu = (e: any) => {
      const { lat, lng } = e.latlng;
      onPick(lat, lng);
    };
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);
    return () => {
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
    };
  }, [map, placing, canCreate, onPick]);

  return null;
};

const NodesTabComponent: React.FC<NodesTabProps> = ({
  processedNodes,
  shouldShowData,
  centerMapOnNode,
  toggleFavorite,
  toggleFavoriteLock,
  setActiveTab,
  setSelectedDMNode,
  openDmForCompose,
  markerRefs,
  traceroutePathsElements,
  selectedNodeTraceroute,
  visibleNodeNums,
  tracerouteNodeNums,
  tracerouteBounds,
  onTraceroute,
  connectionStatus,
  txDisabled = false,
  txDisabledTooltip,
  tracerouteLoading,
  onDeleteNode,
  onPurgeNodeFromDevice,
}) => {
  const { t } = useTranslation();
  // Use context hooks
  const {
    showPaths,
    setShowPaths,
    showNeighborInfo,
    setShowNeighborInfo,
    showRoute,
    setShowRoute,
    showMotion,
    setShowMotion,
    positionHistoryPointsOnly,
    setPositionHistoryPointsOnly,
    showMqttNodes,
    setShowMqttNodes,
    showUdpNodes,
    setShowUdpNodes,
    showRfNodes,
    setShowRfNodes,
    showWaypoints,
    setShowWaypoints,
    showAtakContacts,
    setShowAtakContacts,
    showAnimations,
    setShowAnimations,
    showEstimatedPositions,
    setShowEstimatedPositions,
    showAccuracyRegions,
    setShowAccuracyRegions,
    showPolarGrid,
    setShowPolarGrid,
    animatedNodes,
    triggerNodeAnimation,
    mapCenterTarget,
    setMapCenterTarget,
    mapCenter,
    mapZoom,
    setMapZoom,
    selectedNodeId,
    setSelectedNodeId,
    neighborInfo,
    positionHistory,
    traceroutes,
    positionHistoryHours,
    setPositionHistoryHours,
    mapMaxAgeHours,
    setMapMaxAgeHours,
  } = useMapContext();

  const { currentNodeId } = useDeviceConfig();
  // `isLoading` reflects TanStack Query's pending state for the shared poll
  // query — true only until the FIRST poll response resolves (success or
  // error), regardless of how many nodes come back. That's exactly "first
  // fetch unresolved", so no new plumbing is needed beyond reading it here.
  const { nodes, isLoading: nodesIsLoading } = useNodes();

  // Compute own node position for polar grid overlay (needs to be at component scope)
  const ownHomeNode = nodes.find(n => n.user?.id === currentNodeId);
  const ownNodePosition = ownHomeNode?.position?.latitude && ownHomeNode?.position?.longitude
    ? { lat: ownHomeNode.position.latitude, lng: ownHomeNode.position.longitude }
    : null;

  // Debounce ref for hover mouseout to prevent flicker from tooltip interaction
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up hover timeout on unmount to prevent firing against stale DOM
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const {
    nodesWithTelemetry,
    nodesWithWeather: nodesWithWeatherTelemetry,
    nodesWithEstimatedPosition,
    nodesWithPKC,
    unmappedCount,
    estimatedUncertainty,
  } = useTelemetryNodes();

  const {
    nodesNodeFilter,
    setNodesNodeFilter,
    securityFilter,
    channelFilter,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    showNodeFilterPopup,
    setShowNodeFilterPopup,
    isNodeListCollapsed,
    setIsNodeListCollapsed,
    filterRemoteAdminOnly,
  } = useUI();

  const { sourceId: currentSourceId } = useSource();

  const {
    timeFormat,
    dateFormat,
    mapTileset,
    setMapTileset,
    mapPinStyle,
    nodeListStyle,
    customTilesets,
    distanceUnit,
    positionHistoryLineStyle,
    nodeDimmingEnabled,
    nodeDimmingStartHours,
    nodeDimmingMinOpacity,
    maxNodeAgeHours,
    nodeHopsCalculation,
    // #4412 Phase 3: moved here from UIContext with the rest of the
    // per-source Node Display group.
    showIncompleteNodes,
    neighborInfoMinZoom,
    overlayColors,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapCenterTargetZoom,
    mapStyles,
    activeStyleId,
    activeStyleJson,
    setActiveMapStyleId,
  } = useSettings();

  // Effective map age cap from the Map Features age slider (#3322), clamped to
  // [1, maxNodeAgeHours]. null = follow the setting, so default behavior is
  // unchanged. Used to hide stale node markers on the map (favorites bypass).
  const effectiveMapMaxAge = effectiveMapMaxAgeHours(mapMaxAgeHours, maxNodeAgeHours);
  // #4240: single clock read per render for transport decay (see
  // transportCutoffSec) — a per-node call would drift across the filter pass.
  const transportCutoff = transportCutoffSec(effectiveMapMaxAge);
  const mapAgeCutoffSeconds = Date.now() / 1000 - effectiveMapMaxAge * 60 * 60;

  const { hasPermission } = useAuth();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  // ----- Copy NodeInfo modal state -----
  const [copyNodeInfoTarget, setCopyNodeInfoTarget] = useState<DeviceInfo | null>(null);

  // ----- Security warning clear state (#4302) -----
  const queryClient = useQueryClient();
  const [clearingSecurityNode, setClearingSecurityNode] = useState<number | null>(null);
  const handleClearSecurityWarning = useCallback(async (nodeNum: number) => {
    setClearingSecurityNode(nodeNum);
    try {
      await api.post(`/api/security/nodes/${nodeNum}/clear`, { sourceId: currentSourceId });
      // Optimistically drop the flags in the poll cache so the warning icon
      // disappears immediately instead of lingering until the next poll (#4302).
      setNodeFieldInCache(queryClient, currentSourceId, nodeNum, {
        keyIsLowEntropy: false,
        duplicateKeyDetected: false,
        keyMismatchDetected: false,
        keySecurityIssueDetails: undefined,
      });
      showToast(t('nodes.security_risk_cleared', 'Security warning cleared'), 'success');
    } catch {
      showToast(t('nodes.security_risk_clear_failed', 'Failed to clear security warning'), 'error');
    } finally {
      setClearingSecurityNode(null);
    }
  }, [currentSourceId, queryClient, showToast, t]);

  // ----- Waypoint authoring state -----
  const canWriteWaypoints = hasPermission('waypoints', 'write');
  // Channels come from the poll cache, which is already keyed on the active
  // source — so the picker only ever offers the waypoint's own source (#4341).
  const { channels: sourceChannels } = useChannels();
  const waypointMutations = useWaypoints(currentSourceId);
  const [waypointEditorOpen, setWaypointEditorOpen] = useState(false);
  const [waypointEditorInitial, setWaypointEditorInitial] = useState<Waypoint | null>(null);
  const [waypointDefaultCoords, setWaypointDefaultCoords] = useState<
    { lat: number; lon: number } | null
  >(null);
  const [placingWaypoint, setPlacingWaypoint] = useState(false);

  const startCreateAtCoords = useCallback((lat: number, lon: number) => {
    setWaypointEditorInitial(null);
    setWaypointDefaultCoords({ lat, lon });
    setWaypointEditorOpen(true);
    setPlacingWaypoint(false);
  }, []);

  const startCreateBlank = useCallback(() => {
    setPlacingWaypoint(true);
  }, []);

  const handleEditWaypoint = useCallback((wp: Waypoint) => {
    setWaypointEditorInitial(wp);
    setWaypointDefaultCoords(null);
    setWaypointEditorOpen(true);
    setPlacingWaypoint(false);
  }, []);

  const handleDeleteWaypoint = useCallback(
    async (wp: Waypoint) => {
      const label = wp.name || `Waypoint ${wp.waypointId}`;
      if (!window.confirm(`Delete "${label}"? This will be broadcast to the mesh.`)) return;
      try {
        await waypointMutations.remove.mutateAsync(wp.waypointId);
      } catch (err: any) {
        window.alert(`Failed to delete waypoint: ${err?.message ?? 'unknown error'}`);
      }
    },
    [waypointMutations.remove],
  );

  const handleSaveWaypoint = useCallback(
    async (input: WaypointInput) => {
      if (waypointEditorInitial) {
        await waypointMutations.update.mutateAsync({
          waypointId: waypointEditorInitial.waypointId,
          input,
        });
      } else {
        await waypointMutations.create.mutateAsync(input);
      }
    },
    [waypointEditorInitial, waypointMutations.create, waypointMutations.update],
  );

  // Esc cancels waypoint placement mode (modal Esc handled by Modal component).
  useEffect(() => {
    if (!placingWaypoint) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlacingWaypoint(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placingWaypoint]);

  const localNodeNum = currentNodeId ? parseNodeId(currentNodeId) : null;
  const lockedToOther = useCallback(
    (wp: Waypoint) =>
      Boolean(wp.lockedTo && localNodeNum != null && wp.lockedTo !== localNodeNum),
    [localNodeNum],
  );
  const waypointActions = useMemo(
    () => ({
      canEdit: canWriteWaypoints,
      canDelete: canWriteWaypoints,
      onEdit: (wp: Waypoint) => {
        if (lockedToOther(wp)) return;
        handleEditWaypoint(wp);
      },
      onDelete: (wp: Waypoint) => {
        if (lockedToOther(wp)) return;
        void handleDeleteWaypoint(wp);
      },
    }),
    [canWriteWaypoints, lockedToOther, handleEditWaypoint, handleDeleteWaypoint],
  );

  // Parse current node ID to get node number for effective hops calculation
  const currentNodeNum = currentNodeId ? parseNodeId(currentNodeId) : null;

  // Memoize filtered position history to avoid recomputation on every render
  const filteredPositionHistory = useMemo(() => {
    if (!showMotion || positionHistory.length < 2) return [];
    if (positionHistoryHours != null) {
      return positionHistory.filter(p => p.timestamp >= Date.now() - (positionHistoryHours * 60 * 60 * 1000));
    }
    return positionHistory;
  }, [showMotion, positionHistory, positionHistoryHours]);

  /**
   * Trail actually drawn, bounded to `MAX_RENDERED_POSITION_POINTS` (#4743).
   *
   * A node using estimated positions is relocated every time a neighbour
   * reports, so its history reaches thousands of fixes — one `<Polyline>` plus
   * one rich `<Popup>` each, which froze the UI for about a minute on mobile.
   * A time window alone does not bound this: even 24 hours of estimated
   * positions can hold thousands of entries.
   *
   * `filteredPositionHistory` stays the source of truth for the legend's time
   * span, so the reported oldest/newest remain exact while the drawing is
   * capped.
   */
  const renderedPositionHistory = useMemo(
    () => downsamplePositionHistory(filteredPositionHistory, MAX_RENDERED_POSITION_POINTS),
    [filteredPositionHistory],
  );

  /** True when the drawn trail omits intermediate fixes — surfaced in the popup. */
  const positionHistoryDownsampled = renderedPositionHistory.length < filteredPositionHistory.length;

  // Memoize position history legend data for MapLegend
  const positionHistoryLegendData = useMemo(() => {
    if (filteredPositionHistory.length < 2) return undefined;
    return {
      oldestTime: filteredPositionHistory[0].timestamp,
      newestTime: filteredPositionHistory[filteredPositionHistory.length - 1].timestamp,
      timeFormat,
      dateFormat,
    };
  }, [filteredPositionHistory, timeFormat, dateFormat]);

  // Memoize position history polyline elements
  const positionHistoryElements = useMemo(() => {
    if (renderedPositionHistory.length < 2) return null;

    const elements: React.ReactElement[] = [];
    const segmentCount = renderedPositionHistory.length - 1;
    const segmentColors: string[] = [];

    for (let i = 0; i < segmentCount; i++) {
      const startPos = renderedPositionHistory[i];
      const endPos = renderedPositionHistory[i + 1];
      const color = getPositionHistoryColor(i, segmentCount, overlayColors.positionHistoryOld, overlayColors.positionHistoryNew);
      segmentColors.push(color);

      // Points-only mode (#3492): skip the connecting line; keep the per-fix dots.
      if (positionHistoryPointsOnly) continue;

      const segmentPath = positionHistoryLineStyle === 'spline' && startPos.groundTrack !== undefined
        ? generateHeadingAwarePath(
            [startPos.latitude, startPos.longitude],
            [endPos.latitude, endPos.longitude],
            startPos.groundTrack,
            startPos.groundSpeed,
            10
          )
        : [[startPos.latitude, startPos.longitude] as [number, number], [endPos.latitude, endPos.longitude] as [number, number]];

      elements.push(
        <Polyline
          key={`position-history-segment-${i}`}
          positions={segmentPath}
          pathOptions={{
            color,
            weight: 3,
            opacity: 0.8,
          }}
        >
          <Popup>
            <div className="route-popup">
              <h4>Position Segment {i + 1}</h4>
              <div className="route-usage">
                <strong>From:</strong> {formatDateTime(new Date(startPos.timestamp), timeFormat, dateFormat)}
              </div>
              <div className="route-usage">
                <strong>To:</strong> {formatDateTime(new Date(endPos.timestamp), timeFormat, dateFormat)}
              </div>
              {/* The trail is thinned for very dense histories (#4743), so a
                  segment can span more fixes than it draws. Say so rather than
                  implying these two points were consecutive. */}
              {positionHistoryDownsampled && (
                <div className="route-usage">
                  <em>{t('nodes.position_history_simplified')}</em>
                </div>
              )}
              {startPos.groundSpeed !== undefined && (() => {
                const { speed, unit } = convertSpeed(startPos.groundSpeed, distanceUnit);
                return (
                  <div className="route-usage">
                    <strong>Speed:</strong> {speed.toFixed(1)} {unit}
                  </div>
                );
              })()}
              {startPos.groundTrack !== undefined && (() => {
                let heading = startPos.groundTrack;
                if (heading > 360) heading = heading / 1000;
                return (
                  <div className="route-usage">
                    <strong>Heading:</strong> {heading.toFixed(0)}°
                  </div>
                );
              })()}
            </div>
          </Popup>
        </Polyline>
      );
    }

    const historyArrows = generatePositionHistoryArrows(
      renderedPositionHistory,
      segmentColors,
      30,
      distanceUnit
    );
    elements.push(...historyArrows);

    return elements;
  }, [renderedPositionHistory, positionHistoryDownsampled, t, overlayColors.positionHistoryOld, overlayColors.positionHistoryNew, positionHistoryLineStyle, positionHistoryPointsOnly, timeFormat, dateFormat, distanceUnit]);

  // Detect touch device to disable hover tooltips on mobile
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    // Check if the PRIMARY input is touch-only (no mouse/trackpad available)
    // This correctly handles laptops with touchscreens that also have a trackpad
    const checkTouch = () => {
      // pointer: coarse = touch/stylus is primary input
      // pointer: fine = mouse/trackpad is available
      // A laptop with both touchscreen and trackpad has pointer: fine → not touch-only
      if (window.matchMedia) {
        const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
        const hasFinePointer = window.matchMedia('(pointer: fine)').matches;
        return hasCoarsePointer && !hasFinePointer;
      }
      // Fallback for browsers without matchMedia
      return navigator.maxTouchPoints > 0;
    };
    setIsTouchDevice(checkTouch());
  }, []);

  // Packet Monitor state
  const [showPacketMonitor, setShowPacketMonitor] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('showPacketMonitor');
    return saved === 'true';
  });

  // Width of the split-view container, which is what the node list may claim —
  // not the viewport. The container is `position: fixed; left: var(--sidebar-width);
  // right: 0`, so it already excludes the app rail. Tracked in state (rather than
  // read inline) so the ceiling follows an orientation change or window resize:
  // a plain `window.innerWidth` read only re-evaluates when something else
  // happens to re-render this component.
  const splitViewRef = useRef<HTMLDivElement>(null);
  const [sidebarMetrics, setSidebarMetrics] = useState(() => ({
    availableWidth: window.innerWidth,
    mobile: isMobileLayout(window.innerWidth, window.innerHeight),
  }));

  // useLayoutEffect + ResizeObserver rather than useEffect + resize/
  // orientationchange listeners. The initial state above has to fall back to
  // window.innerWidth because the ref is null until the DOM exists, and that
  // over-estimates the container by the width of the app rail. Measuring in a
  // layout effect corrects it before paint, so the resizable's bounds are never
  // briefly wrong (which could otherwise persist a clamped width the user never
  // chose). The observer also catches container changes that fire no window
  // event at all.
  useLayoutEffect(() => {
    const el = splitViewRef.current;
    const measure = () => {
      const measured = el?.getBoundingClientRect().width;
      const next = {
        availableWidth: measured && measured > 0 ? measured : window.innerWidth,
        mobile: isMobileLayout(window.innerWidth, window.innerHeight),
      };
      // Bail on no-op updates: this fires continuously during a window drag and
      // the value feeds the resizable's bounds.
      setSidebarMetrics(prev =>
        prev.availableWidth === next.availableWidth && prev.mobile === next.mobile ? prev : next
      );
    };
    measure();

    if (!el || typeof ResizeObserver === 'undefined') {
      // jsdom and very old browsers: fall back to the window events.
      window.addEventListener('resize', measure);
      window.addEventListener('orientationchange', measure);
      return () => {
        window.removeEventListener('resize', measure);
        window.removeEventListener('orientationchange', measure);
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // ResizeObserver sees the container resize, but `mobile` also depends on
    // viewport HEIGHT, which can cross the landscape threshold without the
    // container's width changing.
    window.addEventListener('orientationchange', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Node list sidebar resizable width. Mobile viewports may drag it to the full
  // container width (the map sits behind a toggle there, so half-width was an
  // arbitrary ceiling); desktop keeps the 50% split. See utils/sidebarWidth.ts.
  const {
    size: sidebarWidth,
    isResizing: isSidebarResizing,
    handleMouseDown: handleSidebarResizeStart,
    handleTouchStart: handleSidebarTouchStart
  } = useResizable({
    id: 'nodes-sidebar-width',
    defaultHeight: 380,
    minHeight: NODE_SIDEBAR_MIN_WIDTH_PX,
    maxHeight: resolveNodeSidebarMaxWidth(sidebarMetrics.availableWidth, sidebarMetrics.mobile),
    direction: 'horizontal'
  });

  // Packet Monitor resizable height (default 35% of viewport, min 150px, max 70%)
  const {
    size: packetMonitorHeight,
    isResizing: isPacketMonitorResizing,
    handleMouseDown: handlePacketMonitorResizeStart,
    handleTouchStart: handlePacketMonitorTouchStart
  } = useResizable({
    id: 'packet-monitor-height',
    defaultHeight: Math.round(window.innerHeight * 0.35),
    minHeight: 150,
    maxHeight: Math.round(window.innerHeight * 0.7)
  });

  // Track if packet logging is enabled on the server
  const [packetLogEnabled, setPacketLogEnabled] = useState<boolean>(false);
  const [geoJsonLayers, setGeoJsonLayers] = useState<GeoJsonLayer[]>([]);
  // mapStyles/activeStyleId/activeStyleJson now live in SettingsContext
  // (issue #4348) so DashboardMap can share the same active style.

  // Zoom-to-fit-all request counter (#4496). A counter rather than a boolean so
  // repeated taps re-fit even when the node set is unchanged; FitAllNodesController
  // inside the map watches it.
  const [fitAllRequest, setFitAllRequest] = useState(0);

  const [showTileSelector, setShowTileSelector] = useState(() => {
    const saved = localStorage.getItem('meshmonitor-showTileSelector');
    return saved === null ? false : saved === 'true';
  });

  const [showLegend, setShowLegend] = useState(() => {
    const saved = localStorage.getItem('meshmonitor-showLegend');
    return saved === null ? false : saved === 'true';
  });

  // #3636: node-to-node LOS distance measurement tool.
  const [measureActive, setMeasureActive] = useState(false);

  // #4704: 2D/3D toggle. `viewMode` is ephemeral (not persisted); the toggle is
  // only offered when the server can serve DEM terrain tiles, and any
  // capability loss forces 2D on the spot (mirrors `useEffectiveViewMode`).
  const terrainCaps = useTerrainCapabilities();
  const canUse3D = !terrainCaps.isLoading && terrainCaps.enabled && terrainCaps.terrainTiles;
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const basemap3D = useMemo(
    () => resolve3DBasemap(mapTileset, customTilesets),
    [mapTileset, customTilesets],
  );
  const terrainTileUrl = useMemo(() => buildTerrainTileUrl(appBasename), []);

  const sidebarRef = useRef<HTMLDivElement>(null);

  // Save packet monitor preference to localStorage
  useEffect(() => {
    localStorage.setItem('showPacketMonitor', showPacketMonitor.toString());
  }, [showPacketMonitor]);


  useEffect(() => {
    localStorage.setItem('meshmonitor-showTileSelector', showTileSelector.toString());
  }, [showTileSelector]);

  useEffect(() => {
    localStorage.setItem('meshmonitor-showLegend', showLegend.toString());
  }, [showLegend]);


  // Map controls position state with localStorage persistence
  // Position is relative to the map container (absolute positioning)

  // Check if user has permission to view packet monitor
  const canViewPacketMonitor = hasPermission('packetmonitor', 'read');

  // Fetch packet logging enabled status from server
  useEffect(() => {
    const fetchPacketLogStatus = async () => {
      if (!canViewPacketMonitor) return;

      try {
        const stats = await getPacketStats();
        setPacketLogEnabled(stats.enabled === true);
      } catch (error) {
        console.error('Failed to fetch packet log status:', error);
      }
    };

    void fetchPacketLogStatus();
  }, [canViewPacketMonitor]);

  useEffect(() => {
    const fetchGeoJsonLayers = async () => {
      try {
        const data = await api.get<GeoJsonLayer[]>('/api/geojson/layers');
        setGeoJsonLayers(data);
      } catch (err) {
        console.error('Failed to fetch GeoJSON layers:', err);
      }
    };
    void fetchGeoJsonLayers();
  }, []);

  // mapStyles/activeStyleId/activeStyleJson are fetched and resolved once by
  // SettingsContext's own mount effect (issue #4348) — no local fetch needed.

  // Refs to access latest values without recreating listeners
  const processedNodesRef = useRef(processedNodes);
  const setSelectedNodeIdRef = useRef(setSelectedNodeId);
  const centerMapOnNodeRef = useRef(centerMapOnNode);
  const showRouteRef = useRef(showRoute);
  const traceroutesRef = useRef(traceroutes);
  // Kept fresh in the "Update refs" effect below. Lets the stable click
  // handlers read the current offset-inclusive marker position map.
  const nodePositionsRef = useRef<Map<number, [number, number]>>(new Map());

  // Center the map on the position the node's MARKER is actually rendered at.
  // For low-precision/obscured nodes `nodePositions` includes the deterministic
  // in-cell offset (#4016); `centerMapOnNode`/getEffectivePosition uses the raw
  // reported cell-center, so panning there jumped up to half an accuracy cell
  // (km-scale for obscured nodes) away from the marker the user clicked. Prefer
  // the rendered marker position; fall back to the raw center only for a node
  // that isn't currently on the map (no entry in nodePositions).
  const centerOnNodeMarker = useCallback((node: DeviceInfo) => {
    const markerPos = resolveMarkerCenterTarget(node.nodeNum, nodePositionsRef.current);
    if (markerPos) {
      setMapCenterTarget(markerPos);
    } else {
      centerMapOnNodeRef.current(node);
    }
  }, [setMapCenterTarget]);

  // Rich OMS click handler (#4047 Phase 4 WP6) — moved onto the shared
  // NodeMarkersLayer's `onOmsClick(marker, key)`. Replaces the old
  // `handleMarkerRef`/`_meshNodeId` tag lookup: the shared layer already knows
  // which key a clicked marker belongs to (it tracks `keyByMarker` itself), so
  // it hands the key straight to this callback instead of us reading a tag off
  // the marker instance. Reads latest state via the refs above (kept fresh by
  // the "Update refs when values change" effect below) so this stays
  // referentially stable and the shared layer's OMS listener effect
  // (`[addListener, removeListener, onOmsClick]`) isn't re-registered every
  // render — the same rationale the old retry-loop bridge had.
  const onOmsClick = useCallback((marker: LeafletMarker, key: string) => {
    if (!key) return;
    const nodeId = key;
    const findNode = () =>
      processedNodesRef.current.find(n => (n.user?.id ?? String(n.nodeNum)) === nodeId);

    setSelectedNodeIdRef.current(nodeId);
    // When showRoute is enabled, let TracerouteBoundsController handle the zoom
    // to fit the entire traceroute path instead of just centering on the node.
    // But if the node has no valid traceroute, fall back to centering on it.
    if (!showRouteRef.current) {
      const node = findNode();
      if (node) centerOnNodeMarker(node);
    } else {
      const hasTraceroute = traceroutesRef.current.some(tr => {
        const matches = tr.toNodeId === nodeId || tr.fromNodeId === nodeId;
        if (!matches) return false;
        return tr.route && tr.route !== 'null' && tr.route !== '' &&
               tr.routeBack && tr.routeBack !== 'null' && tr.routeBack !== '';
      });
      // If no valid traceroute, still center on the node
      if (!hasTraceroute) {
        const node = findNode();
        if (node) centerOnNodeMarker(node);
      }
    }

    // #4015: OMS 'click' fires only for an already-spiderfied or standalone
    // marker, and the shared layer strips Leaflet's own auto-open handler, so
    // this is the single popup opener — no closePopup()/setTimeout dance
    // needed. autoPan is disabled so opening the popup doesn't fight the pan
    // started by centerMapOnNode above. Prefer the live marker from
    // `markerRefs` (kept fresh by each descriptor's `add` event handler, and
    // also consumed by App.tsx's own "open popup for selected node" effect)
    // over the shared layer's marker — mirrors the pre-migration preference.
    const currentMarker = markerRefs.current.get(nodeId) || marker;
    const popup = currentMarker.getPopup();
    if (popup) {
      popup.options.autoPan = false;
    }
    currentMarker.openPopup();
    // Reads latest state via refs; centerOnNodeMarker is the one referenced
    // dependency and is itself referentially stable, so onOmsClick stays stable
    // and the shared layer's OMS listener effect isn't re-registered.
  }, [centerOnNodeMarker]);

  // Stable callback factories for node item interactions
  const handleNodeClick = useCallback((node: DeviceInfo) => {
    return () => {
      const nodeId = node.user?.id || null;
      // Toggle selection: if already selected, deselect; otherwise select
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(null);
        return;
      }
      setSelectedNodeId(nodeId);
      // When showRoute is enabled, let TracerouteBoundsController handle the zoom
      // to fit the entire traceroute path instead of just centering on the node.
      // But if the node has no valid traceroute, fall back to centering on it.
      if (!showRoute) {
        centerOnNodeMarker(node);
      } else {
        const hasTraceroute = traceroutes.some(tr => {
          const matches = tr.toNodeId === nodeId || tr.fromNodeId === nodeId;
          if (!matches) return false;
          return tr.route && tr.route !== 'null' && tr.route !== '' &&
                 tr.routeBack && tr.routeBack !== 'null' && tr.routeBack !== '';
        });
        if (!hasTraceroute) {
          centerOnNodeMarker(node);
        }
      }
      // Auto-collapse node list on mobile when a node with position is clicked
      if (window.innerWidth <= 768) {
        const hasPosition = node.position &&
          node.position.latitude != null &&
          node.position.longitude != null;
        if (hasPosition) {
          setIsNodeListCollapsed(true);
        }
      }
    };
  }, [selectedNodeId, setSelectedNodeId, centerOnNodeMarker, setIsNodeListCollapsed, showRoute, traceroutes]);

  const handleFavoriteClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => toggleFavorite(node, e);
  }, [toggleFavorite]);

  const handleLockClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => {
      if (toggleFavoriteLock) void toggleFavoriteLock(node, e);
    };
  }, [toggleFavoriteLock]);

  const handleCopyNodeInfoClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      setCopyNodeInfoTarget(node);
    };
  }, []);

  const handlePopupDMClick = useCallback((node: DeviceInfo) => {
    return () => {
      setSelectedDMNode(node.user!.id);
      setActiveTab('messages');
    };
  }, [setSelectedDMNode, setActiveTab]);

  // "Open Node Details" — the NodeDetailsButton on every row, and row
  // double-click (#4379). #4326/#4333 reached this same destination by making
  // the unmessageable badge itself clickable; that affordance was invisible
  // among the inert status icons and misdescribed where it went, so it now
  // has its own labelled control on every node instead of just unmessageable
  // ones. Matches what the map popup's "More Details" action has always done
  // (that popup has never gated on messageability).
  //
  // This is also what used to be the Send-DM button. That button sat directly
  // beside this one and went to the same place, so #4379 folded the two
  // together rather than shipping a row with two near-identical controls.
  // The merge has to preserve #4325: `openDmForCompose` additionally asks the
  // DM view to focus its compose box, which is what lets you click a node and
  // start typing instead of landing on a conversation you must click into
  // again. It was the ONLY caller of that path, so branching here is what
  // keeps the whole pendingComposeFocus chain alive.
  //
  // Unmessageable nodes take the plain `setSelectedDMNode` route: there is no
  // composer to focus, because MessagesTab hides it behind the
  // `dmReadOnlyReason === 'unmessageable'` banner.
  const handleNodeDetailsClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      const nodeId = node.user?.id || '';
      if (node.isUnmessagable) {
        setSelectedDMNode(nodeId);
      } else {
        openDmForCompose(nodeId);
      }
      setActiveTab('messages');
    };
  }, [setSelectedDMNode, openDmForCompose, setActiveTab]);

  // Simple toggle callbacks
  const handleCollapseNodeList = useCallback(() => {
    setIsNodeListCollapsed(!isNodeListCollapsed);
  }, [isNodeListCollapsed, setIsNodeListCollapsed]);

  const handleToggleFilterPopup = useCallback(() => {
    setShowNodeFilterPopup(!showNodeFilterPopup);
  }, [showNodeFilterPopup, setShowNodeFilterPopup]);

  const handleToggleSortDirection = useCallback(() => {
    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
  }, [sortDirection, setSortDirection]);




  // Update refs when values change
  useEffect(() => {
    processedNodesRef.current = processedNodes;
    setSelectedNodeIdRef.current = setSelectedNodeId;
    centerMapOnNodeRef.current = centerMapOnNode;
    showRouteRef.current = showRoute;
    traceroutesRef.current = traceroutes;
    nodePositionsRef.current = nodePositions;
  });

  // Track previous nodes to detect updates and trigger animations
  const prevNodesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!showAnimations) {
      return;
    }

    // Build a map of current node IDs to their lastHeard timestamps
    const currentNodes = new Map<string, number>();
    processedNodes.forEach(node => {
      if (node.user?.id && node.lastHeard) {
        currentNodes.set(node.user.id, node.lastHeard);
      }
    });

    // Compare with previous state and trigger animations for updated nodes
    currentNodes.forEach((lastHeard, nodeId) => {
      const prevLastHeard = prevNodesRef.current.get(nodeId);
      if (prevLastHeard !== undefined && lastHeard > prevLastHeard) {
        // Node has received an update - trigger animation
        triggerNodeAnimation(nodeId);
      }
    });

    // Update the ref for next comparison
    prevNodesRef.current = currentNodes;
  }, [processedNodes, showAnimations, triggerNodeAnimation]);

  // Use the map tileset from settings
  const activeTileset = mapTileset;

  // Handle center complete. MUST be stable: it's a dependency of
  // MapCenterController's effect, and a new reference every render would
  // re-run that effect and re-fire map.setView() while mapCenterTarget is
  // still set — snapping the map back to the node on every re-render (poll,
  // websocket, etc.) so the user can't pan away. `setMapCenterTarget` is a
  // stable useState setter.
  const handleCenterComplete = useCallback(() => {
    setMapCenterTarget(null);
  }, [setMapCenterTarget]);

  // Handle node click from packet monitor
  const handlePacketNodeClick = (nodeId: string) => {
    // Find the node by ID
    const node = processedNodes.find(n => n.user?.id === nodeId);
    if (node) {
      // Select and center on the node
      setSelectedNodeId(nodeId);
      centerOnNodeMarker(node);
    }
  };

  // Helper function to sort nodes
  const sortNodes = useCallback((nodes: DeviceInfo[]): DeviceInfo[] => {
    return [...nodes].sort((a, b) => {
      let aVal: any, bVal: any;

      switch (sortField) {
        case 'longName':
          aVal = a.user?.longName || `Node ${a.nodeNum}`;
          bVal = b.user?.longName || `Node ${b.nodeNum}`;
          break;
        case 'shortName':
          aVal = a.user?.shortName || '';
          bVal = b.user?.shortName || '';
          break;
        case 'id':
          aVal = a.user?.id || a.nodeNum;
          bVal = b.user?.id || b.nodeNum;
          break;
        case 'lastHeard':
          aVal = a.lastHeard || 0;
          bVal = b.lastHeard || 0;
          break;
        case 'snr':
          aVal = a.snr ?? -999;
          bVal = b.snr ?? -999;
          break;
        case 'battery':
          aVal = a.deviceMetrics?.batteryLevel ?? -1;
          bVal = b.deviceMetrics?.batteryLevel ?? -1;
          break;
        case 'uptime':
          // Never-reported uptime sorts to the bottom. Top-level uptimeSeconds is
          // enriched by /api/nodes (#4814), with the device-metrics copy as fallback.
          aVal = a.uptimeSeconds ?? a.deviceMetrics?.uptimeSeconds ?? -1;
          bVal = b.uptimeSeconds ?? b.deviceMetrics?.uptimeSeconds ?? -1;
          break;
        case 'hwModel':
          aVal = a.user?.hwModel ?? 0;
          bVal = b.user?.hwModel ?? 0;
          break;
        case 'hops':
          aVal = getEffectiveHops(a, nodeHopsCalculation, traceroutes, currentNodeNum);
          bVal = getEffectiveHops(b, nodeHopsCalculation, traceroutes, currentNodeNum);
          break;
        default:
          return 0;
      }

      // Compare values
      let comparison = 0;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        comparison = aVal.localeCompare(bVal);
      } else {
        comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [sortField, sortDirection, nodeHopsCalculation, traceroutes, currentNodeNum]);

  // The displayed node set: processedNodes (text filter already applied upstream)
  // → security/channel/incomplete/remote-admin filters → favorites-first sort.
  // Shared by the rendered list and the CSV/HTML export so they always match.
  const displayedNodes = useMemo(() => {
    const filtered = processedNodes.filter(node => {
      if (securityFilter === 'flaggedOnly') {
        if (!node.keyIsLowEntropy && !node.duplicateKeyDetected && !node.keySecurityIssueDetails) return false;
      }
      if (securityFilter === 'hideFlagged') {
        if (node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) return false;
      }
      if (channelFilter !== 'all') {
        const nodeChannel = node.channel ?? 0;
        if (nodeChannel !== channelFilter) return false;
      }
      if (!showIncompleteNodes && !isNodeComplete(node)) return false;
      if (filterRemoteAdminOnly && !node.hasRemoteAdmin) return false;
      return true;
    });
    // Favorites first, each group sorted independently (matches list rendering).
    return [
      ...sortNodes(filtered.filter(node => node.isFavorite)),
      ...sortNodes(filtered.filter(node => !node.isFavorite)),
    ];
  }, [processedNodes, securityFilter, channelFilter, showIncompleteNodes, filterRemoteAdminOnly, sortNodes]);

  // Export format dropdown (Issue #3499) — a single icon button in the controls
  // row reveals this menu, keeping the header compact for a rarely-used action.
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close the export menu on outside click or Escape.
  useEffect(() => {
    if (!showExportMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowExportMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showExportMenu]);

  // Export the currently-displayed nodes as CSV or HTML (Issue #3499).
  const handleExportNodes = useCallback((format: 'csv' | 'html') => {
    setShowExportMenu(false);
    if (displayedNodes.length === 0) return;
    const rows = buildNodeExportRows(displayedNodes, {
      nodeHopsCalculation,
      traceroutes,
      currentNodeNum,
      currentNodeId,
      formatLastHeard: (s) => formatDateTime(new Date(s * 1000), timeFormat, dateFormat),
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (format === 'csv') {
      // Prepend a UTF-8 BOM so Excel detects the encoding correctly.
      downloadTextFile(`meshmonitor-nodes-${stamp}.csv`, '\uFEFF' + nodesToCsv(rows), 'text/csv;charset=utf-8');
    } else {
      const html = nodesToHtml(rows, { generatedAt: new Date().toLocaleString() });
      downloadTextFile(`meshmonitor-nodes-${stamp}.html`, html, 'text/html;charset=utf-8');
    }
  }, [displayedNodes, nodeHopsCalculation, traceroutes, currentNodeNum, currentNodeId, timeFormat, dateFormat]);

  // Calculate nodes with position - uses effective position (respects position overrides, Issue #1526)
  // #3549: per-node "Hide from Map" suppresses the marker only; the node remains in the list above.
  const nodesWithPosition = processedNodes.filter(node => !node.hideFromMap && hasValidEffectivePosition(node));

  // Memoize node positions to prevent React-Leaflet from resetting marker positions
  // Creating new [lat, lng] arrays causes React-Leaflet to move markers, destroying spiderfier state
  // Uses getEffectivePosition to respect position overrides (Issue #1526)
  const nodePositions = React.useMemo(() => {
    // #4016/#4155: offset obscured low-precision markers within their accuracy
    // cell via the shared occupancy-gated helper — lone nodes stay centered, 2+
    // same-cell nodes spread — identical to every other map surface. Overridden
    // positions are never moved; the accuracy Rectangle below keeps using
    // node.position (the true center).
    const offset = applyPrecisionCellOffsets(
      nodesWithPosition
        .map(node => ({ node, eff: getEffectivePosition(node) }))
        .filter(e => e.eff.latitude != null && e.eff.longitude != null)
        .map(({ node, eff }) => ({
          item: node,
          id: unifiedNodeKey(node) ?? String(node.nodeNum),
          latLng: [eff.latitude as number, eff.longitude as number] as [number, number],
          bits: node.positionPrecisionBits,
          isOverride: node.positionIsOverride,
        })),
    );
    const posMap = new Map<number, [number, number]>();
    for (const { item: node, latLng } of offset) posMap.set(node.nodeNum, latLng);
    return posMap;
  }, [nodesWithPosition.map(n => {
    const pos = getEffectivePosition(n);
    return `${n.nodeNum}-${pos.latitude}-${pos.longitude}-${n.positionPrecisionBits ?? ''}`;
  }).join(',')]);

  // #4015: the Leaflet auto-open-on-click strip is now owned by the shared
  // `NodeMarkersLayer` (#4047 Phase 4 WP6) — it runs the same every-render,
  // per-marker `_meshPopupStripped`-tagged strip internally against its own
  // tracked markers, so a duplicate pass over `markerRefs` here is no longer
  // needed. `markerRefs` itself is still populated (via each descriptor's
  // `add` event handler below) purely for App.tsx's "open popup for selected
  // node" effect and this component's `onOmsClick`.

  // Zoom-to-fit-all target set (#4496). Uses the same OFFSET marker positions
  // as the pins and the measure tool, per the #4016/#4155 single-position rule —
  // fitting to raw centres could leave a visible pin just outside the viewport.
  const fitAllPositions: Array<[number, number]> = React.useMemo(
    () => nodesWithPosition
      .map(node => nodePositions.get(node.nodeNum))
      .filter((p): p is [number, number] => Array.isArray(p)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on nodePositions like measurePoints below
    [nodePositions, nodesWithPosition.map(n => n.nodeNum).join(',')],
  );

  // #3636: measurement endpoints — nearest-node snapping picks from these.
  // Use the OFFSET marker position (nodePositions), not the raw center, so the
  // measure tool snaps to the pin the user sees — matching DashboardMap and the
  // #4016/#4155 single-position rule (measure/bounds/markers all agree).
  const measurePoints: MeasurePoint[] = React.useMemo(
    () => nodesWithPosition
      .map(node => {
        const pos = nodePositions.get(node.nodeNum);
        if (!pos) return null;
        return {
          id: String(node.user?.id ?? node.nodeNum),
          lat: pos[0],
          lng: pos[1],
          label: node.user?.shortName,
        } as MeasurePoint;
      })
      .filter((p): p is MeasurePoint => p !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on nodePositions (offset) + a label signature so tooltip names refresh
    [nodePositions, nodesWithPosition.map(n => `${n.nodeNum}-${n.user?.shortName ?? ''}`).join(',')],
  );

  const showLabel = mapZoom >= 13;

  // Node marker descriptors for the shared NodeMarkersLayer (#4047 Phase 4,
  // WP6) — the layer owns spiderfy wiring, the icon/position caches that used
  // to live in the `nodeIcons`/`nodePositions` memos here, removal
  // reconciliation, OMS-click popup-open (via `onOmsClick` above), and the
  // `_openPopup` strip that used to be duplicated inline in this file.
  // `iconSig` is the exact old `nodeIcons` memo dependency-signature string —
  // the shared layer's `stableIcon` cache only calls `buildIcon` when it
  // changes, preserving the "don't rebuild the divIcon DOM every render"
  // behavior the old memo existed for.
  //
  // `key` doubles as the spiderfier tracking key. `String(node.user?.id ??
  // nodeNum)` preserves the pre-migration `_meshNodeId` identity for every
  // node that has a `user.id` (the common case), and — unlike the old
  // `handleMarkerRef`, which silently skipped registering a marker with no
  // `user?.id` — also gives spiderfy/`markerRefs` coverage to the rare node
  // that has a position but no user info yet (matches the Dashboard/MapAnalysis
  // marker-key fallback convention).
  // The visible+positioned node set — the shared source of truth for both the
  // 2D marker descriptors below and the #4704 3D node features.
  const visibleMapNodes = nodesWithPosition
    .filter(node => {
      // Apply standard filters
      if (!nodePassesTransportFilter(node, { showRfNodes, showUdpNodes, showMqttNodes }, transportCutoff)) return false;
      if (!showIncompleteNodes && !isNodeComplete(node)) return false;
      if (!showEstimatedPositions && node.user?.id && nodesWithEstimatedPosition.has(node.user.id)) return false;
      // When traceroute is active, only show nodes involved in the traceroute
      if (tracerouteNodeNums && !tracerouteNodeNums.has(node.nodeNum)) return false;
      // Map Features age slider (#3322): hide markers older than the
      // chosen age. Favorites are always shown, matching the standard
      // node age filter. Default (slider at max) is a no-op.
      if (!node.isFavorite && node.lastHeard && node.lastHeard < mapAgeCutoffSeconds) return false;
      return true;
    });
  // #4704: node features for the 3D surface — the same visible+positioned set
  // the 2D markers use, at the same (precision-offset) positions from
  // `nodePositions`. Computed unconditionally (no hooks); only consumed in 3D.
  const node3DFeatures: Node3DFeature[] = useMemo(() => {
    const out: Node3DFeature[] = [];
    for (const node of visibleMapNodes) {
      const pos = nodePositions.get(node.nodeNum);
      if (!pos) continue;
      // Match the 2D marker (#4808): hop-based color + glyph-family category.
      const isLocalNode = node.user?.id === currentNodeId;
      const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
      out.push({
        key: String(node.user?.id ?? node.nodeNum),
        lat: pos[0],
        lng: pos[1],
        label: node.user?.shortName ?? undefined,
        color: getHopColor(hops),
        category: categoryGlyphFamily(getNodeTypeCategory(node)),
        opacity: calculateNodeOpacity(
          node.lastHeard,
          nodeDimmingEnabled,
          nodeDimmingStartHours,
          nodeDimmingMinOpacity,
          maxNodeAgeHours,
        ),
      });
    }
    return out;
  }, [
    visibleMapNodes,
    nodePositions,
    currentNodeId,
    nodeHopsCalculation,
    traceroutes,
    currentNodeNum,
    nodeDimmingEnabled,
    nodeDimmingStartHours,
    nodeDimmingMinOpacity,
    maxNodeAgeHours,
  ]);

  // Visible node numbers for gating the 3D neighbor/traceroute lines to the
  // rendered markers, matching 2D (#4808).
  const visible3DNodeNums = useMemo(
    () => new Set(visibleMapNodes.map((n) => n.nodeNum)),
    [visibleMapNodes],
  );

  // key → node for resolving a clicked 3D marker back to its node so the shared
  // DashboardNodePopup can render on the 3D map (#4808).
  const node3DByKey = useMemo(() => {
    const m = new Map<string, (typeof visibleMapNodes)[number]>();
    for (const node of visibleMapNodes) m.set(String(node.user?.id ?? node.nodeNum), node);
    return m;
  }, [visibleMapNodes]);

  const nodeMarkers: NodeMarkerDescriptor[] = visibleMapNodes
    .map(node => {
      const markerKey = String(node.user?.id ?? node.nodeNum);
      const roleNum = typeof node.user?.role === 'string'
        ? parseInt(node.user.role, 10)
        : (typeof node.user?.role === 'number' ? node.user.role : 0);
      const isRouter = roleNum === 2;
      // #4075: pass the role category so ROUTER_LATE (and REPEATER) get the
      // repeater-tower glyph like ROUTER, matching MapAnalysis. isRouter alone
      // is role===2 only, so ROUTER_LATE would fall through to the generic pin.
      const roleCategory = getNodeTypeCategory(node);
      const isSelected = selectedNodeId === node.user?.id;
      const isLocalNode = node.user?.id === currentNodeId;
      const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
      const shouldAnimate = showAnimations && animatedNodes.has(node.user?.id || '');
      const position = nodePositions.get(node.nodeNum)!;

      // Calculate opacity based on last heard time
      const markerOpacity = calculateNodeOpacity(
        node.lastHeard,
        nodeDimmingEnabled,
        nodeDimmingStartHours,
        nodeDimmingMinOpacity,
        maxNodeAgeHours
      );

      // Hide popup when showRoute is enabled and node has a valid traceroute,
      // since TracerouteBoundsController zooms to fit the route.
      const hasValidTraceroute = traceroutes.some(tr => {
        const matches = tr.toNodeId === node.user?.id || tr.fromNodeId === node.user?.id;
        if (!matches) return false;
        return tr.route && tr.route !== 'null' && tr.route !== '' &&
               tr.routeBack && tr.routeBack !== 'null' && tr.routeBack !== '';
      });

      return {
        key: markerKey,
        position,
        iconSig: `${node.nodeNum}-${hops}-${isSelected}-${node.user?.role}-${node.isUnmessagable ? 1 : 0}-${node.user?.shortName}-${showLabel}-${shouldAnimate}-${showRoute && isSelected}-${mapPinStyle}`,
        buildIcon: () =>
          createNodeIcon({
            variant: 'meshtastic',
            hops,
            isSelected,
            isRouter,
            roleCategory,
            isUnmessagable: !!node.isUnmessagable,
            shortName: node.user?.shortName,
            showLabel: showLabel || shouldAnimate,
            animate: shouldAnimate,
            highlightSelected: showRoute && isSelected,
            pinStyle: mapPinStyle,
            nodeNum: node.nodeNum,
          }),
        opacity: markerOpacity,
        zIndexOffset: shouldAnimate ? 10000 : 0,
        eventHandlers: {
          // Keep `markerRefs` (shared with App.tsx's "open popup for selected
          // node" effect, and this component's `onOmsClick` above) populated
          // with the live Leaflet marker instance. Leaflet's 'add' event
          // fires once the marker is added to the map (`e.target` is the
          // marker itself) — a standard, cheap substitute for the old
          // `handleMarkerRef` ref-callback tagging, now that the shared layer
          // owns the `<Marker ref>` itself.
          add: (e: L.LeafletEvent) => {
            markerRefs.current.set(markerKey, e.target as LeafletMarker);
          },
          ...(!isTouchDevice ? {
            mouseover: (e: any) => {
              if (hoverTimeoutRef.current) {
                clearTimeout(hoverTimeoutRef.current);
                hoverTimeoutRef.current = null;
              }
              // Selectively dim polylines not connected to this node
              const container = e.target._map?.getContainer();
              if (!container) return;
              const nodeClass = `node-${node.nodeNum}`;
              const paths = container.querySelectorAll('.leaflet-overlay-pane svg path.route-segment, .leaflet-overlay-pane svg path.neighbor-line');
              paths.forEach((path: Element) => {
                if (path.classList.contains(nodeClass)) {
                  (path as HTMLElement).style.opacity = '';
                } else {
                  (path as HTMLElement).style.opacity = '0.25';
                }
              });
            },
            mouseout: (e: any) => {
              if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
              hoverTimeoutRef.current = setTimeout(() => {
                const container = e.target._map?.getContainer();
                if (!container) return;
                const paths = container.querySelectorAll('.leaflet-overlay-pane svg path.route-segment, .leaflet-overlay-pane svg path.neighbor-line');
                paths.forEach((path: Element) => {
                  (path as HTMLElement).style.opacity = '';
                });
                hoverTimeoutRef.current = null;
              }, 150);
            },
          } : {}),
        },
        children: (
          <>
            {!isTouchDevice && (
              <Tooltip direction="top" offset={[0, -20]} opacity={0.9}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 'bold' }}>
                    {node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16)}`}
                  </div>
                  {(() => {
                    const tooltipHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                    const { hops: metaHops, showSnr, snr } = getMapHoverTooltipMeta(tooltipHops, node.snr);
                    if (metaHops === null && !showSnr) return null;
                    return (
                      <div style={{ fontSize: '0.85em', opacity: 0.8 }}>
                        {metaHops !== null && (
                          <span>{metaHops} hop{metaHops !== 1 ? 's' : ''}</span>
                        )}
                        {showSnr && (
                          <span>
                            {metaHops !== null ? ' · ' : ''}<UiIcon name="wifi" size={13} /> {snr!.toFixed(1)}dB
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </Tooltip>
            )}
            {!(showRoute && hasValidTraceroute) && (
              <Popup autoPan={false}>
                {(() => {
                  const cardModel = toNodeCardModel(node, 'meshtastic', {
                    effectiveHops: getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum),
                  });
                  // NodesTab's popup has never shown SNR/battery (unlike the
                  // Dashboard card) — strip them from the model fed to
                  // SignalItems so the migrated card stays pixel-identical
                  // to the deleted MapNodePopupContent (spec §WP4/§4).
                  const infoSignalModel: NodeCardModel = { ...cardModel, snr: null, battery: null };

                  const hasTracerouteFeatures = hasPermission('traceroute', 'write') && !!onTraceroute;

                  // Port of the identical recency lookup MapNodePopupContent
                  // used to inline. nodeCardModel.ts's `useRecentTraceroute`
                  // is a hook and can't be called from this .map() callback
                  // (variable call count across nodes would violate the
                  // rules of hooks), so the pure logic is replicated here.
                  const recentTraceroute = (() => {
                    if (!currentNodeId || !node.user?.id || currentNodeId === node.user.id) return null;
                    const fromNum = parseNodeId(currentNodeId);
                    if (fromNum === null) return null;
                    const cutoff = Date.now() - TRACEROUTE_DISPLAY_HOURS * 60 * 60 * 1000;
                    return traceroutes
                      .filter(tr => {
                        const isRelevant =
                          (tr.fromNodeNum === fromNum && tr.toNodeNum === node.nodeNum) ||
                          (tr.fromNodeNum === node.nodeNum && tr.toNodeNum === fromNum);
                        return isRelevant && tr.timestamp >= cutoff;
                      })
                      .sort((a, b) => b.timestamp - a.timestamp)[0] || null;
                  })();

                  const actions: NodeActionSpec[] = [];
                  if (node.user?.id && hasPermission('messages', 'read')) {
                    actions.push({ kind: 'more-details', onClick: handlePopupDMClick(node) });
                  }
                  // #4244: no longer gated on isNodeComplete -- another source
                  // may have heard fresher NodeInfo than this one, and
                  // "complete" can mean nothing more than derived placeholders.
                  if (hasPermission('nodes', 'write')) {
                    actions.push({ kind: 'copy-nodeinfo', onClick: () => setCopyNodeInfoTarget(node) });
                  }
                  if (hasPermission('messages', 'write') && node.nodeNum !== currentNodeNum) {
                    if (onDeleteNode) {
                      actions.push({ kind: 'delete', onClick: () => onDeleteNode(node.nodeNum) });
                    }
                    if (onPurgeNodeFromDevice && connectionStatus === 'connected') {
                      actions.push({ kind: 'purge', onClick: () => onPurgeNodeFromDevice(node.nodeNum) });
                    }
                  }

                  return (
                    <NodeCard
                      model={cardModel}
                      sections={
                        <>
                          <div className="node-popup-grid">
                            <IdentityItems model={cardModel} />
                            <SignalItems model={infoSignalModel} showAltitude distanceUnit={distanceUnit} />
                          </div>
                          <LastHeardFooter
                            lastHeard={cardModel.lastHeard}
                            mode="absolute"
                            timeFormat={timeFormat}
                            dateFormat={dateFormat}
                          />
                          <NodeActions actions={actions} />
                        </>
                      }
                      tracerouteBody={hasTracerouteFeatures ? (
                        <TracerouteBody
                          recentTraceroute={recentTraceroute}
                          nodes={nodes}
                          distanceUnit={distanceUnit}
                          onRunTraceroute={node.user?.id && onTraceroute ? () => onTraceroute(node.user!.id) : undefined}
                          running={tracerouteLoading === node.user?.id}
                          runDisabled={isTracerouteRunDisabled(connectionStatus, tracerouteLoading, node.user?.id, txDisabled)}
                          runDisabledReason={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                        />
                      ) : undefined}
                    />
                  );
                })()}
              </Popup>
            )}
          </>
        ),
      };
    });

  // Position accuracy regions (#4047 Phase 7 WP11) — adapter over the shared
  // `AccuracyRegionsLayer` (WP3). `hasAccuracyCell`/`precisionCellBounds`
  // (`utils/precisionOffset`) reproduce this file's former inline bounds math
  // exactly (same `2^(32-bits) * 1e-7 * 111_111` cell-size formula, verified
  // numerically identical) — sharing them here removes the last duplicate of
  // that formula. `pathOptions` stays hop-colored (NodesTab-only look, tied
  // visually to the hop-colored marker) via the descriptor's per-region
  // override, so this box is NOT the shared layer's canonical gray default.
  const accuracyRegions: AccuracyRegionDescriptor[] = showAccuracyRegions
    ? nodesWithPosition
        .filter(node => {
          if (!hasAccuracyCell(node.positionPrecisionBits, node.positionIsOverride)) return false;
          if (!nodePassesTransportFilter(node, { showRfNodes, showUdpNodes, showMqttNodes }, transportCutoff)) return false;
          if (!showIncompleteNodes && !isNodeComplete(node)) return false;
          // When traceroute is active, only show regions for nodes in the traceroute
          if (tracerouteNodeNums && !tracerouteNodeNums.has(node.nodeNum)) return false;
          return true;
        })
        .map(node => {
          const bounds = precisionCellBounds(
            node.position!.latitude,
            node.position!.longitude,
            node.positionPrecisionBits as number,
          );
          const isLocalNode = node.user?.id === currentNodeId;
          const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
          const color = getHopColor(hops, overlayColors.hopColors);
          return {
            key: `accuracy-${node.nodeNum}`,
            bounds,
            pathOptions: {
              color,
              fillColor: color,
              fillOpacity: 0.08,
              opacity: 0.5,
              weight: 1,
            },
          };
        })
    : [];

  // Neighbor-info links (#4047 Phase 7 WP11) — adapter over the shared
  // `NeighborLinksLayer` (WP2). Zoom-adaptive gate hoisted to the top of the
  // expression (was a per-item early return in the pre-migration inline map)
  // — `mapZoom`/`neighborInfoMinZoom` don't vary per item, so the rendered
  // output is identical either way. `computeNeighborLinkStyle` above pins the
  // 4-tier SNR→weight/opacity table and the unidirectional-arrow gate; bearing
  // for the arrow icons is now computed by the shared layer itself
  // (`bearingBetween`, verified to reproduce this file's former inline
  // `atan2` calculation exactly), so it's no longer computed here.
  const neighborLinks: NeighborLinkDescriptor[] = (showNeighborInfo && neighborInfo.length > 0 && mapZoom >= neighborInfoMinZoom)
    ? neighborInfo
        .map((ni, idx): NeighborLinkDescriptor | null => {
          // Anchor each endpoint to where the node's MARKER is rendered
          // (merged / override-aware position, keyed by nodeNum) so the
          // line connects to the visible marker rather than the
          // source-specific reported coords (#3642). Falls back to the
          // record's embedded coords when the node isn't on the map.
          const nodeEndpoint = resolveMapEndpoint(nodePositions, ni.nodeNum, ni.nodeLatitude, ni.nodeLongitude);
          const neighborEndpoint = resolveMapEndpoint(nodePositions, ni.neighborNodeNum, ni.neighborLatitude, ni.neighborLongitude);
          if (!nodeEndpoint || !neighborEndpoint) return null;
          const [nodeLat, nodeLng] = nodeEndpoint;
          const [neighborLat, neighborLng] = neighborEndpoint;

          // Filter out segments where either endpoint is not visible (Issue #1149)
          if (visibleNodeNums && (!visibleNodeNums.has(ni.nodeNum) || !visibleNodeNums.has(ni.neighborNodeNum))) {
            return null;
          }

          // When traceroute is active, only show segments for nodes in the traceroute
          if (tracerouteNodeNums && (!tracerouteNodeNums.has(ni.nodeNum) || !tracerouteNodeNums.has(ni.neighborNodeNum))) {
            return null;
          }

          const positions: [[number, number], [number, number]] = [
            [nodeLat, nodeLng],
            [neighborLat, neighborLng],
          ];

          const isBidirectional = ni.bidirectional === true;
          const { pathOptions, arrows } = computeNeighborLinkStyle(ni.snr ?? null, isBidirectional, overlayColors.neighborLine);

          // Calculate distance between nodes (coordinates guaranteed non-null by early return above)
          const distKm = calculateDistance(nodeLat, nodeLng, neighborLat, neighborLng);
          const distStr = formatDistance(distKm, distanceUnit);

          // Normalize timestamp: old data may be in seconds, new data in milliseconds
          const tsMs = ni.timestamp < 10_000_000_000 ? ni.timestamp * 1000 : ni.timestamp;
          // Data age (clamped to 0 to handle clock skew)
          const ageMs = Math.max(0, Date.now() - tsMs);
          const ageMin = Math.floor(ageMs / 60000);
          const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`;

          // SNR text color for popup (canonical 4-band scale, #4047 P3 D4)
          const snrTextColor = ni.snr != null
            ? snrToColor(ni.snr, overlayColors.snrColors)
            : undefined;

          return {
            key: `neighbor-${idx}`,
            positions,
            pathOptions,
            className: `neighbor-line node-${ni.nodeNum} node-${ni.neighborNodeNum}`,
            arrows,
            children: (
              <Popup>
                <div className="route-popup">
                  <h4>{t('direct_links.neighbor_connection', 'Neighbor Connection')}</h4>
                  <div className="route-endpoints">
                    <strong>{ni.neighborName}</strong> <UiIcon name={isBidirectional ? 'bidirectional' : 'forward'} size={14} /> <strong>{ni.nodeName}</strong>
                  </div>
                  {isBidirectional && (
                    <div className="route-usage" style={{ color: 'var(--color-success)' }}>
                      <UiIcon name="bidirectional" size={14} /> {t('direct_links.bidirectional', 'Bidirectional')}
                    </div>
                  )}
                  {ni.snr !== null && ni.snr !== undefined && (
                    <div className="route-usage">
                      SNR: <strong style={{ color: snrTextColor }}>{ni.snr.toFixed(1)} dB</strong>
                    </div>
                  )}
                  {distStr && (
                    <div className="route-usage">
                      {t('direct_links.distance', 'Distance')}: <strong>{distStr}</strong>
                    </div>
                  )}
                  <div className="route-usage">
                    {t('direct_links.last_seen', 'Last seen')}: <strong>{formatDateTime(new Date(tsMs), timeFormat, dateFormat)}</strong> ({ageStr})
                  </div>
                </div>
              </Popup>
            ),
          };
        })
        .filter((d): d is NeighborLinkDescriptor => d !== null)
    : [];

  // Calculate center point of all nodes for initial map view
  // Use saved map center from localStorage if available, otherwise calculate from nodes
  const getMapCenter = (): { center: [number, number]; zoom: number } => {
    // 1. Saved localStorage position (logged-in user's last session)
    if (mapCenter) {
      return { center: mapCenter, zoom: mapZoom };
    }

    // 2. Configured default center (from server settings)
    if (
      defaultMapCenterLat !== null &&
      defaultMapCenterLon !== null &&
      defaultMapCenterZoom !== null
    ) {
      return {
        center: [defaultMapCenterLat, defaultMapCenterLon],
        zoom: defaultMapCenterZoom,
      };
    }

    // 3. Calculated from visible nodes
    if (nodesWithPosition.length > 0) {
      // Prioritize the locally connected node's position for first-time visitors
      // Uses effective position to respect position overrides (Issue #1526)
      if (currentNodeId) {
        const localNode = nodesWithPosition.find(node => node.user?.id === currentNodeId);
        if (localNode) {
          const effectivePos = getEffectivePosition(localNode);
          if (effectivePos.latitude != null && effectivePos.longitude != null) {
            return { center: [effectivePos.latitude, effectivePos.longitude], zoom: mapZoom };
          }
        }
      }

      // Fall back to average position of all nodes (using effective positions)
      const avgLat = nodesWithPosition.reduce((sum, node) => {
        const pos = getEffectivePosition(node);
        return sum + (pos.latitude ?? 0);
      }, 0) / nodesWithPosition.length;
      const avgLng = nodesWithPosition.reduce((sum, node) => {
        const pos = getEffectivePosition(node);
        return sum + (pos.longitude ?? 0);
      }, 0) / nodesWithPosition.length;
      return { center: [avgLat, avgLng], zoom: mapZoom };
    }

    // 4. World view (absolute last resort)
    return { center: [20, 0], zoom: 2 };
  };

  const mapDefaults = getMapCenter();

  // #4704: whether the 3D surface is actually on screen right now.
  const effective3D = viewMode === '3d' && canUse3D;

  return (
    <div ref={splitViewRef} className="nodes-split-view nodes-anchored-view">
      {/* Anchored Node List Sidebar */}
      <div
        ref={sidebarRef}
        className={`nodes-sidebar nodes-anchored-sidebar ${isNodeListCollapsed ? 'collapsed' : ''} ${isSidebarResizing ? 'resizing' : ''}`}
        style={!isNodeListCollapsed ? { width: `${sidebarWidth}px` } : undefined}
      >
        <div className="sidebar-header">
          <button
            className="collapse-nodes-btn"
            onClick={handleCollapseNodeList}
            title={isNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
          >
            <UiIcon name={isNodeListCollapsed ? 'forward' : 'back'} size={18} />
          </button>
          {!isNodeListCollapsed && (
          <div className="sidebar-header-content">
            <h3>Nodes ({(() => {
              const filteredCount = processedNodes.filter(node => {
                // Security filter
                if (securityFilter === 'flaggedOnly') {
                  if (!node.keyIsLowEntropy && !node.duplicateKeyDetected && !node.keySecurityIssueDetails) return false;
                }
                if (securityFilter === 'hideFlagged') {
                  if (node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) return false;
                }
                // Incomplete nodes filter
                if (!showIncompleteNodes && !isNodeComplete(node)) {
                  return false;
                }
                // Remote admin filter
                if (filterRemoteAdminOnly && !node.hasRemoteAdmin) {
                  return false;
                }
                return true;
              }).length;
              const isFiltered = securityFilter !== 'all' || !showIncompleteNodes || filterRemoteAdminOnly;
              return isFiltered ? `${filteredCount}/${processedNodes.length}` : processedNodes.length;
            })()})</h3>
          </div>
          )}
          {!isNodeListCollapsed && (
          <div className="node-controls">
            <div className="filter-input-wrapper">
              <input
                type="text"
                placeholder={t('nodes.filter_placeholder')}
                value={nodesNodeFilter}
                onChange={(e) => setNodesNodeFilter(e.target.value)}
                className="filter-input-small"
              />
              {nodesNodeFilter && (
                <button
                  className="filter-clear-btn"
                  onClick={() => setNodesNodeFilter('')}
                  title={t('common.clear_filter')}
                  type="button"
                >
                  <UiIcon name="close" size={16} />
                </button>
              )}
            </div>
            <div className="sort-controls">
              <button
                className="filter-popup-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  handleToggleFilterPopup();
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                }}
                title={t('nodes.filter_title')}
              >
                {t('common.filter')}
              </button>
              <select
                value={sortField}
                onChange={(e) => setSortField(e.target.value as any)}
                className="sort-dropdown"
                title={t('nodes.sort_by')}
              >
                <option value="longName">{t('nodes.sort_name')}</option>
                <option value="shortName">{t('nodes.sort_short_name')}</option>
                <option value="id">{t('nodes.sort_id')}</option>
                <option value="lastHeard">{t('nodes.sort_updated')}</option>
                <option value="uptime">{t('nodes.sort_uptime')}</option>
                <option value="snr">{t('nodes.sort_signal')}</option>
                <option value="battery">{t('nodes.sort_charge')}</option>
                <option value="hwModel">{t('nodes.sort_hardware')}</option>
                <option value="hops">{t('nodes.sort_hops')}</option>
              </select>
              <button
                className="sort-direction-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  handleToggleSortDirection();
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                }}
                title={sortDirection === 'asc' ? t('nodes.ascending') : t('nodes.descending')}
              >
                <UiIcon name={sortDirection === 'asc' ? 'sortAscending' : 'sortDescending'} />
              </button>
              <div className="export-dropdown" ref={exportMenuRef}>
                <button
                  className="sort-direction-btn export-trigger-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    setShowExportMenu((v) => !v);
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                  }}
                  disabled={displayedNodes.length === 0}
                  title={t('nodes.export', 'Export node list')}
                  aria-haspopup="menu"
                  aria-expanded={showExportMenu}
                >
                  <UiIcon name="download" />
                </button>
                {showExportMenu && (
                  <div className="export-menu" role="menu">
                    <button
                      className="export-menu-item"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.nativeEvent.stopImmediatePropagation();
                        handleExportNodes('csv');
                      }}
                      title={t('nodes.export_csv', 'Export node list as CSV')}
                    >
                      CSV
                    </button>
                    <button
                      className="export-menu-item"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.nativeEvent.stopImmediatePropagation();
                        handleExportNodes('html');
                      }}
                      title={t('nodes.export_html', 'Export node list as HTML')}
                    >
                      HTML
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          )}
        </div>
        {!isNodeListCollapsed && (
        <div className="nodes-list">
          {/* Meshtastic nodes section */}
          {shouldShowData() ? (() => {
            // Find the home node for distance calculations (use unfiltered nodes to ensure home node is found)
            const homeNode = nodes.find(n => n.user?.id === currentNodeId);

            // Filtered + favorites-first sorted set, shared with the export (Issue #3499)
            const sortedNodes = displayedNodes;

            return sortedNodes.length > 0 ? (
              <>
              {/* Meshtastic nodes */}
              {sortedNodes.map(node => {
                // #4880: color the node box per the active Node List Style
                // ({} for monochrome, keeping the theme look).
                const nc = nodeColorStyle(nodeListStyle, {
                  nodeNum: node.nodeNum,
                  hopsAway: node.hopsAway,
                  isFavorite: node.isFavorite,
                });
                return (
                <div
                  key={node.nodeNum}
                  className={`node-item ${selectedNodeId === node.user?.id ? 'selected' : ''}`}
                  style={nc.background ? { background: nc.background, color: nc.text } : undefined}
                  onClick={handleNodeClick(node)}
                  /* Second path to Node Details, matching MeshCore's node list
                     (#4379). Single-click is already taken — it selects the node
                     and centers the map on it — so double-click is the free slot. */
                  onDoubleClick={hasPermission('messages', 'read') ? handleNodeDetailsClick(node) : undefined}
                >
                  <div className="node-header">
                    <div className="node-name">
                      <span className="favorite-wrapper">
                        <button
                          className={`favorite-star${node.isFavorite && !node.favoriteLocked ? ' favorite-auto' : ''}`}
                          title={node.isFavorite
                            ? (node.favoriteLocked
                              ? t('nodes.remove_favorite')
                              : t('nodes.remove_favorite_auto', 'Remove auto-favorite'))
                            : t('nodes.add_favorite')}
                          onClick={handleFavoriteClick(node)}
                        >
                          <UiIcon name={node.isFavorite ? 'favorite' : 'favoriteOff'} size={17} />
                        </button>
                        {node.isFavorite && node.favoriteLocked && toggleFavoriteLock && (
                          <button
                            className="favorite-lock"
                            title={t('nodes.unlock_favorite', 'Unlock — let automation manage this favorite')}
                            onClick={handleLockClick(node)}
                          >
                            <UiIcon name="encrypted" size={15} />
                          </button>
                        )}
                      </span>
                      <div className="node-name-text">
                        <div className="node-longname">
                          {node.user?.longName || `Node ${node.nodeNum}`}
                        </div>
                        {node.user?.role !== undefined && node.user?.role !== null && getRoleName(node.user.role) && (
                          <div className="node-role" title={t('nodes.node_role')}>{getRoleName(node.user.role)}</div>
                        )}
                        {/* Status Message (#4818): the node's self-broadcast status,
                            shown as a short subtitle like the official clients. Styled via
                            a CSS module (not the frozen nodes.css). Rendered verbatim
                            (React escapes untrusted mesh text); title shows the full text. */}
                        {node.nodeStatus && (
                          <div className={nodeStatusStyles.statusLine} title={node.nodeStatus}>
                            {node.nodeStatus}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="node-actions">
                      {/* #4379: inert status icons and interactive controls used to
                          share one undifferentiated strip, so nothing signalled which
                          of them you could click. They are now two groups with a rule
                          between them — facts on the left, actions on the right. */}
                      <span className={nodeRowStyles.indicators}>
                        {node.position && node.position.latitude != null && node.position.longitude != null && (
                          <span className="node-indicator-icon" title={t('nodes.location')}><UiIcon name="location" size={15} /></span>
                        )}
                        {node.viaMqtt && (
                          <span className="node-indicator-icon" title={t('nodes.via_mqtt')}><UiIcon name="network" size={15} /></span>
                        )}
                        {node.isStoreForwardServer && (
                          <span className="node-indicator-icon" title={t('nodes.store_forward_server', 'Store & Forward Server')}><UiIcon name="package" size={15} /></span>
                        )}
                        {node.user?.id && nodesWithTelemetry.has(node.user.id) && (
                          <span className="node-indicator-icon" title={t('nodes.has_telemetry')}><UiIcon name="telemetry" size={15} /></span>
                        )}
                        {node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
                          <span className="node-indicator-icon" title={t('nodes.has_weather')}><UiIcon name="weather" size={15} /></span>
                        )}
                        {node.user?.id && nodesWithPKC.has(node.user.id) && (
                          <span className="node-indicator-icon" title={t('nodes.has_pkc')}><UiIcon name="encryptedKey" size={15} /></span>
                        )}
                        {node.hasRemoteAdmin && (
                          <span className="node-indicator-icon" title={t('nodes.has_remote_admin')}><UiIcon name="wrench" size={15} /></span>
                        )}
                        {node.isUnmessagable && <NodeUnmessageableBadge />}
                        {/* #4720: mark a node we have no NODEINFO for. The row is
                            otherwise indistinguishable from a synced one unless you
                            hold nodes:write, which reveals the Copy NodeInfo action
                            below — this states the fact for everyone. */}
                        {!isNodeComplete(node) && <NodeIncompleteBadge />}
                        {/* The read-only half of the security warning. Its clickable
                            twin lives in the action group below. */}
                        {(node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) && !hasPermission('security', 'write') && (
                          <span
                            className="security-warning-icon"
                            title={node.keySecurityIssueDetails || t('nodes.security_risk_generic', 'Key security issue detected')}
                            style={{
                              fontSize: '16px',
                              color: '#f44336',
                              cursor: 'help'
                            }}
                          >
                            <UiIcon name={node.keyMismatchDetected ? 'unlock' : 'alert'} size={16} />
                          </span>
                        )}
                      </span>
                      <span className={nodeRowStyles.actions}>
                        {!isNodeComplete(node) && hasPermission('nodes', 'write') && (
                          <button
                            className="dm-icon"
                            title={t('nodes.copy_nodeinfo')}
                            onClick={handleCopyNodeInfoClick(node)}
                          >
                            <UiIcon name="copy" size={16} />
                          </button>
                        )}
                        {(node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) && hasPermission('security', 'write') && (
                          <button
                            className="security-warning-icon"
                            title={t(
                              'nodes.security_risk_clear_title',
                              '{{details}} — click to clear this security warning',
                              { details: node.keySecurityIssueDetails || t('nodes.security_risk_generic', 'Key security issue detected') }
                            )}
                            aria-label={t(
                              'nodes.security_risk_clear_title',
                              '{{details}} — click to clear this security warning',
                              { details: node.keySecurityIssueDetails || t('nodes.security_risk_generic', 'Key security issue detected') }
                            )}
                            disabled={clearingSecurityNode === node.nodeNum}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleClearSecurityWarning(node.nodeNum);
                            }}
                            style={{
                              fontSize: '16px',
                              color: '#f44336',
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: clearingSecurityNode === node.nodeNum ? 'default' : 'pointer',
                              opacity: clearingSecurityNode === node.nodeNum ? 0.5 : 1,
                            }}
                          >
                            <UiIcon name={node.keyMismatchDetected ? 'unlock' : 'alert'} size={16} />
                          </button>
                        )}
                        {/* Every node gets this, messageable or not — #4379 asks for
                            one consistent route to Node Details rather than an
                            affordance that only appears on unmessageable rows. It
                            also replaces the Send-DM button that used to sit right
                            here: two adjacent controls going to the same place was
                            the redundancy #4379 set out to remove. It stays gated
                            on messages:read because Node Details still lives inside
                            the Messages tab. */}
                        {hasPermission('messages', 'read') && (
                          <NodeDetailsButton onOpenDetails={handleNodeDetailsClick(node)} />
                        )}
                      </span>
                      <div className="node-short">
                        {node.user?.shortName || '-'}
                      </div>
                    </div>
                  </div>

                  <div className="node-details">
                    <div className="node-stats">
                      {node.hopsAway === 0 && node.snr != null && (
                        <span className="stat" title={t('nodes.snr')}>
                          <UiIcon name="wifi" size={14} /> {node.snr.toFixed(1)}dB
                        </span>
                      )}
                      {node.hopsAway === 0 && node.rssi != null && (
                        <span className="stat" title={t('nodes.rssi')}>
                          <UiIcon name="radioSignal" size={14} /> {node.rssi}dBm
                        </span>
                      )}
                      {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                        <span className="stat" title={node.deviceMetrics.batteryLevel === 101 ? t('nodes.plugged_in') : t('nodes.battery_level')}>
                          <UiIcon name={node.deviceMetrics.batteryLevel === 101 ? 'batteryCharging' : 'battery'} size={14} /> {node.deviceMetrics.batteryLevel === 101 ? t('nodes.plugged_in') : `${node.deviceMetrics.batteryLevel}%`}
                        </span>
                      )}
                      {node.deviceMetrics?.voltage !== undefined && node.deviceMetrics.voltage !== null && (
                        <span className="stat" title={t('nodes.voltage')}>
                          <UiIcon name="zap" size={14} /> {node.deviceMetrics.voltage.toFixed(2)}V
                        </span>
                      )}
                      {(node.hopsAway != null || node.lastMessageHops != null) && (() => {
                        const effectiveHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                        return effectiveHops < 999 ? (
                          <span className="stat" title={t('nodes.hops_away')}>
                            <UiIcon name="link" size={14} /> {effectiveHops} {t('nodes.hop', { count: effectiveHops })}
                            {node.channel != null && node.channel !== 0 && ` (ch:${node.channel})`}
                          </span>
                        ) : null;
                      })()}
                      <DistanceDisplay
                        homeNode={homeNode}
                        targetNode={node}
                        distanceUnit={distanceUnit}
                        t={t}
                      />
                    </div>

                    <div className="node-time">
                      {node.lastHeard ? (() => {
                        const date = new Date(node.lastHeard * 1000);
                        return isToday(date)
                          ? formatTime(date, timeFormat)
                          : formatDateTime(date, timeFormat, dateFormat);
                      })() : t('time.never')}
                    </div>
                  </div>

                </div>
                );
              })}
              </>
            ) : (
              <div className="no-data">
                {securityFilter !== 'all' ? 'No nodes match security filter' : (nodesNodeFilter ? 'No nodes match filter' : 'No nodes detected')}
              </div>
            );
          })() : (
            <div className="no-data">
              Connect to Meshtastic node
            </div>
          )}
        </div>
        )}
        {/* Resize handle on right edge of sidebar */}
        {!isNodeListCollapsed && (
          <div
            className="nodes-sidebar-resize-handle"
            onMouseDown={handleSidebarResizeStart}
            onTouchStart={handleSidebarTouchStart}
            title="Drag to resize"
          />
        )}
      </div>

      {/* Right Side - Map and Optional Packet Monitor */}
      <div className="nodes-map-area">
      <div
        className={`map-container ${showPacketMonitor && canViewPacketMonitor ? 'with-packet-monitor' : ''}`}
        style={showPacketMonitor && canViewPacketMonitor ? { height: `calc(100% - ${packetMonitorHeight}px)` } : undefined}
      >
        {shouldShowData() && (
            <MapSidebar storageKey="mm-nodes-map-sidebar" title="Map controls">
              <div className="map-controls-body">
              <div
                className="map-controls-header"
              >
                <div className="map-controls-title">
                  Features
                </div>
                {/* Zoom to fit all nodes (#4496). Sits in the header so it stays
                    reachable when the panel is collapsed — the whole point is a
                    one-tap re-frame, which a click-to-expand-first would spoil. */}
                <button
                  className="map-controls-fit-btn"
                  onClick={() => setFitAllRequest(n => n + 1)}
                  disabled={fitAllPositions.length === 0}
                  title={
                    fitAllPositions.length === 0
                      ? 'No positioned nodes to zoom to'
                      : `Zoom to fit all ${fitAllPositions.length} positioned nodes`
                  }
                  aria-label="Zoom to fit all nodes"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <UiIcon name="fitBounds" size={16} />
                </button>
              </div>
                <>
                  {/* #3636: node-to-node LOS distance measurement toggle. */}
                  <label className="map-control-item" title="Measure straight-line distance between two nodes">
                    <input
                      type="checkbox"
                      checked={measureActive}
                      disabled={measurePoints.length < 2}
                      onChange={(e) => setMeasureActive(e.target.checked)}
                    />
                    <span>Measure Distance</span>
                  </label>
                  {/* #4704: 2D/3D toggle — only offered when the server can
                      serve DEM terrain tiles (elevation enabled + terrarium). */}
                  {canUse3D && (
                    <label className="map-control-item" title="Show terrain in a pitched 3D view">
                      <input
                        type="checkbox"
                        checked={viewMode === '3d'}
                        onChange={(e) => setViewMode(e.target.checked ? '3d' : '2d')}
                      />
                      <span>3D Terrain</span>
                    </label>
                  )}
                  {/* Map Features age slider (#3322): hides node markers,
                      traceroutes, and route segments older than the chosen age.
                      Ranges 1h–maxNodeAgeHours (settings); default = max ("All"). */}
                  {(() => {
                    // Non-linear discrete stops (1h..30d) instead of a linear
                    // per-hour tick — see mapAgeSteps (#4770). Bounded by the
                    // per-source maxNodeAgeHours setting.
                    const maxHours = Math.max(1, Math.round(maxNodeAgeHours));
                    const stops = ageFilterStops(maxHours);
                    const topIndex = stops.length - 1;
                    const currentHours = Math.min(Math.max(1, Math.round(effectiveMapMaxAge)), maxHours);
                    const currentIndex = nearestAgeStopIndex(stops, currentHours);
                    const label = (idx: number) =>
                      formatAgeStop(stops[idx], maxHours, t('map.maxAgeAll', 'All'));
                    return (
                      <div className="map-control-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }}>
                        <span>{t('map.maximumAge', 'Maximum age')}</span>
                        <div className="position-history-slider">
                          <input
                            type="range"
                            min={0}
                            max={topIndex}
                            step={1}
                            value={currentIndex}
                            aria-label={t('map.maximumAge', 'Maximum age')}
                            aria-valuemin={0}
                            aria-valuemax={topIndex}
                            aria-valuenow={currentIndex}
                            aria-valuetext={label(currentIndex)}
                            disabled={topIndex < 1}
                            onChange={(e) => {
                              const idx = parseInt(e.target.value, 10);
                              // Top stop == the setting cap → store null so the map follows the setting.
                              setMapMaxAgeHours(idx >= topIndex ? null : stops[idx]);
                            }}
                          />
                          <span className="slider-value">{label(currentIndex)}</span>
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
                    <span>{t('map.showRouteSegments')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showNeighborInfo}
                      onChange={(e) => setShowNeighborInfo(e.target.checked)}
                    />
                    <span>{t('map.showNeighborInfo')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showRoute}
                      onChange={(e) => setShowRoute(e.target.checked)}
                    />
                    <span>{t('map.showTraceroute')}</span>
                  </label>
                  {tracerouteNodeNums && (
                    <button
                      className="dismiss-traceroute-btn"
                      onClick={() => setSelectedNodeId(null)}
                      title="Clear the active traceroute and show all nodes"
                    >
                      Dismiss Traceroute
                    </button>
                  )}
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showRfNodes}
                      onChange={(e) => setShowRfNodes(e.target.checked)}
                    />
                    <span>{t('map.showRf', 'Show RF')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showUdpNodes}
                      onChange={(e) => setShowUdpNodes(e.target.checked)}
                    />
                    <span>{t('map.showUdp', 'Show UDP')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showMqttNodes}
                      onChange={(e) => setShowMqttNodes(e.target.checked)}
                    />
                    <span>{t('map.showMqtt')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showWaypoints}
                      onChange={(e) => setShowWaypoints(e.target.checked)}
                    />
                    <span>{t('map.showWaypoints', 'Show Waypoints')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showAtakContacts}
                      onChange={(e) => setShowAtakContacts(e.target.checked)}
                    />
                    <span>{t('map.showAtakContacts', 'Show ATAK Contacts')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showMotion}
                      onChange={(e) => setShowMotion(e.target.checked)}
                    />
                    <span>{t('map.showPositionHistory')}</span>
                  </label>
                  {showMotion && (
                    <label className="map-control-item" style={{ paddingLeft: '1.5rem' }}>
                      <input
                        type="checkbox"
                        checked={positionHistoryPointsOnly}
                        onChange={(e) => setPositionHistoryPointsOnly(e.target.checked)}
                      />
                      <span>{t('map.positionHistoryPointsOnly', 'Points only (no line)')}</span>
                    </label>
                  )}
                  {showMotion && positionHistory.length > 1 && (() => {
                    // Calculate max hours from oldest position in history
                    const oldestTimestamp = positionHistory[0].timestamp;
                    const now = Date.now();
                    const maxHours = Math.max(1, Math.ceil((now - oldestTimestamp) / (1000 * 60 * 60)));

                    // Current slider value (default to max if not set)
                    const currentHours = positionHistoryHours ?? maxHours;

                    // Format the display value
                    const formatDuration = (hours: number, isMax: boolean): string => {
                      if (isMax && hours === maxHours) return 'All';
                      if (hours < 24) return `${hours}h`;
                      const days = Math.floor(hours / 24);
                      const remainingHours = hours % 24;
                      if (remainingHours === 0) return `${days}d`;
                      return `${days}d ${remainingHours}h`;
                    };

                    return (
                      <div className="position-history-slider">
                        <input
                          type="range"
                          min={1}
                          max={maxHours}
                          value={currentHours}
                          aria-label="Position history duration"
                          aria-valuemin={1}
                          aria-valuemax={maxHours}
                          aria-valuenow={currentHours}
                          aria-valuetext={formatDuration(currentHours, currentHours >= maxHours)}
                          onChange={(e) => {
                            const value = parseInt(e.target.value, 10);
                            // Set to null if at max (show all)
                            setPositionHistoryHours(value >= maxHours ? null : value);
                          }}
                        />
                        <span className="slider-value">{formatDuration(currentHours, currentHours >= maxHours)}</span>
                      </div>
                    );
                  })()}
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showAnimations}
                      onChange={(e) => setShowAnimations(e.target.checked)}
                    />
                    <span>{t('map.showAnimations')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showEstimatedPositions}
                      onChange={(e) => setShowEstimatedPositions(e.target.checked)}
                    />
                    <span>{t('map.showEstimatedPositions')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showAccuracyRegions}
                      onChange={(e) => setShowAccuracyRegions(e.target.checked)}
                    />
                    <span>{t('map.showAccuracyRegions')}</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showPolarGrid}
                      onChange={(e) => setShowPolarGrid(e.target.checked)}
                      disabled={!ownNodePosition}
                    />
                    <span title={!ownNodePosition ? t('map.polarGridDisabledTooltip') : undefined}>
                      {t('map.showPolarGrid')}
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
                  {geoJsonLayers.map(layer => (
                    <label key={layer.id} className="map-control-item">
                      <input
                        type="checkbox"
                        checked={layer.visible}
                        onChange={(e) => {
                          const newLayers = geoJsonLayers.map(l =>
                            l.id === layer.id ? { ...l, visible: e.target.checked } : l
                          );
                          setGeoJsonLayers(newLayers);
                          api.getBaseUrl().then(baseUrl => {
                            csrfFetch(`${baseUrl}/api/geojson/layers/${layer.id}`, {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ visible: e.target.checked }),
                            }).catch(err => console.error('Failed to update layer visibility:', err));
                          }).catch(err => console.error('Failed to get base URL:', err));
                        }}
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
                  {getTilesetById(activeTileset, customTilesets).isVector && mapStyles.length > 0 && (
                    <div className="map-control-item">
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85em' }}>
                        Map Style
                        <select
                          value={activeStyleId ?? ''}
                          onChange={(e) => {
                            const styleId = e.target.value || null;
                            void setActiveMapStyleId(styleId);
                          }}
                          style={{ padding: '2px 6px', border: '1px solid var(--border-color, #ccc)', borderRadius: '3px', background: 'var(--input-bg, #fff)', color: 'var(--text-color, #000)' }}
                        >
                          <option value="">Default Style</option>
                          {mapStyles.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {canViewPacketMonitor && packetLogEnabled && (
                    <label className="map-control-item packet-monitor-toggle">
                      <input
                        type="checkbox"
                        checked={showPacketMonitor}
                        onChange={(e) => setShowPacketMonitor(e.target.checked)}
                      />
                      <span>Show Packet Monitor</span>
                    </label>
                  )}
                  {canWriteWaypoints && shouldShowData() && (
                    <button
                      type="button"
                      className="waypoint-create-button"
                      onClick={startCreateBlank}
                      disabled={placingWaypoint}
                      title="Place a new waypoint by clicking on the map"
                    >
                      <UiIcon name="plus" /> Waypoint
                    </button>
                  )}
                </>
              </div>
              {showLegend && (
                <MapLegend
                  positionHistory={positionHistoryLegendData}
                  unmappedCount={unmappedCount}
                  embedded
                />
              )}
              {shouldShowData() && showTileSelector && (
                <TilesetSelector selectedTilesetId={activeTileset} onTilesetChange={setMapTileset} embedded />
              )}
            </MapSidebar>
        )}
            {/* #4326: "Show Traceroute" silently changes what clicking a node
                does — for any node with a stored route the info popup is
                suppressed in favor of the route overlay (see the
                `!(showRoute && hasValidTraceroute)` popup gate above). The
                only evidence of that mode used to be a checkbox inside the
                Features panel, which is collapsible and draggable, so the
                behavior read as random. This banner lives outside that panel
                and stays put. */}
            {shouldShowData() && showRoute && (
              <MapModeIndicator
                icon="route"
                label={t('map.tracerouteModeActive', 'Traceroute mode')}
                hint={t(
                  'map.tracerouteModeHint',
                  'Clicking a node with a stored route shows its path instead of its info popup'
                )}
                onDisable={() => setShowRoute(false)}
                disableLabel={t('map.tracerouteModeDisable', 'Turn off Show Traceroute')}
              />
            )}
            {effective3D ? (
              <>
                {/* #4704: 3D terrain surface. Shows nodes + traceroute +
                    neighbor lines only (v1 non-goals: waypoints, ATAK, polar
                    grid, accuracy regions, estimated positions, GeoJSON,
                    position history, measure tool). The tileset selector is a
                    sibling because Base3DMap can't host it. */}
                <Map3DView
                  center={mapDefaults.center}
                  zoom={mapDefaults.zoom}
                  basemap={basemap3D}
                  terrainTileUrl={terrainTileUrl}
                  nodes={node3DFeatures}
                  sourceIds={currentSourceId ? [currentSourceId] : []}
                  // Guard the "empty = all sources" hook convention: with no
                  // source (useSource() is null outside a SourceProvider), draw
                  // the nodes but NOT cross-source neighbor/traceroute lines,
                  // rather than silently pulling every source's edges in.
                  showNeighbors={!!currentSourceId && showNeighborInfo}
                  showTraceroutes={!!currentSourceId && (showPaths || showRoute)}
                  lookbackHours={effectiveMapMaxAge}
                  visibleNodeNums={visible3DNodeNums}
                  renderPopup={(key) => {
                    const node = node3DByKey.get(key);
                    const pos = node ? nodePositions.get(node.nodeNum) : undefined;
                    return node && pos ? (
                      <DashboardNodePopup node={node} pos={{ lat: pos[0], lng: pos[1] }} />
                    ) : null;
                  }}
                  onUnsupported={() => setViewMode('2d')}
                />
              </>
            ) : (
            <BaseMap
              center={mapDefaults.center}
              zoom={mapDefaults.zoom}
              tilesetId={activeTileset}
              customTilesets={customTilesets}
              styleJson={activeStyleJson ?? undefined}
              resizeTrigger={`${showPacketMonitor}-${isNodeListCollapsed}-${packetMonitorHeight}`}
            >
              <MapCenterController
                centerTarget={mapCenterTarget}
                onCenterComplete={handleCenterComplete}
                targetZoom={mapCenterTargetZoom}
              />
              <TracerouteBoundsController bounds={tracerouteBounds} />
              <FitAllNodesController request={fitAllRequest} positions={fitAllPositions} />
              <ZoomHandler onZoomChange={setMapZoom} />
              <MapPositionHandler />
              <WaypointMapEventBridge
                placing={placingWaypoint}
                canCreate={canWriteWaypoints}
                onPick={(lat, lon) => startCreateAtCoords(lat, lon)}
              />
              {showWaypoints && <DashboardWaypoints sourceId={currentSourceId ?? null} actions={waypointActions} />}
              {showAtakContacts && <DashboardAtakContacts sourceId={currentSourceId ?? null} />}
              <DefaultCenterController
                lat={defaultMapCenterLat}
                lon={defaultMapCenterLon}
                zoom={defaultMapCenterZoom}
              />
          {measureActive && (
            <MeasureDistanceController
              active={measureActive}
              points={measurePoints}
              onExit={() => setMeasureActive(false)}
            />
          )}
              <NodeMarkersLayer markers={nodeMarkers} onOmsClick={onOmsClick} />

              {/* Draw uncertainty circles for estimated positions. The "Show
                  Accuracy" map toggle now governs the radius (issue #3271
                  follow-up) — turning it off declutters the circles while the
                  estimated-node markers stay under "Show Estimated Positions".
                  Both are required so a circle never renders without its marker.
                  Single-consumer (#4047 Phase 7 spec §5.2) — no other map draws
                  estimated-position uncertainty radii, so this stays inline
                  rather than becoming a speculative one-consumer abstraction. */}
              {showEstimatedPositions && showAccuracyRegions && nodesWithPosition
                .filter(node => node.user?.id && nodesWithEstimatedPosition.has(node.user.id) && nodePassesTransportFilter(node, { showRfNodes, showUdpNodes, showMqttNodes }, transportCutoff) && (showIncompleteNodes || isNodeComplete(node)) && (!tracerouteNodeNums || tracerouteNodeNums.has(node.nodeNum)))
                .map(node => {
                  // Use the real multilateration uncertainty radius (issue #3271) when
                  // available; fall back to a 500m base for legacy/missing data.
                  const uncertaintyKm = node.user?.id ? estimatedUncertainty[node.user.id] : undefined;
                  const radiusMeters = uncertaintyKm != null && uncertaintyKm > 0
                    ? uncertaintyKm * 1000
                    : 500;

                  // Get hop color for the circle (same as marker)
                  const isLocalNode = node.user?.id === currentNodeId;
                  const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                  const color = getHopColor(hops, overlayColors.hopColors);

                  return (
                    <Circle
                      key={`estimated-${node.nodeNum}`}
                      center={[node.position!.latitude, node.position!.longitude]}
                      radius={radiusMeters}
                      pathOptions={{
                        color: color,
                        fillColor: color,
                        fillOpacity: 0.1,
                        opacity: 0.4,
                        weight: 2,
                        dashArray: '5, 5'
                      }}
                    />
                  );
                })}

              {/* Position accuracy regions — shared layer (#4047 Phase 7 WP11),
                  hop-colored `pathOptions` computed in the `accuracyRegions`
                  adapter above (ties visually to the hop-colored marker; NOT
                  the shared layer's canonical gray default). */}
              <AccuracyRegionsLayer regions={accuracyRegions} />

              {showPolarGrid && ownNodePosition && (
                <PolarGridOverlay center={ownNodePosition} />
              )}

              <GeoJsonOverlay layers={geoJsonLayers} />

              {/* Draw traceroute paths (independent layer) */}
              <TraceroutePathsContainer paths={traceroutePathsElements} enabled={showPaths} />

              {/* Draw selected node traceroute (independent layer) */}
              <SelectedTracerouteContainer traceroute={selectedNodeTraceroute} enabled={showRoute} />

              {/* Neighbor info connections — shared layer (#4047 Phase 7 WP11),
                  descriptors built in the `neighborLinks` adapter above
                  (4-tier SNR pathOptions, hover-dim className, unidirectional
                  arrows, popup). */}
              <NeighborLinksLayer links={neighborLinks} />

              {/* Note: Selected node traceroute with separate forward and back paths */}
              {/* This is handled by traceroutePathsElements passed from parent */}

              {/* Draw position history for mobile nodes with color gradient.
                  Single-consumer rich single-node form (#4047 Phase 7 spec
                  §5.3) — MapAnalysis's multi-node PositionTrailsLayer and
                  MeshCoreMap's arrowless multi-node trails are deliberately
                  different visualizations; this stays inline. */}
              {positionHistoryElements}

          </BaseMap>
          )}
          {shouldShowData() && nodesIsLoading && <MapLoadingOverlay />}
          {shouldShowData() && !nodesIsLoading && nodesWithPosition.length === 0 && (
            <div className="map-overlay">
              <div className="overlay-content">
                <h3><UiIcon name="location" /> No Node Locations</h3>
                <p>No nodes in your network are currently sharing location data.</p>
                <p>Nodes with GPS enabled will appear as markers on this map.</p>
              </div>
            </div>
          )}
          {!shouldShowData() && (
          <div className="map-placeholder">
            <div className="placeholder-content">
              <h3>Map View</h3>
              <p>Connect to a Meshtastic node to view node locations on the map</p>
            </div>
          </div>
          )}
      </div>

      {/* Packet Monitor Panel */}
      {showPacketMonitor && canViewPacketMonitor && (
        <div
          className={`packet-monitor-container ${isPacketMonitorResizing ? 'resizing' : ''}`}
          style={{ height: `${packetMonitorHeight}px` }}
        >
          <div
            className="packet-monitor-resize-handle"
            onMouseDown={handlePacketMonitorResizeStart}
            onTouchStart={handlePacketMonitorTouchStart}
            title="Drag to resize"
          />
          <PacketMonitorPanel
            onClose={() => setShowPacketMonitor(false)}
            onNodeClick={handlePacketNodeClick}
          />
        </div>
      )}
      </div>

      {placingWaypoint && (
        <div className="waypoint-placement-hint" role="status">
          <span>Click the map to place the waypoint</span>
          <button type="button" onClick={() => setPlacingWaypoint(false)}>
            Cancel
          </button>
        </div>
      )}

      <WaypointEditorModal
        isOpen={waypointEditorOpen}
        initial={waypointEditorInitial}
        channels={sourceChannels}
        defaultCoords={waypointDefaultCoords}
        selfNodeNum={localNodeNum ?? null}
        onClose={() => setWaypointEditorOpen(false)}
        onSave={handleSaveWaypoint}
      />

      <CopyNodeInfoModal
        isOpen={copyNodeInfoTarget !== null}
        nodeNum={copyNodeInfoTarget?.nodeNum ?? null}
        currentNode={copyNodeInfoTarget ? {
          longName: copyNodeInfoTarget.user?.longName,
          shortName: copyNodeInfoTarget.user?.shortName,
          hwModel: copyNodeInfoTarget.user?.hwModel,
          role: copyNodeInfoTarget.user?.role != null ? Number(copyNodeInfoTarget.user.role) : null,
          publicKey: copyNodeInfoTarget.user?.publicKey,
          // #4244: without these three the modal's "Current" column showed "—"
          // regardless of what was stored.
          macaddr: copyNodeInfoTarget.user?.macaddr,
          hasPKC: copyNodeInfoTarget.user?.hasPKC,
          firmwareVersion: copyNodeInfoTarget.user?.firmwareVersion,
        } : null}
        onClose={() => setCopyNodeInfoTarget(null)}
        onCopied={() => setCopyNodeInfoTarget(null)}
      />
    </div>
  );
};

// Memoize NodesTab to prevent re-rendering when App.tsx updates for message status
// Only re-render when actual node data or map-related props change
const NodesTab = React.memo(NodesTabComponent, (prevProps, nextProps) => {
  // Check if favorite status or lock status changed for any node
  // Build maps of favorite node numbers with lock state for comparison
  const prevFavorites = new Map(
    prevProps.processedNodes.filter(n => n.isFavorite).map(n => [n.nodeNum, !!n.favoriteLocked])
  );
  const nextFavorites = new Map(
    nextProps.processedNodes.filter(n => n.isFavorite).map(n => [n.nodeNum, !!n.favoriteLocked])
  );

  // If the sets differ in size or content, favorites changed - must re-render
  if (prevFavorites.size !== nextFavorites.size) {
    return false; // Allow re-render
  }
  for (const [nodeNum, locked] of prevFavorites) {
    if (!nextFavorites.has(nodeNum) || nextFavorites.get(nodeNum) !== locked) {
      return false; // Allow re-render
    }
  }

  // Check if any node's position or lastHeard changed
  // If spiderfier is active (keepSpiderfied), avoid re-rendering to preserve fanout ONLY if just position changed
  // But always allow re-render if lastHeard changed (to update timestamps in node list)
  if (prevProps.processedNodes.length === nextProps.processedNodes.length) {
    let hasPositionChanges = false;
    let hasLastHeardChanges = false;

    for (let i = 0; i < prevProps.processedNodes.length; i++) {
      const prev = prevProps.processedNodes[i];
      const next = nextProps.processedNodes[i];

      if (prev.position?.latitude !== next.position?.latitude ||
          prev.position?.longitude !== next.position?.longitude) {
        hasPositionChanges = true;
      }

      if (prev.lastHeard !== next.lastHeard) {
        hasLastHeardChanges = true;
      }

      // Early exit if both detected
      if (hasPositionChanges && hasLastHeardChanges) break;
    }

    // If lastHeard changed, always re-render to update timestamps in node list
    if (hasLastHeardChanges) {
      return false; // Allow re-render
    }

    // If only position changed (no lastHeard changes), skip re-render to preserve spiderfier
    if (hasPositionChanges && !hasLastHeardChanges) {
      return true; // Skip re-render to keep markers stable
    }
  }

  // Check if traceroute data changed
  // This detects when "Show Paths" or "Show Route" checkboxes are toggled,
  // or when the selected node changes (different traceroute content)
  const prevPathsVisible = prevProps.traceroutePathsElements !== null;
  const nextPathsVisible = nextProps.traceroutePathsElements !== null;
  const prevRouteVisible = prevProps.selectedNodeTraceroute !== null;
  const nextRouteVisible = nextProps.selectedNodeTraceroute !== null;

  // If visibility changed, must re-render
  if (prevPathsVisible !== nextPathsVisible || prevRouteVisible !== nextRouteVisible) {
    return false; // Allow re-render
  }

  // If traceroute paths reference changed (hover dimming, SNR recalc), must re-render
  if (prevProps.traceroutePathsElements !== nextProps.traceroutePathsElements) {
    return false; // Allow re-render
  }

  // If traceroute reference changed (different selected node), must re-render
  // This handles the case where both old and new traceroutes are non-null but different
  if (prevProps.selectedNodeTraceroute !== nextProps.selectedNodeTraceroute) {
    return false; // Allow re-render
  }

  // If tracerouteNodeNums changed (active traceroute filtering), must re-render
  // This handles when a node is selected/deselected for traceroute display
  if (prevProps.tracerouteNodeNums !== nextProps.tracerouteNodeNums) {
    return false; // Allow re-render
  }

  // If tracerouteBounds changed (for zoom-to-fit), must re-render
  if (JSON.stringify(prevProps.tracerouteBounds) !== JSON.stringify(nextProps.tracerouteBounds)) {
    return false; // Allow re-render
  }

  // If connection status, TX-disabled state, or traceroute loading state
  // changed, must re-render (for traceroute button disabled state and
  // loading indicator; txDisabled added for epic #4294 Phase 2)
  if (prevProps.connectionStatus !== nextProps.connectionStatus ||
      prevProps.txDisabled !== nextProps.txDisabled ||
      prevProps.tracerouteLoading !== nextProps.tracerouteLoading) {
    return false; // Allow re-render
  }

  // For everything else (including MapContext changes like animatedNodes),
  // use default comparison which will cause re-render if props differ
  return false; // Allow re-render for other changes
});

export default NodesTab;
