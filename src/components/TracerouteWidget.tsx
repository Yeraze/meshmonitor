/**
 * TracerouteWidget - Dashboard widget for displaying traceroute information
 *
 * Shows the last successful traceroute to and from a selected node
 * with an interactive mini-map visualization
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Polyline, Marker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import api from '../services/api';
import 'leaflet/dist/leaflet.css';

// Component to fit map bounds
const FitBounds: React.FC<{ bounds: [[number, number], [number, number]] }> = ({ bounds }) => {
  const map = useMap();
  
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [map, bounds]);
  
  return null;
};

interface TracerouteData {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards?: string;
  snrBack?: string;
  timestamp: number;
  createdAt?: number;
}

/**
 * Extended NodeInfo with position data for map rendering
 */
interface NodeInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName?: string;
    shortName?: string;
    hwModel?: number;
    role?: number | string;
  };
  position?: {
    latitudeI?: number;
    longitudeI?: number;
    latitude?: number;
    longitude?: number;
  };
  lastHeard?: number;
  hopsAway?: number;
}

interface TracerouteWidgetProps {
  id: string;
  targetNodeId: string | null;
  currentNodeId: string | null;
  nodes: Map<string, NodeInfo>;
  onRemove: () => void;
  onSelectNode: (nodeId: string) => void;
  canEdit?: boolean;
}

