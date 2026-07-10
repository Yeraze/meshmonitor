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
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from 'react-leaflet';
import { useSettings } from '../contexts/SettingsContext';
import { getTilesetById } from '../config/tilesets';
import { useTraceroutes } from '../hooks/useTraceroutes';
import { isUnknownSnr, tracerouteSegmentWeight } from '../utils/mapHelpers';
import { TraceroutePathsLayer } from './map/layers/TraceroutePathsLayer';
import { createTracerouteEndpointIcon } from './map/markerIcons';
import {
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  buildLiveNodePositionMap,
  hasReturnPath,
  decomposeTraceroute,
  type TracerouteRenderSegment,
} from '../utils/tracerouteSegments';
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

/** Stable empty snapshot map — default for `getNodePosition`'s live-only callers (e.g. the text route view). */
const EMPTY_SNAPSHOT: Map<number, [number, number]> = new Map();

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
  const { mapTileset, customTilesets, overlayColors } = useSettings();
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
      // BROADCAST_ADDR (0xffffffff) is a firmware placeholder for a relay-role
      // hop that refused to self-identify — render as "Unknown".
      if (nodeNum === 4294967295) return 'Unknown';
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

  // Filter function to remove invalid/reserved node numbers from route arrays.
  // BROADCAST_ADDR (0xffffffff) is kept — it's the firmware placeholder for a
  // relay-role hop that refused to self-identify and is rendered as "Unknown".
  const isValidRouteNode = (nodeNum: number): boolean => {
    if (nodeNum <= 3) return false;  // Reserved
    if (nodeNum === 255) return false;  // 0xff reserved
    if (nodeNum === 65535) return false;  // 0xffff invalid placeholder
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

  // Live node positions, keyed by nodeNum, normalized to [lat, lng] via the
  // shared `buildLiveNodePositionMap` — the widget's own live-node shape
  // carries position as EITHER `latitudeI/longitudeI` (integer) OR
  // `latitude/longitude` (float); the integer form is preferred when present.
  const liveNodePositions = useMemo(
    () =>
      buildLiveNodePositionMap(nodes.values(), (node) => {
        if (typeof node.nodeNum !== 'number' || !node.position) return null;
        if (node.position.latitudeI && node.position.longitudeI) {
          return { nodeNum: node.nodeNum, lat: node.position.latitudeI / 1e7, lng: node.position.longitudeI / 1e7 };
        }
        return { nodeNum: node.nodeNum, lat: node.position.latitude, lng: node.position.longitude };
      }),
    [nodes],
  );

  // Get node position by nodeNum, optionally preferring a snapshot map
  // (#1862 — resolveSegmentPosition prefers `snapshot` over `liveNodePositions`).
  const getNodePosition = useCallback(
    (nodeNum: number, snapshotPositions?: Map<number, [number, number]>): [number, number] | null =>
      resolveSegmentPosition(nodeNum, snapshotPositions ?? EMPTY_SNAPSHOT, liveNodePositions),
    [liveNodePositions]
  );

  // Build map data for visualization
  const mapData = useMemo(() => {
    if (!traceroute) return null;

    // Parse snapshot positions (#1862) via the shared util — prefers historical
    // positions over current. Uses a `typeof`-based presence check (fixes a
    // truthy-check bug that silently dropped snapshots at exactly lat/lng 0).
    const snapshotPositions = parseSnapshotRoutePositions(traceroute.routePositions);

    // Parse routes (filters reserved/invalid node numbers; keeps BROADCAST_ADDR
    // as a renderable "Unknown" hop for the text route view below).
    const forwardHops =
      traceroute.route && traceroute.route !== 'null' && traceroute.route !== ''
        ? parseRoute(traceroute.route, traceroute.snrTowards)
        : [];
    const backHops =
      traceroute.routeBack && traceroute.routeBack !== 'null' && traceroute.routeBack !== ''
        ? parseRoute(traceroute.routeBack, traceroute.snrBack)
        : [];

    // #2051 — delegate the empty-routeBack guard to the shared util instead
    // of a local re-implementation.
    const hasReturn = hasReturnPath(backHops.map(h => h.nodeNum), traceroute.snrBack);

    // Build complete forward path: from -> hops -> to
    const forwardPath = [traceroute.fromNodeNum, ...forwardHops.map(h => h.nodeNum), traceroute.toNodeNum];

    // Build complete back path only if we have actual return data
    const backPath = hasReturn
      ? [traceroute.toNodeNum, ...backHops.map(h => h.nodeNum), traceroute.fromNodeNum]
      : [];

    // Collect unique nodes with positions (prefer snapshot positions) — feeds
    // the from/to/intermediate-hop MARKERS below (marker icon styling is
    // Phase 4 scope; untouched here beyond the snapshot-resolution fix above).
    const uniqueNodes = new Map<number, { nodeNum: number; position: [number, number]; name: string }>();
    [...forwardPath, ...backPath].forEach(nodeNum => {
      if (!uniqueNodes.has(nodeNum)) {
        const pos = getNodePosition(nodeNum, snapshotPositions);
        if (pos) {
          uniqueNodes.set(nodeNum, {
            nodeNum,
            position: pos,
            name: getNodeName(nodeNum),
          });
        }
      }
    });

    // Path-entry position counts (including duplicate hops), used only for
    // the "missing position" warning-icon heuristic below — NOT for drawing
    // (drawing now goes through `segments`/`decomposeTraceroute`).
    const forwardPositions: [number, number][] = forwardPath
      .map(nodeNum => uniqueNodes.get(nodeNum)?.position)
      .filter((p): p is [number, number] => p !== undefined);
    const backPositions: [number, number][] = backPath
      .map(nodeNum => uniqueNodes.get(nodeNum)?.position)
      .filter((p): p is [number, number] => p !== undefined);

    // Calculate bounds if we have positions
    if (uniqueNodes.size < 2) return null;

    const allPositions = Array.from(uniqueNodes.values()).map(n => n.position);
    const lats = allPositions.map(p => p[0]);
    const lngs = allPositions.map(p => p[1]);

    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lats) - 0.01, Math.min(...lngs) - 0.01],
      [Math.max(...lats) + 0.01, Math.max(...lngs) + 0.01],
    ];

    // Forward + return render segments via the shared decomposition util —
    // replaces the widget's own curved-path/dash/color construction.
    // Internally /4-scales SNR, applies the #2931 sentinel, and re-derives
    // the same #2051 return-leg gate as `hasReturn` above.
    const segments: TracerouteRenderSegment[] = decomposeTraceroute(
      {
        fromNodeNum: traceroute.fromNodeNum,
        toNodeNum: traceroute.toNodeNum,
        route: traceroute.route,
        routeBack: traceroute.routeBack,
        snrTowards: traceroute.snrTowards,
        snrBack: traceroute.snrBack,
        timestamp: traceroute.timestamp,
        createdAt: traceroute.createdAt,
      },
      { resolvePosition: (n) => resolveSegmentPosition(n, snapshotPositions, liveNodePositions) },
    );

    return {
      nodes: Array.from(uniqueNodes.values()),
      forwardPositions,
      backPositions,
      segments,
      bounds,
      fromNodeNum: traceroute.fromNodeNum,
      toNodeNum: traceroute.toNodeNum,
    };
  }, [traceroute, getNodePosition, getNodeName, liveNodePositions]);



  // Endpoint/hop marker icon — from/to colors are a deliberate endpoint-
  // identity encoding (green = source, blue = destination, gray = hop),
  // intentionally distinct from the theme leg colors above (which encode
  // travel direction, not endpoint role). See createTracerouteEndpointIcon's
  // doc block in map/markerIcons.ts (#4047 Phase 4, D3 Option A).
  const getNodeMarkerIcon = useCallback((isFrom: boolean, isTo: boolean) => {
    const role: 'from' | 'to' | 'hop' = isFrom ? 'from' : isTo ? 'to' : 'hop';
    return createTracerouteEndpointIcon(role);
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
                  {hop.snr !== undefined && <span className="traceroute-snr" title={isUnknownSnr(hop.snr) ? 'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)' : undefined}>{isUnknownSnr(hop.snr) ? '?' : `${hop.snr.toFixed(1)} dB`}</span>}
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
        <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')} aria-label={t('dashboard.remove_widget')}>
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

                    {/* Forward + return legs — shared render layer. Leg
                        colors read the theme tracerouteForward/
                        tracerouteReturn tokens (legend swatches below use the
                        same tokens, so they stay truthful). Hover-highlight
                        (dim 0.9/0.2, arrows limited to the highlighted leg)
                        is preserved via the `highlight` prop. */}
                    <TraceroutePathsLayer
                      segments={mapData.segments}
                      snrColors={overlayColors.snrColors}
                      colorMode="fixed-leg"
                      legColors={{ forward: overlayColors.tracerouteForward, return: overlayColors.tracerouteReturn }}
                      curvature={0.2}
                      weight={tracerouteSegmentWeight}
                      opacity={0.9}
                      dashMode="mqtt-unknown"
                      showArrows
                      highlight={{
                        group: highlightedPath === 'back' ? 'return' : highlightedPath,
                        dimmedOpacity: 0.2,
                      }}
                    />

                    {/* Node markers */}
                    {mapData.nodes.map(node => (
                      <Marker
                        key={node.nodeNum}
                        position={node.position}
                        icon={getNodeMarkerIcon(
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
                      <span className="legend-color" style={{ background: overlayColors.tracerouteForward }}></span>{' '}
                      {t('dashboard.widget.traceroute.forward_path')}
                    </span>
                    <span
                      className={`legend-item ${highlightedPath === 'back' ? 'highlighted' : ''}`}
                      onMouseEnter={() => setHighlightedPath('back')}
                      onMouseLeave={() => setHighlightedPath(null)}
                    >
                      <span className="legend-color" style={{ background: overlayColors.tracerouteReturn }}></span>{' '}
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
