import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/nodes.css';
import { Popup, Tooltip, Polyline, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Marker as LeafletMarker } from 'leaflet';
import { DeviceInfo } from '../types/device';
import { TabType } from '../types/ui';
import { nodePassesTransportFilter, transportCutoffSec } from '../utils/nodeTransport';
import { getNodeTypeCategory } from '../utils/nodeTypeCategory';
import { effectiveMapMaxAgeHours } from '../utils/mapAge';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { getPositionHistoryColor, generateHeadingAwarePath, generatePositionHistoryArrows, snrToColor } from '../utils/mapHelpers.tsx';
import { convertSpeed } from '../utils/speedConversion';
import { getEffectivePosition, getRoleName, hasValidEffectivePosition, isNodeComplete, parseNodeId, resolveMapEndpoint, resolveMarkerCenterTarget, TRACEROUTE_DISPLAY_HOURS } from '../utils/nodeHelpers';
import { applyPrecisionCellOffsets, hasAccuracyCell, precisionCellBounds } from '../utils/precisionOffset';
import { unifiedNodeKey } from '../utils/nodeIdentity';
import MapLegend from './MapLegend';
import { formatTime, formatDateTime } from '../utils/datetime';
import { getDistanceToNode, calculateDistance, formatDistance } from '../utils/distance';
import { getTilesetById } from '../config/tilesets';
import { getEffectiveHops, getMapHoverTooltipMeta } from '../utils/nodeHops';
import { buildNodeExportRows, nodesToCsv, nodesToHtml, downloadTextFile } from '../utils/nodeExport';
import { useMapContext } from '../contexts/MapContext';
import { useTelemetryNodes, useDeviceConfig, useNodes, setNodeFieldInCache } from '../hooks/useServerData';
import { useQueryClient } from '@tanstack/react-query';
import { useUI } from '../contexts/UIContext';
import { useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { useSource } from '../contexts/SourceContext';
import DashboardWaypoints from './Dashboard/DashboardWaypoints';
import WaypointEditorModal from './WaypointEditorModal';
import { useWaypoints } from '../hooks/useWaypoints';
import type { Waypoint, WaypointInput } from '../types/waypoint';
import { useResizable } from '../hooks/useResizable';
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
import { MapLoadingOverlay } from './map/MapLoadingOverlay';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from './map/layers/NeighborLinksLayer';
import { AccuracyRegionsLayer, type AccuracyRegionDescriptor } from './map/layers/AccuracyRegionsLayer';
import { NodeCard } from './map/popups/NodeCard';
import { IdentityItems, SignalItems, LastHeardFooter, TracerouteBody, NodeActions, type NodeActionSpec } from './map/popups/sections';
import { toNodeCardModel, type NodeCardModel } from './map/popups/nodeCardModel';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import api from '../services/api';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';
import type { MapStyle } from '../server/services/mapStyleService.js';
import { CopyNodeInfoModal } from './CopyNodeInfoModal';
import { UiIcon } from './icons';
import { useToast } from './ToastContainer';

interface NodesTabProps {
  processedNodes: DeviceInfo[];
  shouldShowData: () => boolean;
  centerMapOnNode: (node: DeviceInfo) => void;
  toggleFavorite: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  toggleFavoriteLock?: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  setActiveTab: (tab: TabType) => void;
  setSelectedDMNode: (nodeId: string) => void;
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
    console.log('[DefaultCenterController] effect fired', {
      applied: applied.current,
      hadSaved: hadSavedPosition.current,
      lat, lon, zoom,
    });
    if (applied.current || hadSavedPosition.current) return;
    if (lat !== null && lon !== null && zoom !== null) {
      console.log('[DefaultCenterController] applying configured default', lat, lon, zoom);
      applied.current = true;
      map.setView([lat, lon], zoom, { animate: false });
    }
  }, [map, lat, lon, zoom]);

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
 * Toggles the `waypoint-placing` class on the leaflet container so CSS can
 * change the cursor to a crosshair during placement.
 */
