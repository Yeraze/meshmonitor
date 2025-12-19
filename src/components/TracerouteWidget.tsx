/**
 * TracerouteWidget - Dashboard widget for displaying traceroute information
 *
 * Shows the last successful traceroute to and from a selected node
 * with an interactive mini-map visualization
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MapContainer, TileLayer, Polyline, Marker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useSettings } from '../contexts/SettingsContext';
import { getTilesetById } from '../config/tilesets';
import { useTraceroutes } from '../hooks/useTraceroutes';
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

// TracerouteData interface removed - now using PollTraceroute from useTraceroutes hook

import type { MapNodeInfo } from '../types/device';

/**
 * Extended NodeInfo with position data for map rendering
 * Re-exported for backward compatibility
 */
type NodeInfo = MapNodeInfo;

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
  const { t } = useTranslation();
  const { mapTileset, customTilesets } = useSettings();
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showMap, setShowMap] = useState(false); // Map hidden by default
  const [highlightedPath, setHighlightedPath] = useState<'forward' | 'back' | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // Get tileset configuration
  const tileset = getTilesetById(mapTileset, customTilesets);

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

  // Get traceroutes from centralized hook (synced via poll mechanism for consistency)
  const { traceroutes: tracerouteData, isLoading } = useTraceroutes();

  // Find traceroute to/from selected node
  // Data is already sorted by timestamp DESC from the poll endpoint
  const traceroute = useMemo(() => {
    if (!targetNodeId || !tracerouteData || tracerouteData.length === 0) return null;

    // Find the first (most recent) traceroute involving the target node
    // Since data is pre-sorted by timestamp DESC, the first match is the most recent
    return tracerouteData.find(
      tr => tr.toNodeId === targetNodeId || tr.fromNodeId === targetNodeId
    ) || null;
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

  // Filter function to remove invalid/reserved node numbers from route arrays
  const isValidRouteNode = (nodeNum: number): boolean => {
    const BROADCAST_ADDR = 4294967295;
    if (nodeNum <= 3) return false;  // Reserved
    if (nodeNum === 255) return false;  // 0xff reserved
    if (nodeNum === 65535) return false;  // 0xffff invalid placeholder
    if (nodeNum === BROADCAST_ADDR) return false;  // Broadcast
    return true;
  };

  const parseRoute = (routeJson: string, snrJson?: string): { nodeNum: number; snr?: number }[] => {
    try {
      const route = JSON.parse(routeJson);
      const snrs = snrJson ? JSON.parse(snrJson) : [];
      // Filter out invalid node numbers and keep corresponding SNRs in sync
      const result: { nodeNum: number; snr?: number }[] = [];
      route.forEach((nodeNum: number, idx: number) => {
        if (isValidRouteNode(nodeNum)) {
          result.push({
            nodeNum,
            snr: snrs[idx] !== undefined ? snrs[idx] / 4 : undefined,
          });
        }
      });
      return result;
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
    const forwardHops =
      traceroute.route && traceroute.route !== 'null' && traceroute.route !== ''
        ? parseRoute(traceroute.route, traceroute.snrTowards)
        : [];
    const backHops =
      traceroute.routeBack && traceroute.routeBack !== 'null' && traceroute.routeBack !== ''
        ? parseRoute(traceroute.routeBack, traceroute.snrBack)
        : [];

    // Build complete forward path: from -> hops -> to (with SNR for each segment)
    const forwardPath = [traceroute.fromNodeNum, ...forwardHops.map(h => h.nodeNum), traceroute.toNodeNum];
    const forwardSnrs = forwardHops.map(h => h.snr);

    // Build complete back path: to -> hops -> from (with SNR for each segment)
    const backPath = [traceroute.toNodeNum, ...backHops.map(h => h.nodeNum), traceroute.fromNodeNum];
    const backSnrs = backHops.map(h => h.snr);

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

    // Build path positions for forward route with SNR for each segment
    const forwardPositions: [number, number][] = [];
    const forwardSegmentSnrs: (number | undefined)[] = [];
    forwardPath.forEach((nodeNum, idx) => {
      const node = uniqueNodes.get(nodeNum);
      if (node) {
        forwardPositions.push(node.position);
        // SNR is for the segment arriving at this hop (index - 1)
        // For direct routes (no hops), we still need one undefined SNR for the single segment
        if (idx > 0) {
          forwardSegmentSnrs.push(idx <= forwardSnrs.length ? forwardSnrs[idx - 1] : undefined);
        }
      }
    });

    // Build path positions for back route with SNR for each segment
    const backPositions: [number, number][] = [];
    const backSegmentSnrs: (number | undefined)[] = [];
    backPath.forEach((nodeNum, idx) => {
      const node = uniqueNodes.get(nodeNum);
      if (node) {
        backPositions.push(node.position);
        // SNR is for the segment arriving at this hop
        // For direct routes (no hops), we still need one undefined SNR for the single segment
        if (idx > 0) {
          backSegmentSnrs.push(idx <= backSnrs.length ? backSnrs[idx - 1] : undefined);
        }
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
      forwardSegmentSnrs,
      backSegmentSnrs,
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

  // Generate curved path between two points (quadratic bezier approximation)
  // curvature: positive = curve to the "left" side (relative to direction), negative = curve to "right"
  // To ensure forward and back paths curve in opposite directions consistently,
  // we normalize direction based on comparing start/end coordinates
  const generateCurvedPath = useCallback(
    (
      start: [number, number],
      end: [number, number],
      curvature: number = 0.15,
      segments: number = 20,
      normalizeDirection: boolean = false
    ): [number, number][] => {
      const points: [number, number][] = [];

      // If normalizeDirection is true, we ensure the curvature is consistent
      // regardless of which direction we're traveling
      let effectiveCurvature = curvature;
      if (normalizeDirection) {
        // Always curve based on "canonical" direction (lower lat/lng to higher)
        // This ensures forward A->B and back B->A curve on opposite sides
        const shouldFlip = start[0] > end[0] || (start[0] === end[0] && start[1] > end[1]);
        if (shouldFlip) {
          effectiveCurvature = -curvature;
        }
      }

      // Calculate perpendicular offset for control point
      const midLat = (start[0] + end[0]) / 2;
      const midLng = (start[1] + end[1]) / 2;

      // Vector from start to end
      const dx = end[1] - start[1];
      const dy = end[0] - start[0];
      const length = Math.sqrt(dx * dx + dy * dy);

      if (length === 0) return [start, end];

      // Perpendicular vector (normalized) * curvature * length
      const perpLat = (-dx / length) * effectiveCurvature * length;
      const perpLng = (dy / length) * effectiveCurvature * length;

      // Control point
      const ctrlLat = midLat + perpLat;
      const ctrlLng = midLng + perpLng;

      // Generate points along quadratic bezier curve
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const t1 = 1 - t;

        // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
        const lat = t1 * t1 * start[0] + 2 * t1 * t * ctrlLat + t * t * end[0];
        const lng = t1 * t1 * start[1] + 2 * t1 * t * ctrlLng + t * t * end[1];

        points.push([lat, lng]);
      }

      return points;
    },
    []
  );

  // Calculate line weight based on SNR (-20 to +10 dB range typically)
  const getLineWeight = useCallback((snr: number | undefined): number => {
    if (snr === undefined) return 3; // default
    // Map SNR from -20..+10 to weight 2..6
    const normalized = Math.max(-20, Math.min(10, snr));
    return 2 + ((normalized + 20) / 30) * 4;
  }, []);

  // Generate arrow markers along a curved path with SNR tooltips
  const generatePathArrows = useCallback(
    (
      positions: [number, number][],
      pathKey: string,
      color: string,
      snrs: (number | undefined)[],
      curvature: number,
      normalizeDirection: boolean = true
    ): React.ReactElement[] => {
      const arrows: React.ReactElement[] = [];

      for (let i = 0; i < positions.length - 1; i++) {
        const start = positions[i];
        const end = positions[i + 1];
        const snr = snrs[i];

        // Generate the curved path to find the midpoint on the curve
        const curvedPath = generateCurvedPath(start, end, curvature, 20, normalizeDirection);
        const midIdx = Math.floor(curvedPath.length / 2);
        const midPoint = curvedPath[midIdx];

        // Calculate tangent angle at midpoint using adjacent points
        const prevPoint = curvedPath[midIdx - 1] || curvedPath[midIdx];
        const nextPoint = curvedPath[midIdx + 1] || curvedPath[midIdx];
        const latDiff = nextPoint[0] - prevPoint[0];
        const lngDiff = nextPoint[1] - prevPoint[1];
        const angle = Math.atan2(lngDiff, latDiff) * (180 / Math.PI);

        arrows.push(
          <Marker key={`${pathKey}-arrow-${i}`} position={midPoint} icon={createArrowIcon(angle, color)}>
            {snr !== undefined && (
              <Tooltip permanent={false} direction="top" offset={[0, -10]}>
                {snr.toFixed(1)} dB
              </Tooltip>
            )}
          </Marker>
        );
      }

      return arrows;
    },
    [createArrowIcon, generateCurvedPath]
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
          <div className="traceroute-no-data">{t('dashboard.widget.traceroute.no_route_data')}</div>
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
                <span
                  className={`traceroute-hop ${!hasPosition ? 'no-position' : ''}`}
                  title={!hasPosition ? 'No position data' : undefined}
                >
                  {getNodeName(hop.nodeNum)}
                  {!hasPosition && (
                    <span className="traceroute-no-pos-icon" title="No position data">
                      📍
                    </span>
                  )}
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

  const targetNodeName = targetNodeId
    ? nodes.get(targetNodeId)?.user?.longName || nodes.get(targetNodeId)?.user?.shortName || targetNodeId
    : null;

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container traceroute-widget">
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <h3 className="dashboard-chart-title">
          {t('dashboard.widget.traceroute.title')}
          {targetNodeName ? `: ${targetNodeName}` : ''}
        </h3>
        <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')}>
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
                placeholder={
                  targetNodeId
                    ? t('dashboard.widget.traceroute.change_node')
                    : t('dashboard.widget.traceroute.select_node')
                }
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
            {canEdit ? t('dashboard.widget.traceroute.empty_editable') : t('dashboard.widget.traceroute.empty')}
          </div>
        ) : isLoading ? (
          <div className="traceroute-loading">{t('dashboard.widget.traceroute.loading')}</div>
        ) : !traceroute ? (
          <div className="traceroute-no-data">{t('dashboard.widget.traceroute.no_data')}</div>
        ) : (
          <div className="traceroute-details">
            <div className="traceroute-header-row">
              <div className="traceroute-timestamp">
                {t('dashboard.widget.traceroute.last_traceroute')}:{' '}
                {formatTimestamp(traceroute.timestamp || traceroute.createdAt || 0)}
              </div>
              {mapData && mapData.nodes.length >= 2 && (
                <button
                  className="traceroute-map-toggle-inline"
                  onClick={() => setShowMap(!showMap)}
                  title={
                    showMap ? t('dashboard.widget.traceroute.hide_map') : t('dashboard.widget.traceroute.show_map')
                  }
                >
                  {showMap ? t('dashboard.widget.traceroute.hide_map') : t('dashboard.widget.traceroute.show_map')}
                  {mapData.nodes.length < (mapData.forwardPositions.length + mapData.backPositions.length) / 2 && (
                    <span
                      className="traceroute-map-warning"
                      title={t('dashboard.widget.traceroute.no_position_warning')}
                    >
                      ⚠️
                    </span>
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
                      url={tileset.url}
                      attribution={tileset.attribution}
                      maxZoom={tileset.maxZoom}
                    />

                    {/* Forward path (green) - render curved segments with variable weight based on SNR */}
                    {mapData.forwardPositions.length >= 2 && (
                      <>
                        {mapData.forwardPositions.slice(0, -1).map((pos, idx) => {
                          const nextPos = mapData.forwardPositions[idx + 1];
                          const snr = mapData.forwardSegmentSnrs[idx];
                          const weight = getLineWeight(snr);
                          const isHighlighted = highlightedPath === null || highlightedPath === 'forward';
                          const curvedPath = generateCurvedPath(pos, nextPos, 0.2, 20, true);
                          return (
                            <Polyline
                              key={`forward-segment-${idx}`}
                              positions={curvedPath}
                              color="#4CAF50"
                              weight={weight}
                              opacity={isHighlighted ? 0.9 : 0.2}
                              dashArray={snr === undefined ? '5, 10' : undefined}
                            />
                          );
                        })}
                        {(highlightedPath === null || highlightedPath === 'forward') &&
                          generatePathArrows(
                            mapData.forwardPositions,
                            'forward',
                            '#4CAF50',
                            mapData.forwardSegmentSnrs,
                            0.2,
                            true
                          )}
                      </>
                    )}

                    {/* Back path (blue) - render curved segments (opposite side) with variable weight based on SNR */}
                    {mapData.backPositions.length >= 2 && (
                      <>
                        {mapData.backPositions.slice(0, -1).map((pos, idx) => {
                          const nextPos = mapData.backPositions[idx + 1];
                          const snr = mapData.backSegmentSnrs[idx];
                          const weight = getLineWeight(snr);
                          const isHighlighted = highlightedPath === null || highlightedPath === 'back';
                          const curvedPath = generateCurvedPath(pos, nextPos, -0.2, 20, true);
                          return (
                            <Polyline
                              key={`back-segment-${idx}`}
                              positions={curvedPath}
                              color="#2196F3"
                              weight={weight}
                              opacity={isHighlighted ? 0.9 : 0.2}
                              dashArray={snr === undefined ? '5, 10' : undefined}
                            />
                          );
                        })}
                        {(highlightedPath === null || highlightedPath === 'back') &&
                          generatePathArrows(
                            mapData.backPositions,
                            'back',
                            '#2196F3',
                            mapData.backSegmentSnrs,
                            -0.2,
                            true
                          )}
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
                    <span
                      className={`legend-item ${highlightedPath === 'forward' ? 'highlighted' : ''}`}
                      onMouseEnter={() => setHighlightedPath('forward')}
                      onMouseLeave={() => setHighlightedPath(null)}
                    >
                      <span className="legend-color" style={{ background: '#4CAF50' }}></span>{' '}
                      {t('dashboard.widget.traceroute.forward_path')}
                    </span>
                    <span
                      className={`legend-item ${highlightedPath === 'back' ? 'highlighted' : ''}`}
                      onMouseEnter={() => setHighlightedPath('back')}
                      onMouseLeave={() => setHighlightedPath(null)}
                    >
                      <span className="legend-color" style={{ background: '#2196F3' }}></span>{' '}
                      {t('dashboard.widget.traceroute.return_path')}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Show text routes only when map is hidden */}
            {!showMap && (
              <>
                {renderRoute(
                  `${t('dashboard.widget.traceroute.forward_path')}:`,
                  traceroute.fromNodeNum,
                  traceroute.toNodeNum,
                  traceroute.route,
                  traceroute.snrTowards
                )}

                {renderRoute(
                  `${t('dashboard.widget.traceroute.return_path')}:`,
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