const TracerouteWidget: React.FC<TracerouteWidgetProps> = ({
  id,
  targetNodeId,
  currentNodeId,
  nodes,
  onRemove,
  onSelectNode,
  canEdit = true,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showMap, setShowMap] = useState(false); // Map hidden by default
  const searchRef = useRef<HTMLDivElement>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Close search dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearch(false);
      }
    };

    if (showSearch) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSearch]);

  // Fetch all traceroutes using the internal API (not v1 which requires auth)
  const { data: tracerouteData, isLoading } = useQuery<TracerouteData[]>({
    queryKey: ['traceroutes-recent'],
    queryFn: () => api.get('/api/traceroutes/recent'),
    refetchInterval: 60000, // Refresh every minute
    staleTime: 30000,
  });

  // Find traceroute to/from selected node
  const traceroute = useMemo(() => {
    if (!targetNodeId || !tracerouteData) return null;

    // Find traceroutes involving the target node
    const relevantTraceroutes = tracerouteData.filter(
      tr => tr.toNodeId === targetNodeId || tr.fromNodeId === targetNodeId
    );

    if (relevantTraceroutes.length === 0) return null;

    // Get the most recent one
    return relevantTraceroutes.sort((a, b) => {
      const aTime = a.timestamp || a.createdAt || 0;
      const bTime = b.timestamp || b.createdAt || 0;
      return bTime - aTime;
    })[0];
  }, [targetNodeId, tracerouteData]);

  // Filter available nodes for search
  const availableNodes = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return Array.from(nodes.entries())
      .filter(([nodeId, node]) => {
        // Exclude current node
        if (nodeId === currentNodeId) return false;
        // Filter by search query
        const name = (node?.user?.longName || node?.user?.shortName || nodeId).toLowerCase();
        return name.includes(query) || nodeId.toLowerCase().includes(query);
      })
      .map(([nodeId, node]) => ({
        nodeId,
        name: node?.user?.longName || node?.user?.shortName || nodeId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }, [nodes, currentNodeId, searchQuery]);

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      onSelectNode(nodeId);
      setSearchQuery('');
      setShowSearch(false);
    },
    [onSelectNode]
  );

  const getNodeName = useCallback(
    (nodeNum: number): string => {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const node = nodes.get(nodeId);
      return node?.user?.longName || node?.user?.shortName || nodeId;
    },
    [nodes]
  );

  const formatTimestamp = (timestamp: number): string => {
    const ms = timestamp < 946684800000 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    return date.toLocaleString();
  };

  const parseRoute = (routeJson: string, snrJson?: string): { nodeNum: number; snr?: number }[] => {
    try {
      const route = JSON.parse(routeJson);
      const snrs = snrJson ? JSON.parse(snrJson) : [];
      return route.map((nodeNum: number, idx: number) => ({
        nodeNum,
        snr: snrs[idx] !== undefined ? snrs[idx] / 4 : undefined,
      }));
    } catch {
      return [];
    }
  };

  // Get node position by nodeNum
  const getNodePosition = useCallback(
    (nodeNum: number): [number, number] | null => {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const node = nodes.get(nodeId);
      // Check for both formats: latitudeI/longitudeI (integer) or latitude/longitude (float)
      if (node?.position) {
        if (node.position.latitudeI && node.position.longitudeI) {
          return [node.position.latitudeI / 1e7, node.position.longitudeI / 1e7];
        }
        if (node.position.latitude && node.position.longitude) {
          return [node.position.latitude, node.position.longitude];
        }
      }
      return null;
    },
    [nodes]
  );

  // Build map data for visualization
  const mapData = useMemo(() => {
    if (!traceroute) return null;

    // Parse routes
    const forwardHops = traceroute.route && traceroute.route !== 'null' && traceroute.route !== ''
      ? parseRoute(traceroute.route, traceroute.snrTowards)
      : [];
    const backHops = traceroute.routeBack && traceroute.routeBack !== 'null' && traceroute.routeBack !== ''
      ? parseRoute(traceroute.routeBack, traceroute.snrBack)
      : [];

    // Build complete forward path: from -> hops -> to
    const forwardPath = [
      traceroute.fromNodeNum,
      ...forwardHops.map(h => h.nodeNum),
      traceroute.toNodeNum,
    ];

    // Build complete back path: to -> hops -> from
    const backPath = [
      traceroute.toNodeNum,
      ...backHops.map(h => h.nodeNum),
      traceroute.fromNodeNum,
    ];

    // Collect unique nodes with positions
    const uniqueNodes = new Map<number, { nodeNum: number; position: [number, number]; name: string }>();
    [...forwardPath, ...backPath].forEach(nodeNum => {
      if (!uniqueNodes.has(nodeNum)) {
        const pos = getNodePosition(nodeNum);
        if (pos) {
          uniqueNodes.set(nodeNum, {
            nodeNum,
            position: pos,
            name: getNodeName(nodeNum),
          });
        }
      }
    });

    // Build path positions for forward route
    const forwardPositions: [number, number][] = [];
    forwardPath.forEach(nodeNum => {
      const node = uniqueNodes.get(nodeNum);
      if (node) {
        forwardPositions.push(node.position);
      }
    });

    // Build path positions for back route
    const backPositions: [number, number][] = [];
    backPath.forEach(nodeNum => {
      const node = uniqueNodes.get(nodeNum);
      if (node) {
        backPositions.push(node.position);
      }
    });

    // Calculate bounds if we have positions
    if (uniqueNodes.size < 2) return null;

    const allPositions = Array.from(uniqueNodes.values()).map(n => n.position);
    const lats = allPositions.map(p => p[0]);
    const lngs = allPositions.map(p => p[1]);
    
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lats) - 0.01, Math.min(...lngs) - 0.01],
      [Math.max(...lats) + 0.01, Math.max(...lngs) + 0.01],
    ];

    return {
      nodes: Array.from(uniqueNodes.values()),
      forwardPositions,
      backPositions,
      bounds,
      fromNodeNum: traceroute.fromNodeNum,
      toNodeNum: traceroute.toNodeNum,
    };
  }, [traceroute, getNodePosition, getNodeName]);

  // Create arrow icon for direction indicators
  const createArrowIcon = useCallback((angle: number, color: string) => {
    return L.divIcon({
      html: `<div style="transform: rotate(${angle}deg); font-size: 14px; line-height: 1;">
        <span style="color: ${color}; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;">▲</span>
      </div>`,
      className: 'traceroute-arrow-icon',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }, []);

  // Generate arrow markers along a path
  const generatePathArrows = useCallback(
    (positions: [number, number][], pathKey: string, color: string): React.ReactElement[] => {
      const arrows: React.ReactElement[] = [];

      for (let i = 0; i < positions.length - 1; i++) {
        const start = positions[i];
        const end = positions[i + 1];

        // Calculate midpoint
        const midLat = (start[0] + end[0]) / 2;
        const midLng = (start[1] + end[1]) / 2;

        // Calculate angle
        const latDiff = end[0] - start[0];
        const lngDiff = end[1] - start[1];
        const angle = Math.atan2(lngDiff, latDiff) * (180 / Math.PI);

        arrows.push(
          <Marker
            key={`${pathKey}-arrow-${i}`}
            position={[midLat, midLng]}
            icon={createArrowIcon(angle, color)}
          />
        );
      }

      return arrows;
    },
    [createArrowIcon]
  );

  // Create node marker icon
  const createNodeIcon = useCallback((isEndpoint: boolean, isFrom: boolean, isTo: boolean) => {
    let color = '#888'; // intermediate hop
    if (isFrom) color = '#4CAF50'; // green for source
    else if (isTo) color = '#2196F3'; // blue for destination

    const size = isEndpoint ? 12 : 8;

    return L.divIcon({
      html: `<div style="
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 0 4px rgba(0,0,0,0.5);
      "></div>`,
      className: 'traceroute-node-icon',
      iconSize: [size + 4, size + 4],
      iconAnchor: [(size + 4) / 2, (size + 4) / 2],
    });
  }, []);

  const renderRoute = (
    label: string,
    fromNum: number,
    toNum: number,
    routeJson: string | null,
    snrJson?: string
  ): React.ReactNode => {
    if (!routeJson || routeJson === 'null' || routeJson === '') {
      return (
        <div className="traceroute-path-section">
          <div className="traceroute-path-label">{label}</div>
          <div className="traceroute-no-data">No route data available</div>
        </div>
      );
    }

    const hops = parseRoute(routeJson, snrJson);
    const fullPath = [
      { nodeNum: fromNum, snr: undefined },
      ...hops,
      { nodeNum: toNum, snr: hops.length > 0 ? hops[hops.length - 1]?.snr : undefined },
    ];

    return (
      <div className="traceroute-path-section">
        <div className="traceroute-path-label">{label}</div>
        <div className="traceroute-path">
          {fullPath.map((hop, idx) => {
            const hasPosition = getNodePosition(hop.nodeNum) !== null;
            return (
              <React.Fragment key={`${hop.nodeNum}-${idx}`}>
                <span className={`traceroute-hop ${!hasPosition ? 'no-position' : ''}`} title={!hasPosition ? 'No position data' : undefined}>
                  {getNodeName(hop.nodeNum)}
                  {!hasPosition && <span className="traceroute-no-pos-icon" title="No position data">📍</span>}
                  {hop.snr !== undefined && <span className="traceroute-snr">{hop.snr.toFixed(1)} dB</span>}
                </span>
                {idx < fullPath.length - 1 && <span className="traceroute-arrow">→</span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  };

  const targetNodeName = targetNodeId ? nodes.get(targetNodeId)?.user?.longName || nodes.get(targetNodeId)?.user?.shortName || targetNodeId : null;

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container traceroute-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">
          Traceroute{targetNodeName ? `: ${targetNodeName}` : ''}
        </h3>
        <button className="dashboard-remove-btn" onClick={onRemove} title="Remove widget">
          ×
        </button>
      </div>

      <div className="traceroute-content">
        {/* Node selection - only show if user can edit */}
        {canEdit && (
          <div className="traceroute-select-section" ref={searchRef}>
            <div className="traceroute-search-container">
              <input
                type="text"
                className="traceroute-search"
                placeholder={targetNodeId ? 'Change node...' : 'Select a node...'}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => setShowSearch(true)}
              />
              {showSearch && availableNodes.length > 0 && (
                <div className="traceroute-search-dropdown">
                  {availableNodes.map(node => (
                    <div
                      key={node.nodeId}
                      className="traceroute-search-item"
                      onClick={() => handleSelectNode(node.nodeId)}
                    >
                      {node.name}
                      <span className="traceroute-search-id">{node.nodeId}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Traceroute display */}
        {!targetNodeId ? (
          <div className="traceroute-empty">
            {canEdit ? 'Select a node above to view traceroute information.' : 'No node configured.'}
          </div>
        ) : isLoading ? (
          <div className="traceroute-loading">Loading traceroute data...</div>
        ) : !traceroute ? (
          <div className="traceroute-no-data">No traceroute data available for this node.</div>
        ) : (
          <div className="traceroute-details">
            <div className="traceroute-header-row">
              <div className="traceroute-timestamp">
                Last: {formatTimestamp(traceroute.timestamp || traceroute.createdAt || 0)}
              </div>
              {mapData && mapData.nodes.length >= 2 && (
                <button 
                  className="traceroute-map-toggle-inline"
                  onClick={() => setShowMap(!showMap)}
                  title={showMap ? 'Hide map' : 'Show map'}
                >
                  {showMap ? '📝 Text' : '🗺️ Map'}
                  {mapData.nodes.length < (mapData.forwardPositions.length + mapData.backPositions.length) / 2 && (
                    <span className="traceroute-map-warning" title="Some nodes have no position data">⚠️</span>
                  )}
                </button>
              )}
            </div>

            {/* Mini Map */}
            {mapData && mapData.nodes.length >= 2 && showMap && (
              <div className="traceroute-map-section">
                <div className="traceroute-map-container">
                  <MapContainer
                    center={[mapData.bounds[0][0], mapData.bounds[0][1]]}
                    zoom={10}
                    style={{ height: '200px', width: '100%', borderRadius: '8px' }}
                      scrollWheelZoom={false}
                      dragging={true}
                      zoomControl={true}
                      attributionControl={false}
                    >
                      <FitBounds bounds={mapData.bounds} />
                      <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      />

                      {/* Forward path (green/teal) */}
                      {mapData.forwardPositions.length >= 2 && (
                        <>
                          <Polyline
                            positions={mapData.forwardPositions}
                            color="#4CAF50"
                            weight={3}
                            opacity={0.8}
                            dashArray="5, 10"
                          />
                          {generatePathArrows(mapData.forwardPositions, 'forward', '#4CAF50')}
                        </>
                      )}

                      {/* Back path (blue) - offset slightly for visibility */}
                      {mapData.backPositions.length >= 2 && (
                        <>
                          <Polyline
                            positions={mapData.backPositions}
                            color="#2196F3"
                            weight={3}
                            opacity={0.8}
                            dashArray="5, 10"
                          />
                          {generatePathArrows(mapData.backPositions, 'back', '#2196F3')}
                        </>
                      )}

                      {/* Node markers */}
                      {mapData.nodes.map(node => (
                        <Marker
                          key={node.nodeNum}
                          position={node.position}
                          icon={createNodeIcon(
                            node.nodeNum === mapData.fromNodeNum || node.nodeNum === mapData.toNodeNum,
                            node.nodeNum === mapData.fromNodeNum,
                            node.nodeNum === mapData.toNodeNum
                          )}
                        >
                          <Tooltip permanent={false} direction="top" offset={[0, -5]}>
                            {node.name}
                          </Tooltip>
                        </Marker>
                      ))}
                    </MapContainer>
                    <div className="traceroute-map-legend">
                      <span className="legend-item"><span className="legend-color" style={{ background: '#4CAF50' }}></span> Forward</span>
                      <span className="legend-item"><span className="legend-color" style={{ background: '#2196F3' }}></span> Return</span>
                    </div>
                  </div>
              </div>
            )}

            {/* Show text routes only when map is hidden */}
            {!showMap && (
              <>
                {renderRoute(
                  'Forward Path:',
                  traceroute.fromNodeNum,
                  traceroute.toNodeNum,
                  traceroute.route,
                  traceroute.snrTowards
                )}

                {renderRoute(
                  'Return Path:',
                  traceroute.toNodeNum,
                  traceroute.fromNodeNum,
                  traceroute.routeBack,
                  traceroute.snrBack
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TracerouteWidget;
