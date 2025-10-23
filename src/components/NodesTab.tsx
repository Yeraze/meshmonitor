import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle } from 'react-leaflet';
import type { Marker as LeafletMarker } from 'leaflet';
import { DeviceInfo } from '../types/device';
import { TabType } from '../types/ui';
import { createNodeIcon, getHopColor } from '../utils/mapIcons';
import { getRoleName, generateArrowMarkers } from '../utils/mapHelpers.tsx';
import { getHardwareModelName } from '../utils/nodeHelpers';
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
import { TilesetSelector } from './TilesetSelector';
import { MapCenterController } from './MapCenterController';
import PacketMonitorPanel from './PacketMonitorPanel';
import { getPacketStats } from '../services/packetApi';

interface NodesTabProps {
  processedNodes: DeviceInfo[];
  shouldShowData: () => boolean;
  centerMapOnNode: (node: DeviceInfo) => void;
  toggleFavorite: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  setActiveTab: React.Dispatch<React.SetStateAction<TabType>>;
  setSelectedDMNode: (nodeId: string) => void;
  markerRefs: React.MutableRefObject<Map<string, LeafletMarker>>;
  traceroutePathsElements: React.ReactNode;
}

// Helper function to check if a date is today
const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
};

const NodesTab: React.FC<NodesTabProps> = ({
  processedNodes,
  shouldShowData,
  centerMapOnNode,
  toggleFavorite,
  setActiveTab,
  setSelectedDMNode,
  markerRefs,
  traceroutePathsElements,
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
    mapCenterTarget,
    setMapCenterTarget,
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
    temporaryTileset,
    setTemporaryTileset,
    mapTileset,
  } = useSettings();

  const { hasPermission } = useAuth();

  // Packet Monitor state (desktop only)
  const [showPacketMonitor, setShowPacketMonitor] = useState(() => {
    // Load from localStorage
    const saved = localStorage.getItem('showPacketMonitor');
    return saved === 'true';
  });

  // Track if packet logging is enabled on the server
  const [packetLogEnabled, setPacketLogEnabled] = useState<boolean>(false);

  // Save packet monitor preference to localStorage
  useEffect(() => {
    localStorage.setItem('showPacketMonitor', showPacketMonitor.toString());
  }, [showPacketMonitor]);

  // Check if user has permission to view packet monitor
  const canViewPacketMonitor = hasPermission('channels', 'read') && hasPermission('messages', 'read');

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

  // Calculate active tileset
  const activeTileset = temporaryTileset || mapTileset;

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

  // Calculate nodes with position
  const nodesWithPosition = processedNodes.filter(node =>
    node.position &&
    node.position.latitude != null &&
    node.position.longitude != null
  );

  // Calculate center point of all nodes for initial map view
  const getMapCenter = (): [number, number] => {
    if (nodesWithPosition.length === 0) {
      return [25.7617, -80.1918]; // Default to Miami area
    }
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
            onClick={() => setIsNodeListCollapsed(!isNodeListCollapsed)}
            title={isNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
          >
            {isNodeListCollapsed ? '▶' : '◀'}
          </button>
          {!isNodeListCollapsed && (
          <div className="sidebar-header-content">
            <h3>Nodes ({processedNodes.length})</h3>
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
                onClick={() => setShowNodeFilterPopup(!showNodeFilterPopup)}
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
                onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
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
          {shouldShowData() ? (
            processedNodes.length > 0 ? (
              <>
              {processedNodes.map(node => (
                <div
                  key={node.nodeNum}
                  className={`node-item ${selectedNodeId === node.user?.id ? 'selected' : ''}`}
                  onClick={() => {
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
                  }}
                >
                  <div className="node-header">
                    <div className="node-name">
                      <button
                        className="favorite-star"
                        title={node.isFavorite ? "Remove from favorites" : "Add to favorites"}
                        onClick={(e) => toggleFavorite(node, e)}
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
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDMNode(node.user?.id || '');
                            setActiveTab('messages');
                          }}
                        >
                          💬
                        </button>
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
                {nodeFilter ? 'No nodes match filter' : 'No nodes detected'}
              </div>
            )
          ) : (
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
            <div className="map-controls">
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
            </div>
            <MapContainer
              center={getMapCenter()}
              zoom={nodesWithPosition.length > 0 ? 10 : 8}
              style={{ height: '100%', width: '100%' }}
            >
              <MapCenterController
                centerTarget={mapCenterTarget}
                onCenterComplete={handleCenterComplete}
              />
              <TileLayer
                attribution={getTilesetById(activeTileset).attribution}
                url={getTilesetById(activeTileset).url}
                maxZoom={getTilesetById(activeTileset).maxZoom}
              />
              <ZoomHandler onZoomChange={setMapZoom} />
              <MapResizeHandler trigger={showPacketMonitor} />
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

                const markerIcon = createNodeIcon({
                  hops: hops, // 0 (local) = green, 999 (no hops_away data) = grey
                  isSelected,
                  isRouter,
                  shortName: node.user?.shortName,
                  showLabel
                });

                return (
              <Marker
                key={node.nodeNum}
                position={[node.position!.latitude, node.position!.longitude]}
                eventHandlers={{
                  click: () => {
                    setSelectedNodeId(node.user?.id || null);
                    centerMapOnNode(node);
                  }
                }}
                icon={markerIcon}
                ref={(ref) => {
                  if (ref && node.user?.id) {
                    markerRefs.current.set(node.user.id, ref);
                  }
                }}
              >
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
                        onClick={() => {
                          setSelectedDMNode(node.user!.id);
                          setActiveTab('messages');
                        }}
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

              {/* Draw traceroute paths */}
              {traceroutePathsElements}

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
            onTilesetChange={setTemporaryTileset}
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
    </div>
  );
};

export default NodesTab;
