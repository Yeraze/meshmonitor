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

import React, { useMemo } from 'react';
import { Popup, Polyline } from 'react-leaflet';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { calculateDistance, formatDistance } from '../utils/distance';
import { generateArrowMarkers } from '../utils/mapHelpers';
import { logger } from '../utils/logger';
import type { DistanceUnit } from '../contexts/SettingsContext';

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
  timestamp?: number;
  createdAt?: number;
}

/**
 * Theme colors for path rendering
 */
export interface ThemeColors {
  mauve: string;
  red: string;
  overlay0: string; // For MQTT segments (muted color)
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
}

/**
 * Hook return value
 */
export interface UseTraceroutePathsResult {
  /** Base traceroute path elements (all paths when showPaths is true) */
  traceroutePathsElements: React.ReactElement[] | null;
  /** Selected node traceroute elements (specific route when showRoute is true) */
  selectedNodeTraceroute: React.ReactElement[] | null;
}

const BROADCAST_ADDR = 4294967295;

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
    // Track segments that have MQTT/unknown hops (-128 raw SNR = -32 scaled indicates MQTT/unknown)
    // Note: -128 (INT8_MIN) is the Meshtastic sentinel value for unknown SNR (MQTT gateways, older firmware)
    const segmentHasMqtt = new Map<string, boolean>();
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

        // Process forward path
        const routeForward = JSON.parse(tr.route);
        const routeBack = JSON.parse(tr.routeBack);

        // Note: Empty arrays are valid (direct path with no intermediate hops)

        const snrForward =
          tr.snrTowards && tr.snrTowards !== 'null' && tr.snrTowards !== '' ? JSON.parse(tr.snrTowards) : [];
        const timestamp = tr.timestamp || tr.createdAt || Date.now();

        // Build forward path: responder -> route -> requester (fromNodeNum -> toNodeNum)
        const forwardSequence: number[] = [tr.fromNodeNum, ...routeForward, tr.toNodeNum];
        const forwardPositions: Array<{ nodeNum: number; pos: [number, number] }> = [];

        // Build forward sequence with positions
        forwardSequence.forEach(nodeNum => {
          const node = nodesPositionDigest.find(n => n.nodeNum === nodeNum);
          if (node?.position?.latitude && node?.position?.longitude) {
            forwardPositions.push({
              nodeNum,
              pos: [node.position.latitude, node.position.longitude],
            });
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
            // Mark segment as MQTT/unknown if SNR is -32 dB (raw -128 / 4 = -32)
            // -128 (INT8_MIN) is Meshtastic's sentinel value for unknown SNR (MQTT gateways, older firmware)
            if (snrValue === -32) {
              segmentHasMqtt.set(segmentKey, true);
            }
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

        // Build back sequence with positions
        backSequence.forEach(nodeNum => {
          const node = nodesPositionDigest.find(n => n.nodeNum === nodeNum);
          if (node?.position?.latitude && node?.position?.longitude) {
            backPositions.push({
              nodeNum,
              pos: [node.position.latitude, node.position.longitude],
            });
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
            // Mark segment as MQTT/unknown if SNR is -32 dB (raw -128 / 4 = -32)
            // -128 (INT8_MIN) is Meshtastic's sentinel value for unknown SNR (MQTT gateways, older firmware)
            if (snrValue === -32) {
              segmentHasMqtt.set(segmentKey, true);
            }
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
    const filteredSegments = visibleNodeNums
      ? segmentsList.filter(segment => {
          const [nodeNum1, nodeNum2] = segment.nodeNums;
          return visibleNodeNums.has(nodeNum1) && visibleNodeNums.has(nodeNum2);
        })
      : segmentsList;

    // Render segments with weighted lines
    const segmentElements = filteredSegments.map(segment => {
      const segmentKey = segment.nodeNums.sort().join('-');
      const usage = segmentUsage.get(segmentKey) || 1;
      // Base weight 2, add 1 per usage, max 8
      const weight = Math.min(2 + usage, 8);
      // Check if this segment traversed MQTT (has 0.0 dB SNR)
      const isMqttSegment = segmentHasMqtt.get(segmentKey) || false;

      // Get node names for popup
      const node1 = nodesPositionDigest.find(n => n.nodeNum === segment.nodeNums[0]);
      const node2 = nodesPositionDigest.find(n => n.nodeNum === segment.nodeNums[1]);
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

      return (
        <Polyline
          key={segment.key}
          positions={segment.positions}
          color={isMqttSegment ? themeColors.overlay0 : themeColors.mauve}
          weight={weight}
          opacity={isMqttSegment ? 0.6 : 0.7}
          dashArray={isMqttSegment ? '8, 8' : undefined}
        >
          <Popup>
            <div className="route-popup">
              <h4>Route Segment</h4>
              {isMqttSegment && (
                <div
                  className="mqtt-indicator"
                  style={{
                    display: 'inline-block',
                    backgroundColor: 'var(--ctp-overlay0)',
                    color: 'var(--ctp-base)',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    marginBottom: '8px',
                  }}
                >
                  via MQTT
                </div>
              )}
              <div className="route-endpoints">
                <strong
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
                  style={{
                    cursor: node1?.user?.id ? 'pointer' : 'default',
                    color: node1?.user?.id ? 'var(--ctp-blue)' : 'inherit',
                  }}
                  title={node1?.user?.id ? 'Click to select and center on this node' : ''}
                >
                  {node1Name}
                </strong>
                {' ↔ '}
                <strong
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
                  style={{
                    cursor: node2?.user?.id ? 'pointer' : 'default',
                    color: node2?.user?.id ? 'var(--ctp-blue)' : 'inherit',
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
                        <div className="snr-timeline-chart">
                          <ResponsiveContainer width="100%" height={150}>
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
                                label={{
                                  value: 'SNR (dB)',
                                  angle: -90,
                                  position: 'insideLeft',
                                  style: { fill: 'var(--ctp-subtext1)', fontSize: 10 },
                                }}
                              />
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: 'var(--ctp-surface0)',
                                  border: '1px solid var(--ctp-surface2)',
                                  borderRadius: '4px',
                                  fontSize: '12px',
                                }}
                                labelStyle={{ color: 'var(--ctp-text)' }}
                                labelFormatter={value => {
                                  const item = chartData!.find(d => d.timeDecimal === value);
                                  return item ? item.timeLabel : String(value);
                                }}
                              />
                              <Line
                                type="monotone"
                                dataKey="snr"
                                stroke="var(--ctp-mauve)"
                                strokeWidth={2}
                                dot={{ fill: 'var(--ctp-mauve)', r: 3 }}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Popup>
        </Polyline>
      );
    });

    // Add route segments to elements
    allElements.push(...segmentElements);

    return allElements;
  }, [showPaths, traceroutesDigest, nodesPositionDigest, distanceUnit, maxNodeAgeHours, themeColors.mauve, themeColors.overlay0, callbacks, visibleNodeNums]);

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
      const routeForward = JSON.parse(selectedTrace.route);
      const routeBack = JSON.parse(selectedTrace.routeBack);

      const fromNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.fromNodeNum);
      const toNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.toNodeNum);
      const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
      const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;

      // Forward path: responder -> requester
      if (routeForward.length >= 0) {
        const forwardSequence: number[] = [selectedTrace.fromNodeNum, ...routeForward, selectedTrace.toNodeNum];
        const forwardPositions: [number, number][] = [];

        forwardSequence.forEach(nodeNum => {
          const node = nodesPositionDigest.find(n => n.nodeNum === nodeNum);
          if (node?.position?.latitude && node?.position?.longitude) {
            forwardPositions.push([node.position.latitude, node.position.longitude]);
          }
        });

        if (forwardPositions.length >= 2) {
          // Calculate total distance for forward path
          let forwardTotalDistanceKm = 0;
          for (let i = 0; i < forwardSequence.length - 1; i++) {
            const node1 = nodesPositionDigest.find(n => n.nodeNum === forwardSequence[i]);
            const node2 = nodesPositionDigest.find(n => n.nodeNum === forwardSequence[i + 1]);
            if (
              node1?.position?.latitude &&
              node1?.position?.longitude &&
              node2?.position?.latitude &&
              node2?.position?.longitude
            ) {
              forwardTotalDistanceKm += calculateDistance(
                node1.position.latitude,
                node1.position.longitude,
                node2.position.latitude,
                node2.position.longitude
              );
            }
          }

          allElements.push(
            <Polyline
              key="selected-traceroute-forward"
              positions={forwardPositions}
              color={themeColors.red}
              weight={4}
              opacity={0.9}
              dashArray="10, 5"
            >
              <Popup>
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
                </div>
              </Popup>
            </Polyline>
          );

          // Generate arrow markers for forward path
          const forwardArrows = generateArrowMarkers(forwardPositions, 'forward', themeColors.red, allElements.length);
          allElements.push(...forwardArrows);
        }
      }

      // Return path: requester -> responder (using routeBack array)
      if (routeBack.length >= 0) {
        const backSequence: number[] = [selectedTrace.toNodeNum, ...routeBack, selectedTrace.fromNodeNum];
        const backPositions: [number, number][] = [];

        backSequence.forEach(nodeNum => {
          const node = nodesPositionDigest.find(n => n.nodeNum === nodeNum);
          if (node?.position?.latitude && node?.position?.longitude) {
            backPositions.push([node.position.latitude, node.position.longitude]);
          }
        });

        if (backPositions.length >= 2) {
          // Calculate total distance for back path
          let backTotalDistanceKm = 0;
          for (let i = 0; i < backSequence.length - 1; i++) {
            const node1 = nodesPositionDigest.find(n => n.nodeNum === backSequence[i]);
            const node2 = nodesPositionDigest.find(n => n.nodeNum === backSequence[i + 1]);
            if (
              node1?.position?.latitude &&
              node1?.position?.longitude &&
              node2?.position?.latitude &&
              node2?.position?.longitude
            ) {
              backTotalDistanceKm += calculateDistance(
                node1.position.latitude,
                node1.position.longitude,
                node2.position.latitude,
                node2.position.longitude
              );
            }
          }

          allElements.push(
            <Polyline
              key="selected-traceroute-back"
              positions={backPositions}
              color={themeColors.red}
              weight={4}
              opacity={0.9}
              dashArray="5, 10"
            >
              <Popup>
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
                </div>
              </Popup>
            </Polyline>
          );

          // Generate arrow markers for back path
          const backArrows = generateArrowMarkers(backPositions, 'back', themeColors.red, allElements.length);
          allElements.push(...backArrows);
        }
      }
    } catch (error) {
      logger.error('Error rendering selected node traceroute:', error);
    }

    return allElements.length > 0 ? allElements : null;
  }, [showRoute, selectedNodeId, traceroutesDigest, nodesPositionDigest, currentNodeId, distanceUnit, themeColors.red]);

  return {
    traceroutePathsElements,
    selectedNodeTraceroute,
  };
}
