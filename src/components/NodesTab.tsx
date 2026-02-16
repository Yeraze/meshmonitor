import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, Circle, Rectangle, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Marker as LeafletMarker } from 'leaflet';
import { DeviceInfo } from '../types/device';
import { TabType } from '../types/ui';
import { ResourceType } from '../types/permission';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { getPositionHistoryColor, generateHeadingAwarePath, generatePositionHistoryArrows } from '../utils/mapHelpers.tsx';
import { getEffectivePosition, getRoleName, hasValidEffectivePosition, isNodeComplete, parseNodeId } from '../utils/nodeHelpers';
import PositionHistoryLegend from './PositionHistoryLegend';
import { formatTime, formatDateTime } from '../utils/datetime';
import { getDistanceToNode } from '../utils/distance';
import { getTilesetById } from '../config/tilesets';
import { getEffectiveHops } from '../utils/nodeHops';
import { useMapContext } from '../contexts/MapContext';
import { useTelemetryNodes, useDeviceConfig, useNodes } from '../hooks/useServerData';
import { useUI } from '../contexts/UIContext';
import { useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { useResizable } from '../hooks/useResizable';
import MapLegend from './MapLegend';
import ZoomHandler from './ZoomHandler';
import MapResizeHandler from './MapResizeHandler';
import MapPositionHandler from './MapPositionHandler';
import { SpiderfierController, SpiderfierControllerRef } from './SpiderfierController';
import { TilesetSelector } from './TilesetSelector';
import { MapCenterController } from './MapCenterController';
import PacketMonitorPanel from './PacketMonitorPanel';
import { getPacketStats } from '../services/packetApi';
import { NodeFilterPopup } from './NodeFilterPopup';
import { VectorTileLayer } from './VectorTileLayer';
import { MapNodePopupContent } from './MapNodePopupContent';

/**
 * Spiderfier initialization constants
 */
const SPIDERFIER_INIT = {
  /** Maximum attempts to wait for spiderfier initialization */
  MAX_ATTEMPTS: 50,
  /** Interval between initialization attempts (ms) - 50 attempts × 100ms = 5 seconds total */
  RETRY_INTERVAL_MS: 100,
} as const;

/**
 * MeshCore theming constants
 * Note: These are hardcoded because they're used in Leaflet divIcon template strings
 * where CSS variables are not available. This matches var(--ctp-mauve) from Catppuccin Mocha.
 */
const MESHCORE_COLOR = '#cba6f7'; // Catppuccin Mocha mauve

interface NodesTabProps {
  processedNodes: DeviceInfo[];
  shouldShowData: () => boolean;
  centerMapOnNode: (node: DeviceInfo) => void;
  toggleFavorite: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  setActiveTab: React.Dispatch<React.SetStateAction<TabType>>;
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
      📏 {distance}
    </span>
  );
});

// Separate components for traceroutes that can update independently
// These prevent marker re-renders when only the traceroute paths change
const TraceroutePathsLayer = React.memo<{ paths: React.ReactNode; enabled: boolean }>(
  ({ paths }) => {
    return <>{paths}</>;
  }
);

const SelectedTracerouteLayer = React.memo<{ traceroute: React.ReactNode; enabled: boolean }>(
  ({ traceroute }) => {
    return <>{traceroute}</>;
  }
);

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

