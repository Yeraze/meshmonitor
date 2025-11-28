import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Tooltip, Polyline, Circle } from 'react-leaflet';
import type { Marker as LeafletMarker } from 'leaflet';
import { DeviceInfo } from '../types/device';
import { TabType } from '../types/ui';
import { ResourceType } from '../types/permission';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { generateArrowMarkers } from '../utils/mapHelpers.tsx';
import { getHardwareModelName, getRoleName } from '../utils/nodeHelpers';
import { formatTime, formatDateTime } from '../utils/datetime';
import { getTilesetById } from '../config/tilesets';
import { useMapContext } from '../contexts/MapContext';
import { useData } from '../contexts/DataContext';
import { useUI } from '../contexts/UIContext';
import { useSettings } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
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

/**
 * Spiderfier initialization constants
 */
const SPIDERFIER_INIT = {
  /** Maximum attempts to wait for spiderfier initialization */
  MAX_ATTEMPTS: 50,
  /** Interval between initialization attempts (ms) - 50 attempts × 100ms = 5 seconds total */
  RETRY_INTERVAL_MS: 100,
} as const;

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
}

// Helper function to check if a date is today
const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
};

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
}) => {
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
    showAnimations,
    setShowAnimations,
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
  } = useMapContext();

  const {
    currentNodeId,
    nodesWithTelemetry,
    nodesWithWeatherTelemetry,
    nodesWithEstimatedPosition,
    nodesWithPKC,
  } = useData();

  const {
    nodeFilter,
    setNodeFilter,
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
  } = useUI();

  const {
    timeFormat,
    dateFormat,
    mapTileset,
    setMapTileset,
    mapPinStyle,
    customTilesets,
  } = useSettings();

  const { hasPermission } = useAuth();

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

  // Track if packet logging is enabled on the server
  const [packetLogEnabled, setPacketLogEnabled] = useState<boolean>(false);

  // Track if map controls are collapsed
  const [isMapControlsCollapsed, setIsMapControlsCollapsed] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('isMapControlsCollapsed');
    return saved === 'true';
  });

  // Save packet monitor preference to localStorage
  useEffect(() => {
    localStorage.setItem('showPacketMonitor', showPacketMonitor.toString());
  }, [showPacketMonitor]);

  // Save map controls collapse state to localStorage
  useEffect(() => {
    localStorage.setItem('isMapControlsCollapsed', isMapControlsCollapsed.toString());
  }, [isMapControlsCollapsed]);

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

  // Stable ref callback for markers to prevent unnecessary re-renders
  const handleMarkerRef = React.useCallback((ref: LeafletMarker | null, nodeId: string | undefined) => {
    if (ref && nodeId) {
      markerRefs.current.set(nodeId, ref);
      // Add marker to spiderfier for overlap handling, passing nodeId to allow multiple markers at same position
      spiderfierRef.current?.addMarker(ref, nodeId);
    }
  }, []); // Empty deps - function never changes

  // Stable callback factories for node item interactions
  const handleNodeClick = useCallback((node: DeviceInfo) => {
    return () => {
      setSelectedNodeId(node.user?.id || null);
      centerMapOnNode(node);
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
  }, [setSelectedNodeId, centerMapOnNode, setIsNodeListCollapsed]);

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
    setIsNodeListCollapsed(!isNodeListCollapsed);
  }, [isNodeListCollapsed, setIsNodeListCollapsed]);

  const handleToggleFilterPopup = useCallback(() => {
    setShowNodeFilterPopup(!showNodeFilterPopup);
  }, [showNodeFilterPopup, setShowNodeFilterPopup]);

  const handleToggleSortDirection = useCallback(() => {
    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
  }, [sortDirection, setSortDirection]);

  const handleCollapseMapControls = useCallback(() => {
    setIsMapControlsCollapsed(!isMapControlsCollapsed);
  }, [isMapControlsCollapsed, setIsMapControlsCollapsed]);

  // Update refs when values change
  useEffect(() => {
    processedNodesRef.current = processedNodes;
    setSelectedNodeIdRef.current = setSelectedNodeId;
    centerMapOnNodeRef.current = centerMapOnNode;
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
          // Find the node to center on it
          const node = processedNodesRef.current.find(n => n.user?.id === nodeId);
          if (node) {
            centerMapOnNodeRef.current(node);
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
          aVal = a.hopsAway ?? 999;
          bVal = b.hopsAway ?? 999;
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
  }, [sortField, sortDirection]);

  // Calculate nodes with position
  const nodesWithPosition = processedNodes.filter(node =>
    node.position &&
    node.position.latitude != null &&
    node.position.longitude != null
  );

  // Memoize node positions to prevent React-Leaflet from resetting marker positions
  // Creating new [lat, lng] arrays causes React-Leaflet to move markers, destroying spiderfier state
  const nodePositions = React.useMemo(() => {
    const posMap = new Map<number, [number, number]>();
    nodesWithPosition.forEach(node => {
      posMap.set(node.nodeNum, [node.position!.latitude, node.position!.longitude]);
    });
    return posMap;
  }, [nodesWithPosition.map(n => `${n.nodeNum}-${n.position!.latitude}-${n.position!.longitude}`).join(',')]);

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
    if (currentNodeId) {
      const localNode = nodesWithPosition.find(node => node.user?.id === currentNodeId);
      if (localNode && localNode.position) {
        return [localNode.position.latitude, localNode.position.longitude];
      }
    }

    // Fall back to average position of all nodes
    const avgLat = nodesWithPosition.reduce((sum, node) => sum + node.position!.latitude, 0) / nodesWithPosition.length;
    const avgLng = nodesWithPosition.reduce((sum, node) => sum + node.position!.longitude, 0) / nodesWithPosition.length;
    return [avgLat, avgLng];
  };

  return (
    <div className="nodes-split-view">
      {/* Floating Node List Panel */}
      <div className={`nodes-sidebar ${isNodeListCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <button
            className="collapse-nodes-btn"
            onClick={handleCollapseNodeList}
            title={isNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
          >
            {isNodeListCollapsed ? '▶' : '◀'}
          </button>
          {!isNodeListCollapsed && (
          <div className="sidebar-header-content">
            <h3>Nodes ({(() => {
              const filteredCount = processedNodes.filter(node => {
                if (securityFilter === 'flaggedOnly') {
                  return node.keyIsLowEntropy || node.duplicateKeyDetected;
                }
                if (securityFilter === 'hideFlagged') {
                  return !node.keyIsLowEntropy && !node.duplicateKeyDetected;
                }
                return true;
              }).length;
              return securityFilter !== 'all' ? `${filteredCount}/${processedNodes.length}` : processedNodes.length;
            })()})</h3>
          </div>
          )}
          {!isNodeListCollapsed && (
          <div className="node-controls">
            <input
              type="text"
              placeholder="Filter nodes..."
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              className="filter-input-small"
            />
            <div className="sort-controls">
              <button
                className="filter-popup-btn"
                onClick={handleToggleFilterPopup}
                title="Filter nodes"
              >
                Filter
              </button>
              <select
                value={sortField}
                onChange={(e) => setSortField(e.target.value as any)}
                className="sort-dropdown"
                title="Sort nodes by"
              >
                <option value="longName">Sort: Name</option>
                <option value="shortName">Sort: Short Name</option>
                <option value="id">Sort: ID</option>
                <option value="lastHeard">Sort: Updated</option>
                <option value="snr">Sort: Signal</option>
                <option value="battery">Sort: Charge</option>
                <option value="hwModel">Sort: Hardware</option>
                <option value="hops">Sort: Hops</option>
              </select>
              <button
                className="sort-direction-btn"
                onClick={handleToggleSortDirection}
                title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
          )}
        </div>

        {!isNodeListCollapsed && (
        <div className="nodes-list">
          {shouldShowData() ? (() => {
            // Apply security and channel filters
            const filteredNodes = processedNodes.filter(node => {
              // Security filter
              if (securityFilter === 'flaggedOnly') {
                if (!node.keyIsLowEntropy && !node.duplicateKeyDetected) return false;
              }
              if (securityFilter === 'hideFlagged') {
                if (node.keyIsLowEntropy || node.duplicateKeyDetected) return false;
              }

              // Channel filter
              if (channelFilter !== 'all') {
                const nodeChannel = node.channel ?? 0;
                if (nodeChannel !== channelFilter) return false;
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
                        title={node.isFavorite ? "Remove from favorites" : "Add to favorites"}
                        onClick={handleFavoriteClick(node)}
                      >
                        {node.isFavorite ? '⭐' : '☆'}
                      </button>
                      <div className="node-name-text">
                        <div className="node-longname">
                          {node.user?.longName || `Node ${node.nodeNum}`}
                        </div>
                        {node.user?.role !== undefined && node.user?.role !== null && getRoleName(node.user.role) && (
                          <div className="node-role" title="Node Role">{getRoleName(node.user.role)}</div>
                        )}
                      </div>
                    </div>
                    <div className="node-actions">
                      {hasPermission('messages', 'read') && (
                        <button
                          className="dm-icon"
                          title="Send Direct Message"
                          onClick={handleDMClick(node)}
                        >
                          💬
                        </button>
                      )}
                      {(node.keyIsLowEntropy || node.duplicateKeyDetected) && (
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
                          ⚠️
                        </span>
                      )}
                      <div className="node-short">
                        {node.user?.shortName || '-'}
                      </div>
                    </div>
                  </div>

                  <div className="node-details">
                    <div className="node-stats">
                      {node.snr != null && (
                        <span className="stat" title="Signal-to-Noise Ratio">
                          📶 {node.snr.toFixed(1)}dB
                        </span>
                      )}
                      {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                        <span className="stat" title={node.deviceMetrics.batteryLevel === 101 ? "Plugged In" : "Battery Level"}>
                          {node.deviceMetrics.batteryLevel === 101 ? '🔌' : `🔋 ${node.deviceMetrics.batteryLevel}%`}
                        </span>
                      )}
                      {node.hopsAway != null && (
                        <span className="stat" title="Hops Away">
                          🔗 {node.hopsAway} hop{node.hopsAway !== 1 ? 's' : ''}
                          {node.channel != null && node.channel !== 0 && ` (ch:${node.channel})`}
                        </span>
                      )}
                    </div>

                    <div className="node-time">
                      {node.lastHeard ? (() => {
                        const date = new Date(node.lastHeard * 1000);
                        return isToday(date)
                          ? formatTime(date, timeFormat)
                          : formatDateTime(date, timeFormat, dateFormat);
                      })() : 'Never'}
                    </div>
                  </div>

                  <div className="node-indicators">
                    {node.position && node.position.latitude != null && node.position.longitude != null && (
                      <div className="node-location" title="Location">
                        📍 {node.position.latitude.toFixed(3)}, {node.position.longitude.toFixed(3)}
                        {node.isMobile && <span title="Mobile Node (position varies > 1km)" style={{ marginLeft: '4px' }}>🚶</span>}
                      </div>
                    )}
                    {node.viaMqtt && (
                      <div className="node-mqtt" title="Connected via MQTT">
                        🌐
                      </div>
                    )}
                    {node.user?.id && nodesWithTelemetry.has(node.user.id) && (
                      <div className="node-telemetry" title="Has Telemetry Data">
                        📊
                      </div>
                    )}
                    {node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
                      <div className="node-weather" title="Has Weather Data">
                        ☀️
                      </div>
                    )}
                    {node.user?.id && nodesWithPKC.has(node.user.id) && (
                      <div className="node-pkc" title="Has Public Key Cryptography">
                        🔐
                      </div>
                    )}
                  </div>
                </div>
              ))}
              </>
            ) : (
              <div className="no-data">
                {securityFilter !== 'all' ? 'No nodes match security filter' : (nodeFilter ? 'No nodes match filter' : 'No nodes detected')}
              </div>
            );
          })() : (
            <div className="no-data">
              Connect to Meshtastic node
            </div>
          )}
        </div>
        )}
      </div>

      {/* Right Side - Map and Optional Packet Monitor */}
      <div className={`map-container ${showPacketMonitor && canViewPacketMonitor ? 'with-packet-monitor' : ''}`}>
        {shouldShowData() ? (
          <>
            <div className={`map-controls ${isMapControlsCollapsed ? 'collapsed' : ''}`}>
              <button
                className="map-controls-collapse-btn"
                onClick={handleCollapseMapControls}
                title={isMapControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
              >
                {isMapControlsCollapsed ? '▼' : '▲'}
              </button>
              {!isMapControlsCollapsed && (
                <>
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
                      checked={showMotion}
                      onChange={(e) => setShowMotion(e.target.checked)}
                    />
                    <span>Show Position History</span>
                  </label>
                  <label className="map-control-item">
                    <input
                      type="checkbox"
                      checked={showAnimations}
                      onChange={(e) => setShowAnimations(e.target.checked)}
                    />
                    <span>Show Animations</span>
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
                .filter(node => showMqttNodes || !node.viaMqtt)
                .map(node => {
                const roleNum = typeof node.user?.role === 'string'
                  ? parseInt(node.user.role, 10)
                  : (typeof node.user?.role === 'number' ? node.user.role : 0);
                const isRouter = roleNum === 2;
                const isSelected = selectedNodeId === node.user?.id;

                // Get hop count for this node
                // Local node always gets 0 hops (green), otherwise use hopsAway from protobuf
                const isLocalNode = node.user?.id === currentNodeId;
                const hops = isLocalNode ? 0 : (node.hopsAway ?? 999);
                const showLabel = mapZoom >= 13; // Show labels when zoomed in

                const shouldAnimate = showAnimations && animatedNodes.has(node.user?.id || '');

                const markerIcon = createNodeIcon({
                  hops: hops, // 0 (local) = green, 999 (no hops_away data) = grey
                  isSelected,
                  isRouter,
                  shortName: node.user?.shortName,
                  showLabel: showLabel || shouldAnimate, // Show label when animating OR zoomed in
                  animate: shouldAnimate,
                  pinStyle: mapPinStyle
                });

                // Use memoized position to prevent React-Leaflet from resetting marker position
                const position = nodePositions.get(node.nodeNum)!;

                return (
              <Marker
                key={node.nodeNum}
                position={position}
                icon={markerIcon}
                zIndexOffset={shouldAnimate ? 10000 : 0}
                ref={(ref) => handleMarkerRef(ref, node.user?.id)}
              >
                {!isTouchDevice && (
                  <Tooltip direction="top" offset={[0, -20]} opacity={0.9} interactive>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 'bold' }}>
                        {node.user?.longName || node.user?.shortName || `!${node.nodeNum.toString(16)}`}
                      </div>
                      {node.hopsAway !== undefined && (
                        <div style={{ fontSize: '0.85em', opacity: 0.8 }}>
                          {node.hopsAway} hop{node.hopsAway !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  </Tooltip>
                )}
                <Popup autoPan={false}>
                  <div className="node-popup">
                    <div className="node-popup-header">
                      <div className="node-popup-title">{node.user?.longName || `Node ${node.nodeNum}`}</div>
                      {node.user?.shortName && (
                        <div className="node-popup-subtitle">{node.user.shortName}</div>
                      )}
                    </div>

                    <div className="node-popup-grid">
                      {node.user?.id && (
                        <div className="node-popup-item">
                          <span className="node-popup-icon">🆔</span>
                          <span className="node-popup-value">{node.user.id}</span>
                        </div>
                      )}

                      {node.user?.role !== undefined && (() => {
                        const roleNum = typeof node.user.role === 'string'
                          ? parseInt(node.user.role, 10)
                          : node.user.role;
                        const roleName = getRoleName(roleNum);
                        return roleName ? (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">👤</span>
                            <span className="node-popup-value">{roleName}</span>
                          </div>
                        ) : null;
                      })()}

                      {node.user?.hwModel !== undefined && (() => {
                        const hwModelName = getHardwareModelName(node.user.hwModel);
                        return hwModelName ? (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">🖥️</span>
                            <span className="node-popup-value">{hwModelName}</span>
                          </div>
                        ) : null;
                      })()}

                      {node.snr != null && (
                        <div className="node-popup-item">
                          <span className="node-popup-icon">📶</span>
                          <span className="node-popup-value">{node.snr.toFixed(1)} dB</span>
                        </div>
                      )}

                      {node.hopsAway != null && (
                        <div className="node-popup-item">
                          <span className="node-popup-icon">🔗</span>
                          <span className="node-popup-value">{node.hopsAway} hop{node.hopsAway !== 1 ? 's' : ''}</span>
                        </div>
                      )}

                      {node.position?.altitude != null && (
                        <div className="node-popup-item">
                          <span className="node-popup-icon">⛰️</span>
                          <span className="node-popup-value">{node.position.altitude}m</span>
                        </div>
                      )}

                      {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                        <div className="node-popup-item">
                          <span className="node-popup-icon">{node.deviceMetrics.batteryLevel === 101 ? '🔌' : '🔋'}</span>
                          <span className="node-popup-value">
                            {node.deviceMetrics.batteryLevel === 101 ? 'Plugged In' : `${node.deviceMetrics.batteryLevel}%`}
                          </span>
                        </div>
                      )}
                    </div>

                    {node.lastHeard && (
                      <div className="node-popup-footer">
                        <span className="node-popup-icon">🕐</span>
                        {formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)}
                      </div>
                    )}

                    {node.user?.id && hasPermission('messages', 'read') && (
                      <button
                        className="node-popup-btn"
                        onClick={handlePopupDMClick(node)}
                      >
                        💬 Direct Message
                      </button>
                    )}
                  </div>
                </Popup>
              </Marker>
                );
              })}

              {/* Draw uncertainty circles for estimated positions */}
              {nodesWithPosition
                .filter(node => node.user?.id && nodesWithEstimatedPosition.has(node.user.id))
                .map(node => {
                  // Calculate radius based on precision bits (higher precision = smaller circle)
                  // Meshtastic uses precision_bits to reduce coordinate precision
                  // Each precision bit reduces precision by ~1 bit, roughly doubling the uncertainty
                  // We'll use a base radius and scale it
                  const baseRadiusMeters = 500; // Base uncertainty radius
                  const radiusMeters = baseRadiusMeters; // Can be adjusted based on precision_bits if available

                  // Get hop color for the circle (same as marker)
                  const isLocalNode = node.user?.id === currentNodeId;
                  const hops = isLocalNode ? 0 : (node.hopsAway ?? 999);
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

              {/* Draw position history for mobile nodes */}
              {showMotion && positionHistory.length > 1 && (() => {
                const historyPositions: [number, number][] = positionHistory.map(p =>
                  [p.latitude, p.longitude] as [number, number]
                );

                const elements: React.ReactElement[] = [];

                // Draw blue line for position history
                elements.push(
                  <Polyline
                    key="position-history-line"
                    positions={historyPositions}
                    color="#0066ff"
                    weight={3}
                    opacity={0.7}
                  >
                    <Popup>
                      <div className="route-popup">
                        <h4>Position History</h4>
                        <div className="route-usage">
                          {positionHistory.length} position{positionHistory.length !== 1 ? 's' : ''} recorded
                        </div>
                        <div className="route-usage">
                          {formatDateTime(new Date(positionHistory[0].timestamp), timeFormat, dateFormat)} - {formatDateTime(new Date(positionHistory[positionHistory.length - 1].timestamp), timeFormat, dateFormat)}
                        </div>
                      </div>
                    </Popup>
                  </Polyline>
                );

                // Generate arrow markers for position history
                const historyArrows = generateArrowMarkers(
                  historyPositions,
                  'position-history',
                  '#0066ff',
                  0
                );
                elements.push(...historyArrows);

                return elements;
              })()}
          </MapContainer>
          <TilesetSelector
            selectedTilesetId={activeTileset}
            onTilesetChange={setMapTileset}
          />
          {nodesWithPosition.length === 0 && (
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
              <p>Connect to a Meshtastic node to view node locations on the map</p>
            </div>
          </div>
        )}
      </div>

      {/* Packet Monitor Panel (Desktop Only) */}
      {showPacketMonitor && canViewPacketMonitor && (
        <div className="packet-monitor-container">
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

  // For everything else (including MapContext changes like animatedNodes),
  // use default comparison which will cause re-render if props differ
  return false; // Allow re-render for other changes
});

export default NodesTab;
