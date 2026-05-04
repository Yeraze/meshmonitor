/**
 * Hook for rendering traceroute paths on the map
 *
 * This hook encapsulates all the logic for:
 * - Computing and memoizing base traceroute path segments
 * - Computing selected node traceroute visualization
 * - Rendering Polyline elements with popups showing SNR stats and charts
 *
 * Migration Note: This hook replaces the traceroutePathsElements and
 * selectedNodeTraceroute useMemo blocks in App.tsx.
 */

import React, { useMemo, useState } from 'react';
import { Popup, Polyline } from 'react-leaflet';
import { DraggablePopup } from '../components/DraggablePopup';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { calculateDistance, formatDistance } from '../utils/distance';
import { generateCurvedArrowMarkers, generateCurvedPath, getLineWeight, getSegmentSnrColor, getSegmentSnrOpacity, getTemporalOpacityMultiplier, isUnknownSnr } from '../utils/mapHelpers';
import { logger } from '../utils/logger';
import type { DistanceUnit } from '../contexts/SettingsContext';

/** Small component for route segment SNR chart with time-of-day / chronological toggle */
function SegmentSnrChart({ chartData }: {
  chartData: Array<{ timeDecimal: number; timeLabel: string; snr: number; fullTimestamp: number }>;
}) {
  const [mode, setMode] = useState<'timeOfDay' | 'chronological'>('timeOfDay');

  const chronoData = useMemo(() =>
    [...chartData].sort((a, b) => a.fullTimestamp - b.fullTimestamp).map(d => {
      const date = new Date(d.fullTimestamp);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return { ...d, chronoLabel: `${month}/${day} ${hours}:${minutes}`, chronoTime: d.fullTimestamp };
    }), [chartData]);

  return (
    <div className="snr-timeline-chart">
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
        <button
          className={`node-popup-tab ${mode === 'timeOfDay' ? 'active' : ''}`}
          style={{ fontSize: '10px', padding: '2px 8px', border: '1px solid var(--ctp-surface2)', borderRadius: '4px', cursor: 'pointer', background: mode === 'timeOfDay' ? 'var(--ctp-blue)' : 'var(--ctp-surface0)', color: mode === 'timeOfDay' ? 'var(--ctp-base)' : 'var(--ctp-subtext1)' }}
          onClick={e => { e.stopPropagation(); setMode('timeOfDay'); }}
        >
          Time of Day
        </button>
        <button
          className={`node-popup-tab ${mode === 'chronological' ? 'active' : ''}`}
          style={{ fontSize: '10px', padding: '2px 8px', border: '1px solid var(--ctp-surface2)', borderRadius: '4px', cursor: 'pointer', background: mode === 'chronological' ? 'var(--ctp-blue)' : 'var(--ctp-surface0)', color: mode === 'chronological' ? 'var(--ctp-base)' : 'var(--ctp-subtext1)' }}
          onClick={e => { e.stopPropagation(); setMode('chronological'); }}
        >
          Over Time
        </button>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        {mode === 'timeOfDay' ? (
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--ctp-surface2)" />
            <XAxis
              dataKey="timeDecimal"
              type="number"
              domain={[0, 24]}
              ticks={[0, 6, 12, 18, 24]}
              tickFormatter={value => {
                const hours = Math.floor(value);
                const minutes = Math.round((value - hours) * 60);
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              }}
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
            />
            <YAxis
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
              label={{ value: 'SNR (dB)', angle: -90, position: 'insideLeft', style: { fill: 'var(--ctp-subtext1)', fontSize: 10 } }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)', borderRadius: '4px', fontSize: '12px' }}
              labelStyle={{ color: 'var(--ctp-text)' }}
              labelFormatter={value => {
                const item = chartData.find(d => d.timeDecimal === value);
                return item ? item.timeLabel : String(value);
              }}
            />
            <Line type="monotone" dataKey="snr" stroke="var(--ctp-mauve)" strokeWidth={2} dot={{ fill: 'var(--ctp-mauve)', r: 3 }} />
          </LineChart>
        ) : (
          <LineChart data={chronoData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--ctp-surface2)" />
            <XAxis
              dataKey="chronoTime"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={value => {
                const date = new Date(value);
                return `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
              }}
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
            />
            <YAxis
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
              label={{ value: 'SNR (dB)', angle: -90, position: 'insideLeft', style: { fill: 'var(--ctp-subtext1)', fontSize: 10 } }}
            />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--ctp-surface0)', border: '1px solid var(--ctp-surface2)', borderRadius: '4px', fontSize: '12px' }}
              labelStyle={{ color: 'var(--ctp-text)' }}
              labelFormatter={value => {
                const item = chronoData.find(d => d.chronoTime === value);
                return item ? item.chronoLabel : String(value);
              }}
            />
            <Line type="monotone" dataKey="snr" stroke="var(--ctp-mauve)" strokeWidth={2} dot={{ fill: 'var(--ctp-mauve)', r: 3 }} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Minimal node data needed for traceroute rendering
 * Uses digest format to prevent unnecessary re-renders
 */
export interface NodePositionDigest {
  nodeNum: number;
  position?: {
    latitude: number;
    longitude: number;
  };
  user?: {
    longName?: string;
    shortName?: string;
    id?: string;
  };
  viaMqtt?: boolean;
}

/**
 * Traceroute data structure
 */
export interface TracerouteDigest {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId?: string;
  toNodeId?: string;
  route: string;
  routeBack: string;
  snrTowards?: string;
  snrBack?: string;
  routePositions?: string; // JSON: { [nodeNum]: { lat, lng, alt? } } - position snapshot at traceroute time
  timestamp?: number;
  createdAt?: number;
}

/**
 * Theme colors for path rendering
 */
export interface ThemeColors {
  mauve: string;
  red: string;
  blue: string;
  overlay0: string;
  // Overlay scheme colors (override theme CSS colors when set)
  tracerouteForward?: string;
  tracerouteReturn?: string;
  mqttSegment?: string;
  neighborLine?: string;
  snrColors?: {
    good: string;
    medium: string;
    poor: string;
  };
}

/**
 * Callbacks for interactive elements in popups
 */
export interface TracerouteCallbacks {
  onSelectNode: (nodeId: string, position: [number, number]) => void;
  onSelectRouteSegment: (nodeNum1: number, nodeNum2: number) => void;
}

/**
 * Hook parameters
 */
export interface UseTraceroutePathsParams {
  showPaths: boolean;
  showRoute: boolean;
  selectedNodeId: string | null;
  currentNodeId: string | null;
  nodesPositionDigest: NodePositionDigest[];
  traceroutesDigest: TracerouteDigest[];
  distanceUnit: DistanceUnit;
  maxNodeAgeHours: number;
  themeColors: ThemeColors;
  callbacks: TracerouteCallbacks;
  /** Optional set of visible node numbers - when provided, only show route segments where both endpoints are visible */
  visibleNodeNums?: Set<number>;
  /** Current map zoom level - controls detail filtering */
  mapZoom?: number;
}

/**
 * Hook return value
 */
export interface UseTraceroutePathsResult {
  /** Base traceroute path elements (all paths when showPaths is true) */
  traceroutePathsElements: React.ReactElement[] | null;
  /** Selected node traceroute elements (specific route when showRoute is true) */
  selectedNodeTraceroute: React.ReactElement[] | null;
  /** Set of node numbers involved in the selected traceroute (for filtering map markers) */
  tracerouteNodeNums: Set<number> | null;
  /** Bounding box of the selected traceroute for zoom-to-fit [[minLat, minLng], [maxLat, maxLng]] */
  tracerouteBounds: [[number, number], [number, number]] | null;
}

const BROADCAST_ADDR = 4294967295;

/**
 * Filter function to remove invalid/reserved node numbers from route arrays
 * This provides frontend safety for any invalid data that may exist in the database
 * Invalid values:
 * - 0-3: Reserved per Meshtastic protocol
 * - 255 (0xff): Reserved for broadcast in some contexts
 * - 65535 (0xffff): Invalid placeholder value that causes display issues
 * - 4294967295 (0xffffffff): Broadcast address
 */
const isValidRouteNode = (nodeNum: number): boolean => {
  if (nodeNum <= 3) return false;  // Reserved
  if (nodeNum === 255) return false;  // 0xff reserved
  if (nodeNum === 65535) return false;  // 0xffff invalid placeholder
  if (nodeNum === BROADCAST_ADDR) return false;  // Broadcast
  return true;
};

/**
 * Parse routePositions JSON string into a position map
 * Returns empty object if parsing fails or data is missing
 */
const parseRoutePositions = (routePositions?: string): Record<number, { lat: number; lng: number; alt?: number }> => {
  if (!routePositions) return {};
  try {
    return JSON.parse(routePositions);
  } catch {
    return {};
  }
};

/**
 * Get node position, preferring snapshot positions over current positions
 * This ensures historical traceroutes render where nodes were at the time
 */
const getNodePositionWithSnapshot = (
  nodeNum: number,
  snapshotPositions: Record<number, { lat: number; lng: number; alt?: number }>,
  nodesPositionDigest: NodePositionDigest[]
): [number, number] | null => {
  // Prefer historical snapshot position
  const snapshot = snapshotPositions[nodeNum];
  if (snapshot?.lat && snapshot?.lng) {
    return [snapshot.lat, snapshot.lng];
  }
  // Fall back to current position
  const node = nodesPositionDigest.find(n => n.nodeNum === nodeNum);
  if (node?.position?.latitude && node?.position?.longitude) {
    return [node.position.latitude, node.position.longitude];
  }
  return null;
};

/**
 * Hook for computing and rendering traceroute paths on the map
 */
export function useTraceroutePaths({
  showPaths,
  showRoute,
  selectedNodeId,
  currentNodeId,
  nodesPositionDigest,
  traceroutesDigest,
  distanceUnit,
  maxNodeAgeHours,
  themeColors,
  callbacks,
  visibleNodeNums,
  mapZoom,
}: UseTraceroutePathsParams): UseTraceroutePathsResult {
  // Memoize base traceroute paths (showPaths) - doesn't depend on selectedNodeId
  // This prevents re-rendering markers when clicking to select a node
  const traceroutePathsElements = useMemo(() => {
    if (!showPaths) return null;

    // Collect all map elements to return
    const allElements: React.ReactElement[] = [];

    // Calculate segment usage counts and collect SNR values with timestamps
    const segmentUsage = new Map<string, number>();
    const segmentSNRs = new Map<string, Array<{ snr: number; timestamp: number }>>();
    // Track segments that have MQTT/unknown hops (SNR sentinel indicates MQTT gateway or unknown)
    const segmentHasMqtt = new Map<string, boolean>();
    // Track most recent timestamp per segment for temporal fade
    const segmentLatestTimestamp = new Map<string, number>();
    const segmentsList: Array<{
      key: string;
      positions: [number, number][];
      nodeNums: number[];
    }> = [];

    // Filter traceroutes by age using the same maxNodeAgeHours setting
    const cutoffTime = Date.now() - maxNodeAgeHours * 60 * 60 * 1000;
    const recentTraceroutes = traceroutesDigest.filter(tr => {
      const timestamp = tr.timestamp || tr.createdAt || 0;
      return timestamp >= cutoffTime;
    });

    // Deduplicate: keep only the most recent traceroute per node pair
    const tracerouteMap = new Map<string, TracerouteDigest>();
    recentTraceroutes.forEach(tr => {
      // Create a bidirectional key (same for A→B and B→A)
      const key = [tr.fromNodeNum, tr.toNodeNum].sort().join('-');
      const existing = tracerouteMap.get(key);
      const timestamp = tr.timestamp || tr.createdAt || 0;
      const existingTimestamp = existing?.timestamp || existing?.createdAt || 0;

      // Keep the most recent traceroute for this node pair
      if (!existing || timestamp > existingTimestamp) {
        tracerouteMap.set(key, tr);
      }
    });

    // Convert back to array for processing
    const deduplicatedTraceroutes = Array.from(tracerouteMap.values());

    deduplicatedTraceroutes.forEach((tr, idx) => {
      try {
        // Skip traceroutes with null or invalid route data (failed traceroutes)
        if (
          !tr.route ||
          tr.route === 'null' ||
          tr.route === '' ||
          !tr.routeBack ||
          tr.routeBack === 'null' ||
          tr.routeBack === ''
        ) {
          return; // Skip this traceroute - no valid route data to display
        }

        // Process forward path - filter out invalid node numbers
        const rawRouteForward = JSON.parse(tr.route);
        const rawRouteBack = JSON.parse(tr.routeBack);
        const routeForward = rawRouteForward.filter(isValidRouteNode);
        const routeBack = rawRouteBack.filter(isValidRouteNode);

        // Note: Empty arrays are valid (direct path with no intermediate hops)

        const snrForward =
          tr.snrTowards && tr.snrTowards !== 'null' && tr.snrTowards !== '' ? JSON.parse(tr.snrTowards) : [];
        const timestamp = tr.timestamp || tr.createdAt || Date.now();

        // Parse snapshot positions (Issue #1862) - prefer historical positions over current
        const snapshotPositions = parseRoutePositions(tr.routePositions);

        // Build forward path: responder -> route -> requester (fromNodeNum -> toNodeNum)
        const forwardSequence: number[] = [tr.fromNodeNum, ...routeForward, tr.toNodeNum];
        const forwardPositions: Array<{ nodeNum: number; pos: [number, number] }> = [];

        // Build forward sequence with positions (prefer snapshot positions)
        forwardSequence.forEach(nodeNum => {
          const pos = getNodePositionWithSnapshot(nodeNum, snapshotPositions, nodesPositionDigest);
          if (pos) {
            forwardPositions.push({ nodeNum, pos });
          }
        });

        // Create forward segments and count usage
        for (let i = 0; i < forwardPositions.length - 1; i++) {
          const from = forwardPositions[i];
          const to = forwardPositions[i + 1];
          const segmentKey = [from.nodeNum, to.nodeNum].sort().join('-');

          segmentUsage.set(segmentKey, (segmentUsage.get(segmentKey) || 0) + 1);

          // Collect SNR value with timestamp for this segment
          if (snrForward[i] !== undefined) {
            const snrValue = snrForward[i] / 4; // Scale SNR value
            if (!segmentSNRs.has(segmentKey)) {
              segmentSNRs.set(segmentKey, []);
            }
            segmentSNRs.get(segmentKey)!.push({ snr: snrValue, timestamp });
            if (isUnknownSnr(snrValue)) {
              segmentHasMqtt.set(segmentKey, true);
            }
          }

          // Track most recent timestamp for temporal fade
          const existingTsFwd = segmentLatestTimestamp.get(segmentKey) || 0;
          if (timestamp > existingTsFwd) {
            segmentLatestTimestamp.set(segmentKey, timestamp);
          }

          segmentsList.push({
            key: `tr-${idx}-fwd-seg-${i}`,
            positions: [from.pos, to.pos],
            nodeNums: [from.nodeNum, to.nodeNum],
          });
        }

        // Process return path
        const snrBack = tr.snrBack && tr.snrBack !== 'null' && tr.snrBack !== '' ? JSON.parse(tr.snrBack) : [];
        // Build return path: requester -> routeBack -> responder (toNodeNum -> fromNodeNum)
        const backSequence: number[] = [tr.toNodeNum, ...routeBack, tr.fromNodeNum];
        const backPositions: Array<{ nodeNum: number; pos: [number, number] }> = [];

        // Build back sequence with positions (prefer snapshot positions)
        backSequence.forEach(nodeNum => {
          const pos = getNodePositionWithSnapshot(nodeNum, snapshotPositions, nodesPositionDigest);
          if (pos) {
            backPositions.push({ nodeNum, pos });
          }
        });

        // Create back segments and count usage
        for (let i = 0; i < backPositions.length - 1; i++) {
          const from = backPositions[i];
          const to = backPositions[i + 1];
          const segmentKey = [from.nodeNum, to.nodeNum].sort().join('-');

          segmentUsage.set(segmentKey, (segmentUsage.get(segmentKey) || 0) + 1);

          // Collect SNR value with timestamp for this segment
          if (snrBack[i] !== undefined) {
            const snrValue = snrBack[i] / 4; // Scale SNR value
            if (!segmentSNRs.has(segmentKey)) {
              segmentSNRs.set(segmentKey, []);
            }
            segmentSNRs.get(segmentKey)!.push({ snr: snrValue, timestamp });
            if (isUnknownSnr(snrValue)) {
              segmentHasMqtt.set(segmentKey, true);
            }
          }

          // Track most recent timestamp for temporal fade
          const existingTsBack = segmentLatestTimestamp.get(segmentKey) || 0;
          if (timestamp > existingTsBack) {
            segmentLatestTimestamp.set(segmentKey, timestamp);
          }

          segmentsList.push({
            key: `tr-${idx}-back-seg-${i}`,
            positions: [from.pos, to.pos],
            nodeNums: [from.nodeNum, to.nodeNum],
          });
        }
      } catch (error) {
        logger.error('Error parsing traceroute:', error);
      }
    });

    // Filter segments to only include those where both endpoints are visible
    // This ensures route segments are hidden when their connected nodes are filtered out
    let filteredSegments = visibleNodeNums
      ? segmentsList.filter(segment => {
          const [nodeNum1, nodeNum2] = segment.nodeNums;
          return visibleNodeNums.has(nodeNum1) && visibleNodeNums.has(nodeNum2);
        })
      : segmentsList;

    // Zoom-adaptive filtering: at low zoom levels, only show stronger segments
    if (mapZoom !== undefined && mapZoom < 8) {
      // Regional view: only show segments with good or medium SNR (filter out poor/unknown)
      filteredSegments = filteredSegments.filter(segment => {
        const segKey = segment.nodeNums.slice().sort().join('-');
        const snrData = segmentSNRs.get(segKey);
        if (!snrData || snrData.length === 0) return false; // Hide unknown segments at low zoom
        const rfSnrs = snrData.filter(d => !isUnknownSnr(d.snr)).map(d => d.snr);
        if (rfSnrs.length === 0) return false; // Hide pure MQTT at low zoom
        const avgSnr = rfSnrs.reduce((sum, val) => sum + val, 0) / rfSnrs.length;
        return avgSnr >= -10; // Only good + medium quality links
      });
    }

    // Render segments with weighted lines
    const segmentElements = filteredSegments.map(segment => {
      const segmentKey = segment.nodeNums.slice().sort().join('-');
      const usage = segmentUsage.get(segmentKey) || 1;
      // Base weight 2, add 1 per usage, max 8
      const weight = Math.min(2 + usage, 8);
      // Get node names for popup
      const node1 = nodesPositionDigest.find(n => n.nodeNum === segment.nodeNums[0]);
      const node2 = nodesPositionDigest.find(n => n.nodeNum === segment.nodeNums[1]);

      // Check if this segment traversed MQTT: either SNR sentinel or either endpoint is an MQTT node
      const isMqttSegment = (segmentHasMqtt.get(segmentKey) || false) ||
        (node1?.viaMqtt === true) || (node2?.viaMqtt === true);
      const node1Name =
        segment.nodeNums[0] === BROADCAST_ADDR
          ? '(unknown)'
          : node1?.user?.longName || node1?.user?.shortName || `!${segment.nodeNums[0].toString(16)}`;
      const node2Name =
        segment.nodeNums[1] === BROADCAST_ADDR
          ? '(unknown)'
          : node2?.user?.longName || node2?.user?.shortName || `!${segment.nodeNums[1].toString(16)}`;

      // Calculate distance if both nodes have position data
      let segmentDistanceKm = 0;
      if (
        node1?.position?.latitude &&
        node1?.position?.longitude &&
        node2?.position?.latitude &&
        node2?.position?.longitude
      ) {
        segmentDistanceKm = calculateDistance(
          node1.position.latitude,
          node1.position.longitude,
          node2.position.latitude,
          node2.position.longitude
        );
      }

      // Calculate SNR statistics
      const snrData = segmentSNRs.get(segmentKey) || [];
      let snrStats: { min: string; max: string; avg: string; count: number } | null = null;
      let chartData: Array<{
        timeDecimal: number;
        timeLabel: string;
        snr: number;
        fullTimestamp: number;
      }> | null = null;

      if (snrData.length > 0) {
        const snrValues = snrData.map(d => d.snr);
        const minSNR = Math.min(...snrValues);
        const maxSNR = Math.max(...snrValues);
        const avgSNR = snrValues.reduce((sum, val) => sum + val, 0) / snrValues.length;
        snrStats = {
          min: minSNR.toFixed(1),
          max: maxSNR.toFixed(1),
          avg: avgSNR.toFixed(1),
          count: snrData.length,
        };

        // Prepare chart data for 3+ samples (sorted by time of day)
        if (snrData.length >= 3) {
          chartData = snrData
            .map(d => {
              const date = new Date(d.timestamp);
              const hours = date.getHours();
              const minutes = date.getMinutes();
              // Convert to decimal hours (0-24) for continuous time axis
              const timeDecimal = hours + minutes / 60;
              return {
                timeDecimal,
                timeLabel: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
                snr: parseFloat(d.snr.toFixed(1)),
                fullTimestamp: d.timestamp,
              };
            })
            .sort((a, b) => a.timeDecimal - b.timeDecimal);
        }
      }

      const segmentColor = isMqttSegment
        ? (themeColors.mqttSegment ?? themeColors.overlay0)
        : themeColors.snrColors
          ? getSegmentSnrColor(snrData, themeColors.snrColors, themeColors.neighborLine ?? themeColors.mauve)
          : (themeColors.neighborLine ?? themeColors.mauve);
      const baseOpacity = getSegmentSnrOpacity(snrData, isMqttSegment);
      const latestTimestamp = segmentLatestTimestamp.get(segmentKey);
      const temporalMultiplier = getTemporalOpacityMultiplier(latestTimestamp);
      const segmentOpacity = Math.max(0.15, baseOpacity * temporalMultiplier);

      const polylineElement = (
        <Polyline
          key={segment.key}
          positions={segment.positions}
          pathOptions={{
            color: segmentColor,
            weight,
            opacity: segmentOpacity,
            dashArray: isMqttSegment ? '3,6' : undefined,
          }}
          className={`route-segment node-${segment.nodeNums[0]} node-${segment.nodeNums[1]}`}
        >
          <Popup>
            <div className="route-popup">
              <h4>Route Segment</h4>
              {isMqttSegment && (
                <div className="mqtt-badge">via IP</div>
              )}
              <div className="route-endpoints">
                <strong
                  className={node1?.user?.id ? 'route-node-link' : undefined}
                  onClick={e => {
                    e.stopPropagation();
                    const freshNode = nodesPositionDigest.find(n => n.nodeNum === segment.nodeNums[0]);
                    if (freshNode?.user?.id && freshNode?.position?.latitude && freshNode?.position?.longitude) {
                      callbacks.onSelectNode(freshNode.user.id, [
                        freshNode.position.latitude,
                        freshNode.position.longitude,
                      ]);
                    }
                  }}
                  title={node1?.user?.id ? 'Click to select and center on this node' : ''}
                >
                  {node1Name}
                </strong>
                {' ↔ '}
                <strong
                  className={node2?.user?.id ? 'route-node-link' : undefined}
                  onClick={e => {
                    e.stopPropagation();
                    const freshNode = nodesPositionDigest.find(n => n.nodeNum === segment.nodeNums[1]);
                    if (freshNode?.user?.id && freshNode?.position?.latitude && freshNode?.position?.longitude) {
                      callbacks.onSelectNode(freshNode.user.id, [
                        freshNode.position.latitude,
                        freshNode.position.longitude,
                      ]);
                    }
                  }}
                  title={node2?.user?.id ? 'Click to select and center on this node' : ''}
                >
                  {node2Name}
                </strong>
              </div>
              <div className="route-usage">
                Used in{' '}
                <strong
                  onClick={e => {
                    e.stopPropagation();
                    callbacks.onSelectRouteSegment(segment.nodeNums[0], segment.nodeNums[1]);
                  }}
                  style={{ cursor: 'pointer', color: 'var(--ctp-blue)', textDecoration: 'underline' }}
                  title="Click to view all traceroutes using this segment"
                >
                  {usage}
                </strong>{' '}
                traceroute{usage !== 1 ? 's' : ''}
              </div>
              {segmentDistanceKm > 0 && (
                <div className="route-usage">
                  Distance: <strong>{formatDistance(segmentDistanceKm, distanceUnit)}</strong>
                </div>
              )}
              {snrStats && (
                <div className="route-snr-stats">
                  {snrStats.count === 1 ? (
                    <>
                      <h5>SNR:</h5>
                      <div className="snr-stat-row">
                        <span className="stat-value">{snrStats.min} dB</span>
                      </div>
                    </>
                  ) : snrStats.count === 2 ? (
                    <>
                      <h5>SNR Statistics:</h5>
                      <div className="snr-stat-row">
                        <span className="stat-label">Min:</span>
                        <span className="stat-value">{snrStats.min} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Max:</span>
                        <span className="stat-value">{snrStats.max} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Samples:</span>
                        <span className="stat-value">{snrStats.count}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <h5>SNR Statistics:</h5>
                      <div className="snr-stat-row">
                        <span className="stat-label">Min:</span>
                        <span className="stat-value">{snrStats.min} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Max:</span>
                        <span className="stat-value">{snrStats.max} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Average:</span>
                        <span className="stat-value">{snrStats.avg} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Samples:</span>
                        <span className="stat-value">{snrStats.count}</span>
                      </div>
                      {chartData && (
                        <SegmentSnrChart chartData={chartData} />
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Popup>
        </Polyline>
      );

      return polylineElement;
    });

    allElements.push(...segmentElements);

    return allElements;
  }, [showPaths, traceroutesDigest, nodesPositionDigest, distanceUnit, maxNodeAgeHours, themeColors.mauve, themeColors.overlay0, themeColors.neighborLine, themeColors.mqttSegment, themeColors.snrColors, callbacks, visibleNodeNums, mapZoom]);

  // Separate memoization for selected node traceroute (showRoute)
  // This can change independently without re-rendering the base map markers
  const selectedNodeTraceroute = useMemo(() => {
    // Skip rendering traceroute if the selected node is the current/local node
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    const allElements: React.ReactElement[] = [];

    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );

    if (!selectedTrace) return null;

    // Skip if the traceroute has null or invalid route data (failed traceroute)
    if (
      !selectedTrace.route ||
      selectedTrace.route === 'null' ||
      selectedTrace.route === '' ||
      !selectedTrace.routeBack ||
      selectedTrace.routeBack === 'null' ||
      selectedTrace.routeBack === ''
    ) {
      return null;
    }

    try {
      // Route arrays are stored exactly as Meshtastic provides them (no backend reversal)
      // Filter out invalid node numbers for safety
      const rawRouteForward = JSON.parse(selectedTrace.route);
      const rawRouteBack = JSON.parse(selectedTrace.routeBack);
      const routeForward = rawRouteForward.filter(isValidRouteNode);
      const routeBack = rawRouteBack.filter(isValidRouteNode);

      // Parse SNR data
      const snrForward = selectedTrace.snrTowards && selectedTrace.snrTowards !== 'null' ? JSON.parse(selectedTrace.snrTowards) : [];
      const snrBack = selectedTrace.snrBack && selectedTrace.snrBack !== 'null' ? JSON.parse(selectedTrace.snrBack) : [];

      // Parse snapshot positions (Issue #1862) - prefer historical positions over current
      const snapshotPositions = parseRoutePositions(selectedTrace.routePositions);

      const fromNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.fromNodeNum);
      const toNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.toNodeNum);
      const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
      const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;

      // Forward path: responder -> requester
      if (routeForward.length >= 0) {
        const forwardSequence: number[] = [selectedTrace.fromNodeNum, ...routeForward, selectedTrace.toNodeNum];
        const forwardPositions: [number, number][] = [];

        forwardSequence.forEach(nodeNum => {
          const pos = getNodePositionWithSnapshot(nodeNum, snapshotPositions, nodesPositionDigest);
          if (pos) {
            forwardPositions.push(pos);
          }
        });

        if (forwardPositions.length >= 2) {
          // Calculate total distance for forward path (use snapshot positions)
          let forwardTotalDistanceKm = 0;
          for (let i = 0; i < forwardSequence.length - 1; i++) {
            const pos1 = getNodePositionWithSnapshot(forwardSequence[i], snapshotPositions, nodesPositionDigest);
            const pos2 = getNodePositionWithSnapshot(forwardSequence[i + 1], snapshotPositions, nodesPositionDigest);
            if (pos1 && pos2) {
              forwardTotalDistanceKm += calculateDistance(pos1[0], pos1[1], pos2[0], pos2[1]);
            }
          }

          // Build SNR array for segments
          const forwardSegmentSnrs: (number | undefined)[] = [];
          if (forwardSequence.length > 1) {
             // For each segment (node i -> node i+1), the SNR is usually recorded at the receiving end
             // The snrForward array corresponds to hops.
             // We map them to segments.
             for (let i = 0; i < forwardSequence.length - 1; i++) {
                // SNR at index i corresponds to the link arriving at node i+1
                // For the first segment (0 -> 1), use index 0.
                if (i < snrForward.length) {
                   forwardSegmentSnrs.push(snrForward[i] / 4);
                } else {
                   forwardSegmentSnrs.push(undefined);
                }
             }
          }

          // Render individual curved segments
          for (let i = 0; i < forwardPositions.length - 1; i++) {
             const segmentPoints = generateCurvedPath(
               forwardPositions[i],
               forwardPositions[i + 1],
               0.2, // Positive curvature for forward
               20,
               true
             );
             
             const weight = getLineWeight(forwardSegmentSnrs[i]);
             const isMqtt = isUnknownSnr(forwardSegmentSnrs[i]);

             allElements.push(
               <Polyline
                 key={`selected-traceroute-forward-seg-${i}`}
                 positions={segmentPoints}
                 pathOptions={{
                   color: themeColors.tracerouteForward ?? themeColors.blue,
                   weight,
                   opacity: 0.9,
                   dashArray: '3,6',
                 }}
                 className={`route-segment node-${forwardSequence[i]} node-${forwardSequence[i + 1]}`}
               >
                 <DraggablePopup>
                   <div className="route-popup">
                     <h4>Forward Path</h4>
                     <div className="route-endpoints">
                       <strong>{fromName}</strong> → <strong>{toName}</strong>
                     </div>
                     <div className="route-usage">
                       Path:{' '}
                       {forwardSequence
                         .map(num => {
                           const n = nodesPositionDigest.find(nd => nd.nodeNum === num);
                           return n?.user?.longName || n?.user?.shortName || `!${num.toString(16)}`;
                         })
                         .join(' → ')}
                     </div>
                     {forwardTotalDistanceKm > 0 && (
                       <div className="route-usage">
                         Distance: <strong>{formatDistance(forwardTotalDistanceKm, distanceUnit)}</strong>
                       </div>
                     )}
                     {forwardSegmentSnrs[i] !== undefined && (
                        <div className="route-usage" style={{ marginTop: '8px', borderTop: '1px solid var(--ctp-surface0)', paddingTop: '4px' }}>
                          Segment SNR: <strong>{forwardSegmentSnrs[i]?.toFixed(1)} dB</strong>
                          {isMqtt && ' (IP)'}
                        </div>
                     )}
                   </div>
                 </DraggablePopup>
               </Polyline>
             );
          }

          // Generate arrow markers for forward path
          const forwardArrows = generateCurvedArrowMarkers(
            forwardPositions,
            'forward',
            themeColors.tracerouteForward ?? themeColors.blue,
            forwardSegmentSnrs,
            0.2,
            true
          );
          allElements.push(...forwardArrows);
        }
      }

      // Return path: requester -> responder (using routeBack array)
      if (routeBack.length >= 0) {
        const backSequence: number[] = [selectedTrace.toNodeNum, ...routeBack, selectedTrace.fromNodeNum];
        const backPositions: [number, number][] = [];

        backSequence.forEach(nodeNum => {
          const pos = getNodePositionWithSnapshot(nodeNum, snapshotPositions, nodesPositionDigest);
          if (pos) {
            backPositions.push(pos);
          }
        });

        if (backPositions.length >= 2) {
          // Calculate total distance for back path (use snapshot positions)
          let backTotalDistanceKm = 0;
          for (let i = 0; i < backSequence.length - 1; i++) {
            const pos1 = getNodePositionWithSnapshot(backSequence[i], snapshotPositions, nodesPositionDigest);
            const pos2 = getNodePositionWithSnapshot(backSequence[i + 1], snapshotPositions, nodesPositionDigest);
            if (pos1 && pos2) {
              backTotalDistanceKm += calculateDistance(pos1[0], pos1[1], pos2[0], pos2[1]);
            }
          }

          // Build SNR array for segments
          const backSegmentSnrs: (number | undefined)[] = [];
          if (backSequence.length > 1) {
             for (let i = 0; i < backSequence.length - 1; i++) {
                if (i < snrBack.length) {
                   backSegmentSnrs.push(snrBack[i] / 4);
                } else {
                   backSegmentSnrs.push(undefined);
                }
             }
          }

          // Render individual curved segments
          for (let i = 0; i < backPositions.length - 1; i++) {
             const segmentPoints = generateCurvedPath(
               backPositions[i],
               backPositions[i + 1],
               -0.2, // Negative curvature
               20,
               true
             );
             
             const weight = getLineWeight(backSegmentSnrs[i]);
             const isMqtt = isUnknownSnr(backSegmentSnrs[i]);

             allElements.push(
               <Polyline
                 key={`selected-traceroute-back-seg-${i}`}
                 positions={segmentPoints}
                 pathOptions={{
                   color: themeColors.tracerouteReturn ?? themeColors.red,
                   weight,
                   opacity: 0.9,
                   dashArray: '3,6',
                 }}
                 className={`route-segment node-${backSequence[i]} node-${backSequence[i + 1]}`}
               >
                 <DraggablePopup>
                   <div className="route-popup">
                     <h4>Return Path</h4>
                     <div className="route-endpoints">
                       <strong>{toName}</strong> → <strong>{fromName}</strong>
                     </div>
                     <div className="route-usage">
                       Path:{' '}
                       {backSequence
                         .map(num => {
                           const n = nodesPositionDigest.find(nd => nd.nodeNum === num);
                           return n?.user?.longName || n?.user?.shortName || `!${num.toString(16)}`;
                         })
                         .join(' → ')}
                     </div>
                     {backTotalDistanceKm > 0 && (
                       <div className="route-usage">
                         Distance: <strong>{formatDistance(backTotalDistanceKm, distanceUnit)}</strong>
                       </div>
                     )}
                     {backSegmentSnrs[i] !== undefined && (
                        <div className="route-usage" style={{ marginTop: '8px', borderTop: '1px solid var(--ctp-surface0)', paddingTop: '4px' }}>
                          Segment SNR: <strong>{backSegmentSnrs[i]?.toFixed(1)} dB</strong>
                          {isMqtt && ' (IP)'}
                        </div>
                     )}
                   </div>
                 </DraggablePopup>
               </Polyline>
             );
          }

          // Generate arrow markers for back path
          const backArrows = generateCurvedArrowMarkers(
            backPositions, 
            'back', 
            themeColors.tracerouteReturn ?? themeColors.red,
            backSegmentSnrs,
            -0.2,
            true
          );
          allElements.push(...backArrows);
        }
      }
    } catch (error) {
      logger.error('Error rendering selected node traceroute:', error);
    }

    return allElements.length > 0 ? allElements : null;
  }, [showRoute, selectedNodeId, traceroutesDigest, nodesPositionDigest, currentNodeId, distanceUnit, themeColors.red, themeColors.blue, themeColors.tracerouteForward, themeColors.tracerouteReturn]);

  // Compute the set of node numbers involved in the selected traceroute
  // Used for filtering map markers to only show nodes in the active traceroute
  const tracerouteNodeNums = useMemo(() => {
    // Only compute when showRoute is enabled and there's a selected node
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );

    if (!selectedTrace) return null;

    // Skip if the traceroute has null or invalid route data
    if (
      !selectedTrace.route ||
      selectedTrace.route === 'null' ||
      selectedTrace.route === '' ||
      !selectedTrace.routeBack ||
      selectedTrace.routeBack === 'null' ||
      selectedTrace.routeBack === ''
    ) {
      return null;
    }

    try {
      const nodeNums = new Set<number>();

      // Add the endpoints
      nodeNums.add(selectedTrace.fromNodeNum);
      nodeNums.add(selectedTrace.toNodeNum);

      // Add intermediate nodes from forward route
      const rawRouteForward = JSON.parse(selectedTrace.route);
      const routeForward = rawRouteForward.filter(isValidRouteNode);
      routeForward.forEach((num: number) => nodeNums.add(num));

      // Add intermediate nodes from back route
      const rawRouteBack = JSON.parse(selectedTrace.routeBack);
      const routeBack = rawRouteBack.filter(isValidRouteNode);
      routeBack.forEach((num: number) => nodeNums.add(num));

      return nodeNums.size > 0 ? nodeNums : null;
    } catch (error) {
      logger.error('Error computing traceroute node numbers:', error);
      return null;
    }
  }, [showRoute, selectedNodeId, currentNodeId, traceroutesDigest]);

  // Compute bounding box of the selected traceroute for zoom-to-fit
  const tracerouteBounds = useMemo((): [[number, number], [number, number]] | null => {
    if (!tracerouteNodeNums || tracerouteNodeNums.size === 0) return null;

    // Parse snapshot positions from the selected traceroute
    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );
    const snapshotPositions = parseRoutePositions(selectedTrace?.routePositions);

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let hasValidPositions = false;

    tracerouteNodeNums.forEach(nodeNum => {
      const pos = getNodePositionWithSnapshot(nodeNum, snapshotPositions, nodesPositionDigest);
      if (pos) {
        hasValidPositions = true;
        minLat = Math.min(minLat, pos[0]);
        maxLat = Math.max(maxLat, pos[0]);
        minLng = Math.min(minLng, pos[1]);
        maxLng = Math.max(maxLng, pos[1]);
      }
    });

    if (!hasValidPositions) return null;

    // Add some padding to the bounds (approximately 10% on each side)
    const latPadding = (maxLat - minLat) * 0.1 || 0.01;
    const lngPadding = (maxLng - minLng) * 0.1 || 0.01;

    return [
      [minLat - latPadding, minLng - lngPadding],
      [maxLat + latPadding, maxLng + lngPadding]
    ];
  }, [tracerouteNodeNums, nodesPositionDigest, traceroutesDigest, selectedNodeId]);

  return {
    traceroutePathsElements,
    selectedNodeTraceroute,
    tracerouteNodeNums,
    tracerouteBounds,
  };
}