const NodesTabComponent: React.FC<NodesTabProps> = ({
  processedNodes,
  shouldShowData,
  centerMapOnNode,
  toggleFavorite,
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
    showMqttNodes,
    setShowMqttNodes,
    showMeshCoreNodes,
    setShowMeshCoreNodes,
    meshCoreNodes,
    showAnimations,
    setShowAnimations,
    showEstimatedPositions,
    setShowEstimatedPositions,
    showAccuracyRegions,
    setShowAccuracyRegions,
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
  } = useMapContext();

  const { currentNodeId } = useDeviceConfig();
  const { nodes } = useNodes();

  const {
    nodesWithTelemetry,
    nodesWithWeather: nodesWithWeatherTelemetry,
    nodesWithEstimatedPosition,
    nodesWithPKC,
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
  } = useSettings();

  const { hasPermission } = useAuth();

  // Parse current node ID to get node number for effective hops calculation
  const currentNodeNum = currentNodeId ? parseNodeId(currentNodeId) : null;

  // Detect touch device to disable hover tooltips on mobile
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    // Check if the device supports touch
    const checkTouch = () => {
      return (
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        (navigator as any).msMaxTouchPoints > 0
      );
    };
    setIsTouchDevice(checkTouch());
  }, []);

  // Ref for spiderfier controller to manage overlapping markers
  const spiderfierRef = useRef<SpiderfierControllerRef>(null);

  // Packet Monitor state (desktop only)
  const [showPacketMonitor, setShowPacketMonitor] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('showPacketMonitor');
    return saved === 'true';
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

  // Track if map controls are collapsed
  const [isMapControlsCollapsed, setIsMapControlsCollapsed] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('isMapControlsCollapsed');
    return saved === 'true';
  });

  // Nodes sidebar position and size state
  const [sidebarPosition, setSidebarPosition] = useState(() => {
    const saved = localStorage.getItem('nodesSidebarPosition');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { x: parsed.x ?? 16, y: parsed.y ?? 16 };
      } catch {
        return { x: 16, y: 16 };
      }
    }
    return { x: 16, y: 16 };
  });

  const [sidebarSize, setSidebarSize] = useState(() => {
    const saved = localStorage.getItem('nodesSidebarSize');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { width: parsed.width ?? 350, height: parsed.height ?? null };
      } catch {
        return { width: 350, height: null };
      }
    }
    return { width: 350, height: null };
  });

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });

  // Save packet monitor preference to localStorage
  useEffect(() => {
    localStorage.setItem('showPacketMonitor', showPacketMonitor.toString());
  }, [showPacketMonitor]);

  // Save map controls collapse state to localStorage
  useEffect(() => {
    localStorage.setItem('isMapControlsCollapsed', isMapControlsCollapsed.toString());
  }, [isMapControlsCollapsed]);

  // Save sidebar position to localStorage
  useEffect(() => {
    localStorage.setItem('nodesSidebarPosition', JSON.stringify(sidebarPosition));
  }, [sidebarPosition]);

  // Save sidebar size to localStorage
  useEffect(() => {
    localStorage.setItem('nodesSidebarSize', JSON.stringify(sidebarSize));
  }, [sidebarSize]);

  // Map controls position state with localStorage persistence
  // Position is relative to the map container (absolute positioning)
  // We use a special value of -1 to indicate "use CSS default (right: 10px)"
  const MAP_CONTROLS_DEFAULT_POSITION = { x: -1, y: 10 };

  const [mapControlsPosition, setMapControlsPosition] = useState(() => {
    const saved = localStorage.getItem('mapControlsPosition');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // If x or y is invalid, use defaults
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          // Sanity check: if position seems unreasonable, reset to default
          // This handles migration from old viewport-based positions
          if (parsed.x > 2000 || parsed.x < -100 || parsed.y > 2000 || parsed.y < -100) {
            localStorage.removeItem('mapControlsPosition');
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
      localStorage.setItem('mapControlsPosition', JSON.stringify(mapControlsPosition));
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

  // Check if user has permission to view packet monitor - needs at least one channel and messages permission
  const hasAnyChannelPermission = () => {
    for (let i = 0; i < 8; i++) {
      if (hasPermission(`channel_${i}` as ResourceType, 'read')) {
        return true;
      }
    }
    return false;
  };
  const canViewPacketMonitor = hasAnyChannelPermission() && hasPermission('messages', 'read');

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

    fetchPacketLogStatus();
  }, [canViewPacketMonitor]);

  // Refs to access latest values without recreating listeners
  const processedNodesRef = useRef(processedNodes);
  const setSelectedNodeIdRef = useRef(setSelectedNodeId);
  const centerMapOnNodeRef = useRef(centerMapOnNode);
  const showRouteRef = useRef(showRoute);
  const traceroutesRef = useRef(traceroutes);

  // Stable ref callback for markers to prevent unnecessary re-renders
  const handleMarkerRef = React.useCallback((ref: LeafletMarker | null, nodeId: string | undefined) => {
    if (ref && nodeId) {
      markerRefs.current.set(nodeId, ref);
      // Add marker to spiderfier for overlap handling, passing nodeId to allow multiple markers at same position
      spiderfierRef.current?.addMarker(ref, nodeId);
    }
  }, []); // Empty deps - function never changes

  // Utility to prevent mousedown from triggering drag on form elements
  // Firefox handles select/input mousedown differently, which can trigger panel drag
  const stopPropagation = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

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
        centerMapOnNode(node);
      } else {
        const hasTraceroute = traceroutes.some(tr => {
          const matches = tr.toNodeId === nodeId || tr.fromNodeId === nodeId;
          if (!matches) return false;
          return tr.route && tr.route !== 'null' && tr.route !== '' &&
                 tr.routeBack && tr.routeBack !== 'null' && tr.routeBack !== '';
        });
        if (!hasTraceroute) {
          centerMapOnNode(node);
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
  }, [selectedNodeId, setSelectedNodeId, centerMapOnNode, setIsNodeListCollapsed, showRoute, traceroutes]);

  const handleFavoriteClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => toggleFavorite(node, e);
  }, [toggleFavorite]);

  const handleDMClick = useCallback((node: DeviceInfo) => {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedDMNode(node.user?.id || '');
      setActiveTab('messages');
    };
  }, [setSelectedDMNode, setActiveTab]);

  const handlePopupDMClick = useCallback((node: DeviceInfo) => {
    return () => {
      setSelectedDMNode(node.user!.id);
      setActiveTab('messages');
    };
  }, [setSelectedDMNode, setActiveTab]);

  // Simple toggle callbacks
  const handleCollapseNodeList = useCallback(() => {
    const willBeCollapsed = !isNodeListCollapsed;
    setIsNodeListCollapsed(willBeCollapsed);
    // Reset position to default when collapsing (will be restored when expanding)
    if (willBeCollapsed) {
      // Don't reset position - keep it for when user expands again
    }
  }, [isNodeListCollapsed, setIsNodeListCollapsed]);

  const handleToggleFilterPopup = useCallback(() => {
    setShowNodeFilterPopup(!showNodeFilterPopup);
  }, [showNodeFilterPopup, setShowNodeFilterPopup]);

  const handleToggleSortDirection = useCallback(() => {
    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
  }, [sortDirection, setSortDirection]);

  // Drag handlers for sidebar
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (isNodeListCollapsed || isTouchDevice) return; // Disable drag on mobile
    // Don't start drag if clicking on an input, button, select, or anything inside node-controls
    // Check this FIRST before doing anything else
    const target = e.target as HTMLElement;
    const isInteractiveElement = 
      target.tagName === 'INPUT' || 
      target.tagName === 'BUTTON' || 
      target.tagName === 'SELECT' || 
      target.tagName === 'OPTION' ||
      target.closest('.node-controls') !== null ||
      target.closest('input') !== null ||
      target.closest('button') !== null ||
      target.closest('select') !== null;
    
    if (isInteractiveElement) {
      // Don't prevent default - allow normal interaction
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    setIsDragging(true);
    setDragStart({
      x: e.clientX - sidebarPosition.x,
      y: e.clientY - sidebarPosition.y,
    });
  }, [isNodeListCollapsed, sidebarPosition, isTouchDevice]);

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    
    const splitView = document.querySelector('.nodes-split-view');
    if (!splitView) return;
    
    const rect = splitView.getBoundingClientRect();
    const sidebarWidth = sidebarSize.width || 350;
    const maxX = rect.width - sidebarWidth - 20; // Leave some margin
    const maxY = rect.height - 100; // Minimum height for header
    
    const newX = Math.max(0, Math.min(maxX, e.clientX - dragStart.x));
    const newY = Math.max(0, Math.min(maxY, e.clientY - dragStart.y));
    
    setSidebarPosition({ x: newX, y: newY });
  }, [isDragging, dragStart, sidebarSize]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Resize handlers for sidebar
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (isNodeListCollapsed || isTouchDevice) return; // Disable resize on mobile
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    const sidebar = sidebarRef.current;
    const currentHeight = sidebar ? sidebar.offsetHeight : 0;
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: sidebarSize.width || 350,
      height: sidebarSize.height || currentHeight,
    });
  }, [isNodeListCollapsed, sidebarSize, isTouchDevice]);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    
    const splitView = document.querySelector('.nodes-split-view');
    if (!splitView) return;
    
    const rect = splitView.getBoundingClientRect();
    const deltaX = e.clientX - resizeStart.x;
    const deltaY = e.clientY - resizeStart.y;
    
    const minWidth = 250;
    const maxWidth = Math.min(800, rect.width - sidebarPosition.x - 20);
    const minHeight = 200;
    const maxHeight = rect.height - sidebarPosition.y - 20;
    
    const newWidth = Math.max(minWidth, Math.min(maxWidth, resizeStart.width + deltaX));
    // Always set height when resizing (user is explicitly resizing)
    const newHeight = Math.max(minHeight, Math.min(maxHeight, resizeStart.height + deltaY));
    
    setSidebarSize({ width: newWidth, height: newHeight });
  }, [isResizing, resizeStart, sidebarPosition]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Global mouse event listeners for drag and resize
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleDragMove);
      document.addEventListener('mouseup', handleDragEnd);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      
      return () => {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDragging, handleDragMove, handleDragEnd]);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      
      return () => {
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  // Map controls drag handlers
  const handleMapControlsDragStart = useCallback((e: React.MouseEvent) => {
    if (isMapControlsCollapsed || isTouchDevice) return; // Disable drag on mobile
    e.preventDefault();
    e.stopPropagation();

    // If position is default (-1), calculate actual position from element
    let currentX = mapControlsPosition.x;
    let currentY = mapControlsPosition.y;

    if (currentX === -1) {
      // Convert from CSS right: 10px to left-based coordinates
      const mapContainer = document.querySelector('.map-container');
      const controls = mapControlsRef.current;
      if (mapContainer && controls) {
        const containerRect = mapContainer.getBoundingClientRect();
        const controlsRect = controls.getBoundingClientRect();
        currentX = controlsRect.left - containerRect.left;
        currentY = controlsRect.top - containerRect.top;
        // Update the position to be explicit
        setMapControlsPosition({ x: currentX, y: currentY });
      }
    }

    setIsDraggingMapControls(true);
    setMapControlsDragStart({
      x: e.clientX - currentX,
      y: e.clientY - currentY,
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
    const maxX = rect.width - controlsRect.width - 10;
    const maxY = rect.height - controlsRect.height - 10;
    
    const newX = Math.max(10, Math.min(maxX, e.clientX - mapControlsDragStart.x - rect.left));
    const newY = Math.max(10, Math.min(maxY, e.clientY - mapControlsDragStart.y - rect.top));
    
    setMapControlsPosition({ x: newX, y: newY });
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
  });

  // Track if listeners have been set up
  const listenersSetupRef = useRef(false);

  // Set up spiderfier event listeners ONCE when component mounts
  useEffect(() => {
    // Wait for spiderfier to be ready
    const checkAndSetup = () => {
      if (listenersSetupRef.current) {
        return true; // Already set up
      }

      if (!spiderfierRef.current) {
        return false;
      }

      const clickHandler = (marker: any) => {
        // Find the node data from the marker
        const nodeEntry = Array.from(markerRefs.current.entries()).find(([_, ref]) => ref === marker);
        if (nodeEntry) {
          const nodeId = nodeEntry[0];
          setSelectedNodeIdRef.current(nodeId);
          // When showRoute is enabled, let TracerouteBoundsController handle the zoom
          // to fit the entire traceroute path instead of just centering on the node.
          // But if the node has no valid traceroute, fall back to centering on it.
          if (!showRouteRef.current) {
            const node = processedNodesRef.current.find(n => n.user?.id === nodeId);
            if (node) {
              centerMapOnNodeRef.current(node);
            }
          } else {
            // Check if this node has a valid traceroute
            const hasTraceroute = traceroutesRef.current.some(tr => {
              const matches = tr.toNodeId === nodeId || tr.fromNodeId === nodeId;
              if (!matches) return false;
              return tr.route && tr.route !== 'null' && tr.route !== '' &&
                     tr.routeBack && tr.routeBack !== 'null' && tr.routeBack !== '';
            });
            // If no valid traceroute, still center on the node
            if (!hasTraceroute) {
              const node = processedNodesRef.current.find(n => n.user?.id === nodeId);
              if (node) {
                centerMapOnNodeRef.current(node);
              }
            }
          }
        }
      };

      const spiderfyHandler = (_markers: any[]) => {
        // Markers fanned out
      };

      const unspiderfyHandler = (_markers: any[]) => {
        // Markers collapsed
      };

      // Add listeners only once
      spiderfierRef.current.addListener('click', clickHandler);
      spiderfierRef.current.addListener('spiderfy', spiderfyHandler);
      spiderfierRef.current.addListener('unspiderfy', unspiderfyHandler);
      listenersSetupRef.current = true;

      return true;
    };

    // Keep retrying until spiderfier is ready
    let attempts = 0;
    const intervalId = setInterval(() => {
      attempts++;
      if (checkAndSetup() || attempts >= SPIDERFIER_INIT.MAX_ATTEMPTS) {
        clearInterval(intervalId);
      }
    }, SPIDERFIER_INIT.RETRY_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, []); // Empty array - run only once on mount

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

  // Handle center complete
  const handleCenterComplete = () => {
    setMapCenterTarget(null);
  };

  // Handle node click from packet monitor
  const handlePacketNodeClick = (nodeId: string) => {
    // Find the node by ID
    const node = processedNodes.find(n => n.user?.id === nodeId);
    if (node) {
      // Select and center on the node
      setSelectedNodeId(nodeId);
      centerMapOnNode(node);
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

  // Calculate nodes with position - uses effective position (respects position overrides, Issue #1526)
  const nodesWithPosition = processedNodes.filter(node => hasValidEffectivePosition(node));

  // Memoize node positions to prevent React-Leaflet from resetting marker positions
  // Creating new [lat, lng] arrays causes React-Leaflet to move markers, destroying spiderfier state
  // Uses getEffectivePosition to respect position overrides (Issue #1526)
  const nodePositions = React.useMemo(() => {
    const posMap = new Map<number, [number, number]>();
    nodesWithPosition.forEach(node => {
      const effectivePos = getEffectivePosition(node);
      if (effectivePos.latitude != null && effectivePos.longitude != null) {
        posMap.set(node.nodeNum, [effectivePos.latitude, effectivePos.longitude]);
      }
    });
    return posMap;
  }, [nodesWithPosition.map(n => {
    const pos = getEffectivePosition(n);
    return `${n.nodeNum}-${pos.latitude}-${pos.longitude}`;
  }).join(',')]);

  // Calculate center point of all nodes for initial map view
  // Use saved map center from localStorage if available, otherwise calculate from nodes
  const getMapCenter = (): [number, number] => {
    // Use saved map center from previous session if available
    if (mapCenter) {
      return mapCenter;
    }

    // If no nodes with positions, use default location
    if (nodesWithPosition.length === 0) {
      return [25.7617, -80.1918]; // Default to Miami area
    }

    // Prioritize the locally connected node's position for first-time visitors
    // Uses effective position to respect position overrides (Issue #1526)
    if (currentNodeId) {
      const localNode = nodesWithPosition.find(node => node.user?.id === currentNodeId);
      if (localNode) {
        const effectivePos = getEffectivePosition(localNode);
        if (effectivePos.latitude != null && effectivePos.longitude != null) {
          return [effectivePos.latitude, effectivePos.longitude];
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
    return [avgLat, avgLng];
  };

  return (
    <div className="nodes-split-view">
      {/* Floating Node List Panel */}
      <div
        ref={sidebarRef}
        className={`nodes-sidebar ${isNodeListCollapsed ? 'collapsed' : ''}`}
        style={{
          left: isNodeListCollapsed ? undefined : `${sidebarPosition.x}px`,
          top: isNodeListCollapsed ? undefined : `${sidebarPosition.y}px`,
          width: isNodeListCollapsed ? undefined : `${sidebarSize.width}px`,
          height: isNodeListCollapsed ? undefined : (sidebarSize.height ? `${sidebarSize.height}px` : 'auto'),
          maxHeight: isNodeListCollapsed ? undefined : (sidebarSize.height ? `${sidebarSize.height}px` : 'calc(100% - 32px)'),
        }}
        onMouseDown={(e) => {
          // If clicking on node-controls or any interactive element, don't let the drag handler run
          const target = e.target as HTMLElement;
          if (
            target.closest('.node-controls') ||
            target.tagName === 'INPUT' ||
            target.tagName === 'BUTTON' ||
            target.tagName === 'SELECT'
          ) {
            e.stopPropagation();
          }
        }}
      >
        <div
          className="sidebar-header"
          onMouseDown={handleDragStart}
          style={{ cursor: (isNodeListCollapsed || isTouchDevice) ? 'default' : 'grab' }}
        >
          <button
            className="collapse-nodes-btn"
            onClick={handleCollapseNodeList}
            title={isNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {isNodeListCollapsed ? '▶' : '◀'}
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
              const meshCoreCount = showMeshCoreNodes ? meshCoreNodes.length : 0;
              const isFiltered = securityFilter !== 'all' || !showIncompleteNodes || filterRemoteAdminOnly;
              if (meshCoreCount > 0) {
                return isFiltered
                  ? `${filteredCount}/${processedNodes.length} + ${meshCoreCount} MC`
                  : `${filteredCount} + ${meshCoreCount} MC`;
              }
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
                onMouseDown={stopPropagation}
                className="filter-input-small"
              />
              {nodesNodeFilter && (
                <button
                  className="filter-clear-btn"
                  onClick={() => setNodesNodeFilter('')}
                  onMouseDown={stopPropagation}
                  title={t('common.clear_filter')}
                  type="button"
                >
                  ✕
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
                onMouseDown={stopPropagation}
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
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
          )}
        </div>
        {!isNodeListCollapsed && (
        <div className="nodes-list">
          {/* MeshCore nodes section - shows regardless of Meshtastic connection */}
          {showMeshCoreNodes && meshCoreNodes.length > 0 && (
            <div className="meshcore-section">
              <div className="meshcore-section-header" style={{
                padding: '8px 12px',
                background: 'color-mix(in srgb, var(--ctp-mauve) 10%, transparent)',
                borderBottom: '1px solid color-mix(in srgb, var(--ctp-mauve) 30%, transparent)',
                fontSize: '12px',
                fontWeight: 'bold',
                color: 'var(--ctp-mauve)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <span style={{
                  background: 'var(--ctp-mauve)',
                  color: 'var(--ctp-base)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '10px'
                }}>MC</span>
                MeshCore ({meshCoreNodes.length})
              </div>
              {meshCoreNodes.map(mcNode => {
                const hasPosition = mcNode.latitude && mcNode.longitude;
                const advTypeName = mcNode.advType === 1 ? 'Companion' : mcNode.advType === 2 ? 'Repeater' : mcNode.advType === 3 ? 'Router' : '';
                return (
                  <div
                    key={`mc-${mcNode.publicKey}`}
                    className={`node-item meshcore-node ${selectedNodeId === `mc-${mcNode.publicKey}` ? 'selected' : ''}`}
                    onClick={() => {
                      if (hasPosition) {
                        setMapCenterTarget([mcNode.latitude, mcNode.longitude]);
                      }
                      setSelectedNodeId(`mc-${mcNode.publicKey}`);
                    }}
                    style={{ borderLeft: '3px solid var(--ctp-mauve)' }}
                  >
                    <div className="node-header">
                      <div className="node-name">
                        <span style={{
                          background: 'var(--ctp-mauve)',
                          color: 'var(--ctp-base)',
                          padding: '1px 4px',
                          borderRadius: '3px',
                          fontSize: '9px',
                          marginRight: '6px'
                        }}>MC</span>
                        <div className="node-name-text">
                          <div className="node-longname">
                            {mcNode.name || 'MeshCore Node'}
                          </div>
                          {advTypeName && (
                            <div className="node-role" title="MeshCore device type">{advTypeName}</div>
                          )}
                        </div>
                      </div>
                      <div className="node-actions">
                        <div className="node-short" style={{ color: 'var(--ctp-mauve)' }}>
                          {mcNode.publicKey.substring(0, 4)}...
                        </div>
                      </div>
                    </div>
                    <div className="node-details">
                      <div className="node-stats">
                        {mcNode.snr !== undefined && (
                          <span className="stat" title="SNR">
                            📶 {mcNode.snr.toFixed(1)}dB
                          </span>
                        )}
                        {mcNode.rssi !== undefined && (
                          <span className="stat" title="RSSI">
                            📡 {mcNode.rssi}dBm
                          </span>
                        )}
                      </div>
                      <div className="node-time">
                        {mcNode.lastSeen ? (() => {
                          const date = new Date(mcNode.lastSeen);
                          return isToday(date)
                            ? formatTime(date, timeFormat)
                            : formatDateTime(date, timeFormat, dateFormat);
                        })() : '-'}
                      </div>
                    </div>
                    <div className="node-indicators">
                      {hasPosition && (
                        <div className="node-location" title="Has GPS location">
                          📍
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {/* Meshtastic nodes section */}
          {shouldShowData() ? (() => {
            // Find the home node for distance calculations (use unfiltered nodes to ensure home node is found)
            const homeNode = nodes.find(n => n.user?.id === currentNodeId);

            // Apply security, channel, and incomplete node filters
            const filteredNodes = processedNodes.filter(node => {
              // Security filter
              if (securityFilter === 'flaggedOnly') {
                if (!node.keyIsLowEntropy && !node.duplicateKeyDetected && !node.keySecurityIssueDetails) return false;
              }
              if (securityFilter === 'hideFlagged') {
                if (node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) return false;
              }

              // Channel filter
              if (channelFilter !== 'all') {
                const nodeChannel = node.channel ?? 0;
                if (nodeChannel !== channelFilter) return false;
              }

              // Incomplete nodes filter - hide nodes missing name/hwModel info
              if (!showIncompleteNodes && !isNodeComplete(node)) {
                return false;
              }

              // Remote admin filter
              if (filterRemoteAdminOnly && !node.hasRemoteAdmin) {
                return false;
              }

              return true;
            });

            // Sort nodes: favorites first, then non-favorites, each group sorted independently
            const favorites = filteredNodes.filter(node => node.isFavorite);
            const nonFavorites = filteredNodes.filter(node => !node.isFavorite);
            const sortedFavorites = sortNodes(favorites);
            const sortedNonFavorites = sortNodes(nonFavorites);
            const sortedNodes = [...sortedFavorites, ...sortedNonFavorites];

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
                      <button
                        className="favorite-star"
                        title={node.isFavorite ? t('nodes.remove_favorite') : t('nodes.add_favorite')}
                        onClick={handleFavoriteClick(node)}
                      >
                        {node.isFavorite ? '⭐' : '☆'}
                      </button>
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
                        <span className="node-indicator-icon" title={t('nodes.location')}>📍</span>
                      )}
                      {node.viaMqtt && (
                        <span className="node-indicator-icon" title={t('nodes.via_mqtt')}>🌐</span>
                      )}
                      {node.user?.id && nodesWithTelemetry.has(node.user.id) && (
                        <span className="node-indicator-icon" title={t('nodes.has_telemetry')}>📊</span>
                      )}
                      {node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
                        <span className="node-indicator-icon" title={t('nodes.has_weather')}>☀️</span>
                      )}
                      {node.user?.id && nodesWithPKC.has(node.user.id) && (
                        <span className="node-indicator-icon" title={t('nodes.has_pkc')}>🔐</span>
                      )}
                      {node.hasRemoteAdmin && (
                        <span className="node-indicator-icon" title={t('nodes.has_remote_admin')}>🛠️</span>
                      )}
                      {hasPermission('messages', 'read') && (
                        <button
                          className="dm-icon"
                          title={t('nodes.send_dm')}
                          onClick={handleDMClick(node)}
                        >
                          💬
                        </button>
                      )}
                      {(node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) && (
                        <span
                          className="security-warning-icon"
                          title={node.keySecurityIssueDetails || 'Key security issue detected'}
                          style={{
                            fontSize: '16px',
                            color: '#f44336',
                            marginLeft: '4px',
                            cursor: 'help'
                          }}
                        >
                          {node.keyMismatchDetected ? '🔓' : '⚠️'}
                        </span>
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
                          📶 {node.snr.toFixed(1)}dB
                        </span>
                      )}
                      {node.hopsAway === 0 && node.rssi != null && (
                        <span className="stat" title={t('nodes.rssi')}>
                          📡 {node.rssi}dBm
                        </span>
                      )}
                      {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                        <span className="stat" title={node.deviceMetrics.batteryLevel === 101 ? t('nodes.plugged_in') : t('nodes.battery_level')}>
                          {node.deviceMetrics.batteryLevel === 101 ? '🔌' : `🔋 ${node.deviceMetrics.batteryLevel}%`}
                        </span>
                      )}
                      {(node.hopsAway != null || node.lastMessageHops != null) && (() => {
                        const effectiveHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                        return effectiveHops < 999 ? (
                          <span className="stat" title={t('nodes.hops_away')}>
                            🔗 {effectiveHops} {t('nodes.hop', { count: effectiveHops })}
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
            // Only show "Connect to Meshtastic node" if there are also no MeshCore nodes
            !(showMeshCoreNodes && meshCoreNodes.length > 0) && (
              <div className="no-data">
                Connect to Meshtastic node
              </div>
            )
          )}
        </div>
        )}
        {!isNodeListCollapsed && (
          <div
            className="sidebar-resize-handle"
            onMouseDown={handleResizeStart}
            title="Drag to resize"
          />
        )}
      </div>

      {/* Right Side - Map and Optional Packet Monitor */}
      <div
        className={`map-container ${showPacketMonitor && canViewPacketMonitor ? 'with-packet-monitor' : ''}`}
        style={showPacketMonitor && canViewPacketMonitor ? { height: `calc(100% - ${packetMonitorHeight}px)` } : undefined}
      >
        {(shouldShowData() || meshCoreNodes.length > 0) ? (
          <>
            <div
              ref={mapControlsRef}
              className={`map-controls ${isMapControlsCollapsed ? 'collapsed' : ''}`}
              style={isTouchDevice ? undefined : (
                // If collapsed, don't apply any position styles (use CSS defaults)
                // If position is default (-1), don't apply left (CSS will use right: 10px)
                isMapControlsCollapsed ? undefined : {
                  left: mapControlsPosition.x === -1 ? undefined : `${mapControlsPosition.x}px`,
                  top: `${mapControlsPosition.y}px`,
                  right: mapControlsPosition.x === -1 ? undefined : 'auto',
                }
              )}
            >
              <button
                className="map-controls-collapse-btn"
                onClick={handleCollapseMapControls}
                title={isMapControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {isMapControlsCollapsed ? '▼' : '▲'}
              </button>
              <div
                className="map-controls-header"
                style={{
                  cursor: (isMapControlsCollapsed || isTouchDevice) ? 'default' : (isDraggingMapControls ? 'grabbing' : 'grab'),
                }}
                onMouseDown={handleMapControlsDragStart}
              >
                {!isMapControlsCollapsed && (
                  <div className="map-controls-title">
                    Features
                  </div>
                )}
              </div>
              {!isMapControlsCollapsed && (
                <>
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
                      checked={showNeighborInfo}
                      onChange={(e) => setShowNeighborInfo(e.target.checked)}
                    />
                    <span>Show Neighbor Info</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showRoute}
                      onChange={(e) => setShowRoute(e.target.checked)}
                    />
                    <span>Show Traceroute</span>
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
                      checked={showMqttNodes}
                      onChange={(e) => setShowMqttNodes(e.target.checked)}
                    />
                    <span>Show MQTT</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showMeshCoreNodes}
                      onChange={(e) => setShowMeshCoreNodes(e.target.checked)}
                    />
                    <span>Show MeshCore</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showMotion}
                      onChange={(e) => setShowMotion(e.target.checked)}
                    />
                    <span>Show Position History</span>
                  </label>
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
                    <span>Show Animations</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showEstimatedPositions}
                      onChange={(e) => setShowEstimatedPositions(e.target.checked)}
                    />
                    <span>Show Estimated Positions</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showAccuracyRegions}
                      onChange={(e) => setShowAccuracyRegions(e.target.checked)}
                    />
                    <span>Show Accuracy Regions</span>
                  </label>
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
                </>
              )}
            </div>
            <MapContainer
              center={getMapCenter()}
              zoom={mapZoom}
              style={{ height: '100%', width: '100%' }}
            >
              <MapCenterController
                centerTarget={mapCenterTarget}
                onCenterComplete={handleCenterComplete}
              />
              <TracerouteBoundsController bounds={tracerouteBounds} />
              {getTilesetById(activeTileset, customTilesets).isVector ? (
                <VectorTileLayer
                  url={getTilesetById(activeTileset, customTilesets).url}
                  attribution={getTilesetById(activeTileset, customTilesets).attribution}
                  maxZoom={getTilesetById(activeTileset, customTilesets).maxZoom}
                />
              ) : (
                <TileLayer
                  attribution={getTilesetById(activeTileset, customTilesets).attribution}
                  url={getTilesetById(activeTileset, customTilesets).url}
                  maxZoom={getTilesetById(activeTileset, customTilesets).maxZoom}
                />
              )}
              <ZoomHandler onZoomChange={setMapZoom} />
              <MapPositionHandler />
              <MapResizeHandler trigger={showPacketMonitor} />
              <SpiderfierController ref={spiderfierRef} zoomLevel={mapZoom} />
              <MapLegend />
              {nodesWithPosition
                .filter(node => {
                  // Apply standard filters
                  if (!showMqttNodes && node.viaMqtt) return false;
                  if (!showIncompleteNodes && !isNodeComplete(node)) return false;
                  if (!showEstimatedPositions && node.user?.id && nodesWithEstimatedPosition.has(node.user.id)) return false;
                  // When traceroute is active, only show nodes involved in the traceroute
                  if (tracerouteNodeNums && !tracerouteNodeNums.has(node.nodeNum)) return false;
                  return true;
                })
                .map(node => {
                const roleNum = typeof node.user?.role === 'string'
                  ? parseInt(node.user.role, 10)
                  : (typeof node.user?.role === 'number' ? node.user.role : 0);
                const isRouter = roleNum === 2;
                const isSelected = selectedNodeId === node.user?.id;

                // Get hop count for this node
                // Local node always gets 0 hops (green), otherwise use effective hops based on setting
                const isLocalNode = node.user?.id === currentNodeId;
                const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                const showLabel = mapZoom >= 13; // Show labels when zoomed in

                const shouldAnimate = showAnimations && animatedNodes.has(node.user?.id || '');

                const markerIcon = createNodeIcon({
                  hops: hops, // 0 (local) = green, 999 (no hops_away data) = grey
                  isSelected,
                  isRouter,
                  shortName: node.user?.shortName,
                  showLabel: showLabel || shouldAnimate, // Show label when animating OR zoomed in
                  animate: shouldAnimate,
                  highlightSelected: showRoute && isSelected,
                  pinStyle: mapPinStyle
                });

                // Use memoized position to prevent React-Leaflet from resetting marker position
                const position = nodePositions.get(node.nodeNum)!;

                // Calculate opacity based on last heard time
                const markerOpacity = calculateNodeOpacity(
                  node.lastHeard,
                  nodeDimmingEnabled,
                  nodeDimmingStartHours,
                  nodeDimmingMinOpacity,
                  maxNodeAgeHours
                );

                return (
              <Marker
                key={node.nodeNum}
                position={position}
                icon={markerIcon}
                opacity={markerOpacity}
                zIndexOffset={shouldAnimate ? 10000 : 0}
                ref={(ref) => handleMarkerRef(ref, node.user?.id)}
              >
                {!isTouchDevice && (
                  <Tooltip direction="top" offset={[0, -20]} opacity={0.9} interactive>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 'bold' }}>
                        {node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16)}`}
                      </div>
                      {(() => {
                        const tooltipHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                        return tooltipHops < 999 ? (
                          <div style={{ fontSize: '0.85em', opacity: 0.8 }}>
                            {tooltipHops} hop{tooltipHops !== 1 ? 's' : ''}
                          </div>
                        ) : null;
                      })()}
                    </div>
                  </Tooltip>
                )}
                {/* Hide popup when showRoute is enabled and node has a valid traceroute,
                    since TracerouteBoundsController zooms to fit the route */}
                {!(showRoute && traceroutes.some(tr => {
                  const matches = tr.toNodeId === node.user?.id || tr.fromNodeId === node.user?.id;
                  if (!matches) return false;
                  return tr.route && tr.route !== 'null' && tr.route !== '' &&
                         tr.routeBack && tr.routeBack !== 'null' && tr.routeBack !== '';
                })) && (
                  <Popup autoPan={false}>
                    <MapNodePopupContent
                      node={node}
                      nodes={nodes}
                      currentNodeId={currentNodeId}
                      timeFormat={timeFormat}
                      dateFormat={dateFormat}
                      distanceUnit={distanceUnit}
                      traceroutes={traceroutes}
                      hasPermission={hasPermission}
                      onDMNode={handlePopupDMClick(node)}
                      onTraceroute={onTraceroute ? () => onTraceroute(node.user!.id) : undefined}
                      connectionStatus={connectionStatus}
                      tracerouteLoading={tracerouteLoading}
                      getEffectiveHops={(n) => getEffectiveHops(n, nodeHopsCalculation, traceroutes, currentNodeNum)}
                    />
                  </Popup>
                )}
              </Marker>
                );
              })}

              {/* MeshCore nodes */}
              {showMeshCoreNodes && meshCoreNodes
                .filter(node => node.latitude && node.longitude)
                .map(node => {
                  const position: [number, number] = [node.latitude, node.longitude];
                  // Use MeshCore theme color (Catppuccin mauve) for MeshCore nodes
                  const meshCoreIcon = L.divIcon({
                    className: 'meshcore-marker',
                    html: `
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
                        color: var(--ctp-base, #1e1e2e);
                        font-size: 10px;
                        font-weight: bold;
                      ">MC</div>
                      <div style="
                        position: absolute;
                        top: -20px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: ${MESHCORE_COLOR}e6;
                        color: var(--ctp-base, #1e1e2e);
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-size: 11px;
                        white-space: nowrap;
                      ">${node.name || 'MeshCore'}</div>
                    `,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12],
                  });

                  return (
                    <Marker
                      key={`meshcore-${node.publicKey}`}
                      position={position}
                      icon={meshCoreIcon}
                    >
                      <Tooltip>
                        <strong>{node.name || 'MeshCore Node'}</strong>
                        <br />
                        <small>MeshCore Device</small>
                        {node.rssi !== undefined && <><br />RSSI: {node.rssi} dBm</>}
                        {node.snr !== undefined && <><br />SNR: {node.snr} dB</>}
                      </Tooltip>
                      <Popup>
                        <div style={{ minWidth: '200px' }}>
                          <h3 style={{ margin: '0 0 8px 0', color: 'var(--ctp-mauve)' }}>
                            {node.name || 'MeshCore Node'}
                          </h3>
                          <div style={{ fontSize: '12px', color: '#666' }}>
                            <strong>Type:</strong> MeshCore Device<br />
                            <strong>Public Key:</strong> {node.publicKey.substring(0, 16)}...<br />
                            {node.latitude && <><strong>Latitude:</strong> {node.latitude.toFixed(6)}<br /></>}
                            {node.longitude && <><strong>Longitude:</strong> {node.longitude.toFixed(6)}<br /></>}
                            {node.rssi !== undefined && <><strong>RSSI:</strong> {node.rssi} dBm<br /></>}
                            {node.snr !== undefined && <><strong>SNR:</strong> {node.snr} dB<br /></>}
                            {node.lastSeen && <><strong>Last Seen:</strong> {new Date(node.lastSeen).toLocaleString()}<br /></>}
                          </div>
                        </div>
                      </Popup>
                    </Marker>
                  );
                })}

              {/* Draw uncertainty circles for estimated positions */}
              {showEstimatedPositions && nodesWithPosition
                .filter(node => node.user?.id && nodesWithEstimatedPosition.has(node.user.id) && (showMqttNodes || !node.viaMqtt) && (showIncompleteNodes || isNodeComplete(node)) && (!tracerouteNodeNums || tracerouteNodeNums.has(node.nodeNum)))
                .map(node => {
                  // Calculate radius based on precision bits (higher precision = smaller circle)
                  // Meshtastic uses precision_bits to reduce coordinate precision
                  // Each precision bit reduces precision by ~1 bit, roughly doubling the uncertainty
                  // We'll use a base radius and scale it
                  const baseRadiusMeters = 500; // Base uncertainty radius
                  const radiusMeters = baseRadiusMeters; // Can be adjusted based on precision_bits if available

                  // Get hop color for the circle (same as marker)
                  const isLocalNode = node.user?.id === currentNodeId;
                  const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                  const color = getHopColor(hops);

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

              {/* Draw position accuracy regions (rectangles) for all nodes with precision data */}
              {showAccuracyRegions && nodesWithPosition
                .filter(node => {
                  // Check precision data exists
                  if (node.positionPrecisionBits === undefined || node.positionPrecisionBits === null) return false;
                  if (node.positionPrecisionBits <= 0 || node.positionPrecisionBits >= 32) return false;
                  // Don't show accuracy region for nodes with overridden positions
                  if (node.positionIsOverride) return false;
                  // Apply standard filters
                  if (!showMqttNodes && node.viaMqtt) return false;
                  if (!showIncompleteNodes && !isNodeComplete(node)) return false;
                  // When traceroute is active, only show regions for nodes in the traceroute
                  if (tracerouteNodeNums && !tracerouteNodeNums.has(node.nodeNum)) return false;
                  return true;
                })
                .map(node => {
                  // Convert precision_bits to size in meters
                  // precision_bits indicates how many bits of lat/lon are valid
                  // Earth's circumference is ~40,075,000 meters
                  // At N precision bits, the grid cell size is Earth's circumference / 2^N
                  const earthCircumference = 40_075_000; // meters
                  const sizeMeters = earthCircumference / Math.pow(2, node.positionPrecisionBits!);
                  const halfSizeMeters = sizeMeters / 2;

                  // Convert meters to lat/lng offsets
                  // 1 degree of latitude is approximately 111,111 meters
                  const metersPerDegreeLat = 111_111;
                  const lat = node.position!.latitude;
                  const lng = node.position!.longitude;

                  // Latitude offset is constant
                  const latOffset = halfSizeMeters / metersPerDegreeLat;

                  // Longitude offset varies with latitude (cos(lat) factor)
                  const metersPerDegreeLng = metersPerDegreeLat * Math.cos(lat * Math.PI / 180);
                  const lngOffset = halfSizeMeters / metersPerDegreeLng;

                  // Calculate bounds: [[south, west], [north, east]]
                  const bounds: [[number, number], [number, number]] = [
                    [lat - latOffset, lng - lngOffset],
                    [lat + latOffset, lng + lngOffset]
                  ];

                  // Get hop color for the region (same as marker)
                  const isLocalNode = node.user?.id === currentNodeId;
                  const hops = isLocalNode ? 0 : getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                  const color = getHopColor(hops);

                  return (
                    <Rectangle
                      key={`accuracy-${node.nodeNum}`}
                      bounds={bounds}
                      pathOptions={{
                        color: color,
                        fillColor: color,
                        fillOpacity: 0.08,
                        opacity: 0.5,
                        weight: 1,
                      }}
                    />
                  );
                })}

              {/* Draw traceroute paths (independent layer) */}
              <TraceroutePathsLayer paths={traceroutePathsElements} enabled={showPaths} />

              {/* Draw selected node traceroute (independent layer) */}
              <SelectedTracerouteLayer traceroute={selectedNodeTraceroute} enabled={showRoute} />

              {/* Draw neighbor info connections */}
              {showNeighborInfo && neighborInfo.length > 0 && neighborInfo.map((ni, idx) => {
                // Skip if either node doesn't have position
                if (!ni.nodeLatitude || !ni.nodeLongitude || !ni.neighborLatitude || !ni.neighborLongitude) {
                  return null;
                }

                // Filter out segments where either endpoint is not visible (Issue #1149)
                if (visibleNodeNums && (!visibleNodeNums.has(ni.nodeNum) || !visibleNodeNums.has(ni.neighborNodeNum))) {
                  return null;
                }

                // When traceroute is active, only show segments for nodes in the traceroute
                if (tracerouteNodeNums && (!tracerouteNodeNums.has(ni.nodeNum) || !tracerouteNodeNums.has(ni.neighborNodeNum))) {
                  return null;
                }

                const positions: [number, number][] = [
                  [ni.nodeLatitude, ni.nodeLongitude],
                  [ni.neighborLatitude, ni.neighborLongitude]
                ];

                return (
                  <Polyline
                    key={`neighbor-${idx}`}
                    positions={positions}
                    color="#cba6f7"
                    weight={4}
                    opacity={0.7}
                    dashArray="5, 5"
                  >
                    <Popup>
                      <div className="route-popup">
                        <h4>Neighbor Connection</h4>
                        <div className="route-endpoints">
                          <strong>{ni.nodeName}</strong> ↔ <strong>{ni.neighborName}</strong>
                        </div>
                        {ni.snr !== null && ni.snr !== undefined && (
                          <div className="route-usage">
                            SNR: <strong>{ni.snr.toFixed(1)} dB</strong>
                          </div>
                        )}
                        <div className="route-usage">
                          Last seen: <strong>{formatDateTime(new Date(ni.timestamp), timeFormat, dateFormat)}</strong>
                        </div>
                      </div>
                    </Popup>
                  </Polyline>
                );
              })}

              {/* Note: Selected node traceroute with separate forward and back paths */}
              {/* This is handled by traceroutePathsElements passed from parent */}

              {/* Draw position history for mobile nodes with color gradient */}
              {showMotion && positionHistory.length > 1 && (() => {
                // Filter position history based on slider value
                const filteredHistory = positionHistoryHours != null
                  ? positionHistory.filter(p => p.timestamp >= Date.now() - (positionHistoryHours * 60 * 60 * 1000))
                  : positionHistory;

                // Need at least 2 positions to draw a line
                if (filteredHistory.length < 2) return null;

                const elements: React.ReactElement[] = [];
                const segmentCount = filteredHistory.length - 1;
                const segmentColors: string[] = [];

                // Draw individual segments with gradient colors
                for (let i = 0; i < segmentCount; i++) {
                  const startPos = filteredHistory[i];
                  const endPos = filteredHistory[i + 1];
                  const color = getPositionHistoryColor(i, segmentCount);
                  segmentColors.push(color);

                  // Generate path - use Bezier curve if heading data is available
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
                      color={color}
                      weight={3}
                      opacity={0.8}
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
                            const converted = startPos.groundSpeed * 3.6;
                            // If converted > 200 km/h, assume raw is already in km/h
                            const speedKmh = converted > 200 ? startPos.groundSpeed : converted;
                            // Convert to mph if user prefers miles
                            const speed = distanceUnit === 'mi' ? speedKmh * 0.621371 : speedKmh;
                            const unit = distanceUnit === 'mi' ? 'mph' : 'km/h';
                            return (
                              <div className="route-usage">
                                <strong>Speed:</strong> {speed.toFixed(1)} {unit}
                              </div>
                            );
                          })()}
                          {startPos.groundTrack !== undefined && (() => {
                            // Data is stored in millidegrees - detect and convert
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

                // Generate arrow markers with performance limiting (max 30 arrows)
                // Pass full history items so arrows can show heading and popup info
                const historyArrows = generatePositionHistoryArrows(
                  filteredHistory,
                  segmentColors,
                  30,
                  distanceUnit
                );
                elements.push(...historyArrows);

                return elements;
              })()}

              {/* Position History Legend */}
              {showMotion && positionHistory.length > 1 && (() => {
                const filteredHistory = positionHistoryHours != null
                  ? positionHistory.filter(p => p.timestamp >= Date.now() - (positionHistoryHours * 60 * 60 * 1000))
                  : positionHistory;

                if (filteredHistory.length < 2) return null;

                return (
                  <PositionHistoryLegend
                    oldestTime={filteredHistory[0].timestamp}
                    newestTime={filteredHistory[filteredHistory.length - 1].timestamp}
                    timeFormat={timeFormat}
                    dateFormat={dateFormat}
                  />
                );
              })()}
          </MapContainer>
          <TilesetSelector
            selectedTilesetId={activeTileset}
            onTilesetChange={setMapTileset}
          />
          {nodesWithPosition.length === 0 && meshCoreNodes.filter(n => n.latitude && n.longitude).length === 0 && (
            <div className="map-overlay">
              <div className="overlay-content">
                <h3>📍 No Node Locations</h3>
                <p>No nodes in your network are currently sharing location data.</p>
                <p>Nodes with GPS enabled will appear as markers on this map.</p>
              </div>
            </div>
          )}
          </>
        ) : (
          <div className="map-placeholder">
            <div className="placeholder-content">
              <h3>Map View</h3>
              <p>Connect to a Meshtastic or MeshCore device to view node locations on the map</p>
            </div>
          </div>
        )}
      </div>

      {/* Packet Monitor Panel (Desktop Only) */}
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

      {/* Node Filter Popup */}
      <NodeFilterPopup
        isOpen={showNodeFilterPopup}
        onClose={() => setShowNodeFilterPopup(false)}
      />
    </div>
  );
};

// Memoize NodesTab to prevent re-rendering when App.tsx updates for message status
// Only re-render when actual node data or map-related props change
const NodesTab = React.memo(NodesTabComponent, (prevProps, nextProps) => {
  // Check if favorite status changed for any node
  // Build sets of favorite node numbers for comparison
  const prevFavorites = new Set(
    prevProps.processedNodes.filter(n => n.isFavorite).map(n => n.nodeNum)
  );
  const nextFavorites = new Set(
    nextProps.processedNodes.filter(n => n.isFavorite).map(n => n.nodeNum)
  );

  // If the sets differ in size or content, favorites changed - must re-render
  if (prevFavorites.size !== nextFavorites.size) {
    return false; // Allow re-render
  }
  for (const nodeNum of prevFavorites) {
    if (!nextFavorites.has(nodeNum)) {
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