const WaypointMapEventBridge: React.FC<{
  placing: boolean;
  canCreate: boolean;
  onPick: (lat: number, lon: number) => void;
}> = ({ placing, canCreate, onPick }) => {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (placing) container.classList.add('waypoint-placing');
    else container.classList.remove('waypoint-placing');
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
  markerRefs,
  traceroutePathsElements,
  selectedNodeTraceroute,
  visibleNodeNums,
  tracerouteNodeNums,
  tracerouteBounds,
  onTraceroute,
  connectionStatus,
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
    showIncompleteNodes,
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
    customTilesets,
    distanceUnit,
    positionHistoryLineStyle,
    nodeDimmingEnabled,
    nodeDimmingStartHours,
    nodeDimmingMinOpacity,
    maxNodeAgeHours,
    nodeHopsCalculation,
    neighborInfoMinZoom,
    overlayColors,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapCenterTargetZoom,
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
    if (filteredPositionHistory.length < 2) return null;

    const elements: React.ReactElement[] = [];
    const segmentCount = filteredPositionHistory.length - 1;
    const segmentColors: string[] = [];

    for (let i = 0; i < segmentCount; i++) {
      const startPos = filteredPositionHistory[i];
      const endPos = filteredPositionHistory[i + 1];
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
      filteredPositionHistory,
      segmentColors,
      30,
      distanceUnit
    );
    elements.push(...historyArrows);

    return elements;
  }, [filteredPositionHistory, overlayColors.positionHistoryOld, overlayColors.positionHistoryNew, positionHistoryLineStyle, positionHistoryPointsOnly, timeFormat, dateFormat, distanceUnit]);

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

  // Node list sidebar resizable width (default 380px, min 200px, max 50% viewport)
  const {
    size: sidebarWidth,
    isResizing: isSidebarResizing,
    handleMouseDown: handleSidebarResizeStart,
    handleTouchStart: handleSidebarTouchStart
  } = useResizable({
    id: 'nodes-sidebar-width',
    defaultHeight: 380,
    minHeight: 200,
    maxHeight: Math.round(window.innerWidth * 0.5),
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
  const [mapStyles, setMapStyles] = useState<MapStyle[]>([]);
  const [activeStyleId, setActiveStyleId] = useState<string | null>(() => {
    try { return localStorage.getItem('meshmonitor-activeMapStyleId') || null; } catch { return null; }
  });
  const [activeStyleJson, setActiveStyleJson] = useState<Record<string, unknown> | null>(null);

  // Track if map controls are collapsed
  const [isMapControlsCollapsed, setIsMapControlsCollapsed] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('isMapControlsCollapsed');
    return saved === 'true';
  });

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

  const sidebarRef = useRef<HTMLDivElement>(null);

  // Save packet monitor preference to localStorage
  useEffect(() => {
    localStorage.setItem('showPacketMonitor', showPacketMonitor.toString());
  }, [showPacketMonitor]);

  // Save map controls collapse state to localStorage
  useEffect(() => {
    localStorage.setItem('isMapControlsCollapsed', isMapControlsCollapsed.toString());
  }, [isMapControlsCollapsed]);

  useEffect(() => {
    localStorage.setItem('meshmonitor-showTileSelector', showTileSelector.toString());
  }, [showTileSelector]);

  useEffect(() => {
    localStorage.setItem('meshmonitor-showLegend', showLegend.toString());
  }, [showLegend]);


  // Map controls position state with localStorage persistence
  // Position is relative to the map container (absolute positioning)
  // We use a special value of -1 to indicate "use CSS default (right: 10px)"
  const MAP_CONTROLS_DEFAULT_POSITION = { x: -1, y: 10 };

  const [mapControlsPosition, setMapControlsPosition] = useState(() => {
    // Migration: clear old left-based positions (now right-based)
    const oldSaved = localStorage.getItem('mapControlsPosition');
    if (oldSaved && !localStorage.getItem('mapControlsPositionV2')) {
      localStorage.removeItem('mapControlsPosition');
      return MAP_CONTROLS_DEFAULT_POSITION;
    }
    const saved = localStorage.getItem('mapControlsPositionV2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          if (parsed.x > 2000 || parsed.x < -100 || parsed.y > 2000 || parsed.y < -100) {
            localStorage.removeItem('mapControlsPositionV2');
            return MAP_CONTROLS_DEFAULT_POSITION;
          }
          return { x: parsed.x, y: parsed.y };
        }
      } catch {
        // Ignore parse errors
      }
    }
    return MAP_CONTROLS_DEFAULT_POSITION;
  });

  // Map controls drag state
  const [isDraggingMapControls, setIsDraggingMapControls] = useState(false);
  const [mapControlsDragStart, setMapControlsDragStart] = useState({ x: 0, y: 0 });
  const mapControlsRef = useRef<HTMLDivElement>(null);

  // Save map controls position to localStorage (only if not default)
  useEffect(() => {
    if (mapControlsPosition.x !== -1) {
      localStorage.setItem('mapControlsPositionV2', JSON.stringify(mapControlsPosition));
    }
  }, [mapControlsPosition]);

  // Constrain map controls position to stay within the map container on mount and window resize
  useEffect(() => {
    const constrainMapControlsPosition = () => {
      // Skip constraint for default position (x = -1 means use CSS right: 10px)
      if (mapControlsPosition.x === -1) return;

      const mapContainer = document.querySelector('.map-container');
      const controls = mapControlsRef.current;
      if (!mapContainer || !controls) return;

      const containerRect = mapContainer.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const padding = 10;

      // Calculate max bounds relative to container
      const maxX = containerRect.width - controlsRect.width - padding;
      const maxY = containerRect.height - controlsRect.height - padding;

      // Check if current position is out of bounds
      const constrainedX = Math.max(padding, Math.min(mapControlsPosition.x, maxX));
      const constrainedY = Math.max(padding, Math.min(mapControlsPosition.y, maxY));

      // Update position if it was out of bounds
      if (constrainedX !== mapControlsPosition.x || constrainedY !== mapControlsPosition.y) {
        setMapControlsPosition({ x: constrainedX, y: constrainedY });
      }
    };

    // Run on mount after a short delay to ensure elements are rendered
    const timeoutId = setTimeout(constrainMapControlsPosition, 100);

    // Run on window resize
    window.addEventListener('resize', constrainMapControlsPosition);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', constrainMapControlsPosition);
    };
  }, [mapControlsPosition]);

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

  useEffect(() => {
    const fetchMapStyles = async () => {
      try {
        const data = await api.get<MapStyle[]>('/api/map-styles/styles');
        setMapStyles(data);

        // Determine which style to use: localStorage > server default > none
        let resolvedStyleId = activeStyleId;

        if (!resolvedStyleId) {
          // No localStorage value — check server default
          try {
            const settings = await api.get<{ activeMapStyleId?: string }>('/api/settings');
            if (settings.activeMapStyleId) {
              resolvedStyleId = settings.activeMapStyleId;
              setActiveStyleId(resolvedStyleId);
            }
          } catch { /* ignore settings fetch failure */ }
        }

        // Load style data if we have a resolved ID
        if (resolvedStyleId && data.some((s: MapStyle) => s.id === resolvedStyleId)) {
          try {
            setActiveStyleJson(await api.get<Record<string, unknown>>(`/api/map-styles/styles/${resolvedStyleId}/data`));
          } catch { /* ignore style data fetch failure */ }
        } else if (resolvedStyleId) {
          // Saved style no longer exists, clear it
          setActiveStyleId(null);
          try { localStorage.removeItem('meshmonitor-activeMapStyleId'); } catch { /* ignore */ }
        }
      } catch (err) {
        console.error('Failed to fetch map styles:', err);
      }
    };
    void fetchMapStyles();
  }, []);

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

  const handleDMClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedDMNode(node.user?.id || '');
      setActiveTab('messages');
    };
  }, [setSelectedDMNode, setActiveTab]);

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



  // Map controls drag handlers — positions are stored as (right, top) relative to the map container
  // so the controls stay anchored to the right edge when the sidebar resizes
  const handleMapControlsDragStart = useCallback((e: React.MouseEvent) => {
    if (isMapControlsCollapsed || isTouchDevice) return; // Disable drag on mobile
    e.preventDefault();
    e.stopPropagation();

    const mapContainer = document.querySelector('.map-container');
    if (!mapContainer) return;
    const containerRect = mapContainer.getBoundingClientRect();

    // If position is default (-1), calculate actual position from element
    let currentRightOffset = mapControlsPosition.x;
    let currentY = mapControlsPosition.y;

    if (currentRightOffset === -1) {
      // Convert from CSS right: 10px to explicit right-based coordinates
      const controls = mapControlsRef.current;
      if (controls) {
        const controlsRect = controls.getBoundingClientRect();
        currentRightOffset = containerRect.right - controlsRect.right;
        currentY = controlsRect.top - containerRect.top;
        setMapControlsPosition({ x: currentRightOffset, y: currentY });
      }
    }

    setIsDraggingMapControls(true);
    // Store offset: mouse position relative to the element's right-edge anchor
    setMapControlsDragStart({
      x: (containerRect.right - e.clientX) - currentRightOffset,
      y: e.clientY - containerRect.top - currentY,
    });
  }, [isMapControlsCollapsed, mapControlsPosition, isTouchDevice]);

  const handleMapControlsDragMove = useCallback((e: MouseEvent) => {
    if (!isDraggingMapControls) return;

    const mapContainer = document.querySelector('.map-container');
    if (!mapContainer) return;

    const rect = mapContainer.getBoundingClientRect();
    const controls = mapControlsRef.current;
    if (!controls) return;

    const controlsRect = controls.getBoundingClientRect();
    const maxRight = rect.width - controlsRect.width - 10;
    const maxY = rect.height - controlsRect.height - 10;

    const newRight = Math.max(10, Math.min(maxRight, (rect.right - e.clientX) - mapControlsDragStart.x));
    const newY = Math.max(10, Math.min(maxY, e.clientY - rect.top - mapControlsDragStart.y));

    setMapControlsPosition({ x: newRight, y: newY });
  }, [isDraggingMapControls, mapControlsDragStart]);

  const handleMapControlsDragEnd = useCallback(() => {
    setIsDraggingMapControls(false);
  }, []);

  // Global mouse event listeners for map controls drag
  useEffect(() => {
    if (isDraggingMapControls) {
      document.addEventListener('mousemove', handleMapControlsDragMove);
      document.addEventListener('mouseup', handleMapControlsDragEnd);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      
      return () => {
        document.removeEventListener('mousemove', handleMapControlsDragMove);
        document.removeEventListener('mouseup', handleMapControlsDragEnd);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDraggingMapControls, handleMapControlsDragMove, handleMapControlsDragEnd]);

  const handleCollapseMapControls = useCallback(() => {
    setIsMapControlsCollapsed(!isMapControlsCollapsed);
  }, [isMapControlsCollapsed, setIsMapControlsCollapsed]);

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
  const nodeMarkers: NodeMarkerDescriptor[] = nodesWithPosition
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
    })
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
        iconSig: `${node.nodeNum}-${hops}-${isSelected}-${node.user?.role}-${node.user?.shortName}-${showLabel}-${shouldAnimate}-${showRoute && isSelected}-${mapPinStyle}`,
        buildIcon: () =>
          createNodeIcon({
            variant: 'meshtastic',
            hops,
            isSelected,
            isRouter,
            roleCategory,
            shortName: node.user?.shortName,
            showLabel: showLabel || shouldAnimate,
            animate: shouldAnimate,
            highlightSelected: showRoute && isSelected,
            pinStyle: mapPinStyle,
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
                          runDisabled={connectionStatus !== 'connected' || tracerouteLoading === node.user?.id}
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
                    <div className="route-usage" style={{ color: 'var(--ctp-green)' }}>
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

  return (
    <div className="nodes-split-view nodes-anchored-view">
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
              {sortedNodes.map(node => (
                <div
                  key={node.nodeNum}
                  className={`node-item ${selectedNodeId === node.user?.id ? 'selected' : ''}`}
                  onClick={handleNodeClick(node)}
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
                      </div>
                    </div>
                    <div className="node-actions">
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
                      {hasPermission('messages', 'read') && !node.isUnmessagable && (
                        <button
                          className="dm-icon"
                          title={t('nodes.send_dm')}
                          onClick={handleDMClick(node)}
                        >
                          <UiIcon name="messages" size={16} />
                        </button>
                      )}
                      {hasPermission('messages', 'read') && node.isUnmessagable && (
                        <span
                          className="node-indicator-icon"
                          title={t('nodes.unmessageable', 'This node reports itself as unmessageable (router/repeater/sensor) — it cannot receive direct messages')}
                        >
                          <UiIcon name="blocked" size={16} />
                        </span>
                      )}
                      {!isNodeComplete(node) && hasPermission('nodes', 'write') && (
                        <button
                          className="dm-icon"
                          title={t('nodes.copy_nodeinfo')}
                          onClick={handleCopyNodeInfoClick(node)}
                        >
                          <UiIcon name="copy" size={16} />
                        </button>
                      )}
                      {(node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) && (
                        hasPermission('security', 'write') ? (
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
                              marginLeft: '4px',
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: clearingSecurityNode === node.nodeNum ? 'default' : 'pointer',
                              opacity: clearingSecurityNode === node.nodeNum ? 0.5 : 1,
                            }}
                          >
                            <UiIcon name={node.keyMismatchDetected ? 'unlock' : 'alert'} size={16} />
                          </button>
                        ) : (
                          <span
                            className="security-warning-icon"
                            title={node.keySecurityIssueDetails || t('nodes.security_risk_generic', 'Key security issue detected')}
                            style={{
                              fontSize: '16px',
                              color: '#f44336',
                              marginLeft: '4px',
                              cursor: 'help'
                            }}
                          >
                            <UiIcon name={node.keyMismatchDetected ? 'unlock' : 'alert'} size={16} />
                          </span>
                        )
                      )}
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
              ))}
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
            <div
              ref={mapControlsRef}
              className={`map-controls ${isMapControlsCollapsed ? 'collapsed' : ''}`}
              style={isTouchDevice ? undefined : (
                // If collapsed, don't apply any position styles (use CSS defaults)
                // x = -1 means use CSS default (right: 10px); otherwise x is distance from right edge
                isMapControlsCollapsed ? undefined : {
                  right: mapControlsPosition.x === -1 ? undefined : `${mapControlsPosition.x}px`,
                  top: `${mapControlsPosition.y}px`,
                  left: mapControlsPosition.x === -1 ? undefined : 'auto',
                }
              )}
            >
              <div
                className="map-controls-drag-handle"
                style={{
                  cursor: (isTouchDevice) ? 'default' : (isDraggingMapControls ? 'grabbing' : 'grab'),
                }}
                onMouseDown={handleMapControlsDragStart}
              >
                <span className="drag-handle-icon">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
              </div>
              <div className="map-controls-body">
              <div
                className="map-controls-header"
              >
                <div className="map-controls-title">
                  Features
                </div>
                <button
                  className="map-controls-collapse-btn"
                  onClick={handleCollapseMapControls}
                  title={isMapControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <UiIcon name={isMapControlsCollapsed ? 'chevronDown' : 'chevronUp'} />
                </button>
              </div>
              {!isMapControlsCollapsed && (
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
                  {/* Map Features age slider (#3322): hides node markers,
                      traceroutes, and route segments older than the chosen age.
                      Ranges 1h–maxNodeAgeHours (settings); default = max ("All"). */}
                  {(() => {
                    const maxHours = Math.max(1, Math.round(maxNodeAgeHours));
                    const currentHours = Math.min(Math.max(1, Math.round(effectiveMapMaxAge)), maxHours);
                    const formatDuration = (hours: number): string => {
                      if (hours >= maxHours) return t('map.maxAgeAll', 'All');
                      if (hours < 24) return `${hours}h`;
                      const days = Math.floor(hours / 24);
                      const remainingHours = hours % 24;
                      return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
                    };
                    return (
                      <div className="map-control-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }}>
                        <span>{t('map.maximumAge', 'Maximum age')}</span>
                        <div className="position-history-slider">
                          <input
                            type="range"
                            min={1}
                            max={maxHours}
                            value={currentHours}
                            aria-label={t('map.maximumAge', 'Maximum age')}
                            aria-valuemin={1}
                            aria-valuemax={maxHours}
                            aria-valuenow={currentHours}
                            aria-valuetext={formatDuration(currentHours)}
                            disabled={maxHours <= 1}
                            onChange={(e) => {
                              const value = parseInt(e.target.value, 10);
                              // At max, store null so the map follows the setting.
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
                          onChange={async (e) => {
                            const styleId = e.target.value || null;
                            setActiveStyleId(styleId);
                            try { localStorage.setItem('meshmonitor-activeMapStyleId', styleId ?? ''); } catch { /* ignore */ }
                            // Save as server default so incognito/new browsers get this style
                            void api.getBaseUrl().then(baseUrl => {
                              csrfFetch(`${baseUrl}/api/settings`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ activeMapStyleId: styleId ?? '' }),
                              }).catch(err => console.error('Failed to save map style setting:', err));
                            });
                            if (styleId) {
                              try {
                                const data = await api.get<Record<string, unknown>>(`/api/map-styles/styles/${styleId}/data`);
                                setActiveStyleJson(data);
                              } catch (err) {
                                console.error('Failed to fetch map style data:', err);
                              }
                            } else {
                              setActiveStyleJson(null);
                            }
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
              )}
              </div>
            </div>
        )}
            <BaseMap
              center={mapDefaults.center}
              zoom={mapDefaults.zoom}
              tilesetId={activeTileset}
              customTilesets={customTilesets}
              styleJson={activeStyleJson ?? undefined}
              showTilesetSelector={shouldShowData() && showTileSelector}
              onTilesetChange={setMapTileset}
              resizeTrigger={`${showPacketMonitor}-${isNodeListCollapsed}-${packetMonitorHeight}`}
            >
              <MapCenterController
                centerTarget={mapCenterTarget}
                onCenterComplete={handleCenterComplete}
                targetZoom={mapCenterTargetZoom}
              />
              <TracerouteBoundsController bounds={tracerouteBounds} />
              <ZoomHandler onZoomChange={setMapZoom} />
              <MapPositionHandler />
              <WaypointMapEventBridge
                placing={placingWaypoint}
                canCreate={canWriteWaypoints}
                onPick={(lat, lon) => startCreateAtCoords(lat, lon)}
              />
              {showWaypoints && <DashboardWaypoints sourceId={currentSourceId ?? null} actions={waypointActions} />}
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
              {showLegend && (
              <MapLegend
                positionHistory={positionHistoryLegendData}
                unmappedCount={unmappedCount}
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

  // If connection status or traceroute loading state changed, must re-render
  // (for traceroute button disabled state and loading indicator)
  if (prevProps.connectionStatus !== nextProps.connectionStatus ||
      prevProps.tracerouteLoading !== nextProps.tracerouteLoading) {
    return false; // Allow re-render
  }

  // For everything else (including MapContext changes like animatedNodes),
  // use default comparison which will cause re-render if props differ
  return false; // Allow re-render for other changes
});

export default NodesTab;
