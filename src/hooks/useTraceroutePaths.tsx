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
import { Popup } from 'react-leaflet';
import { DraggablePopup } from '../components/DraggablePopup';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { calculateDistance, formatDistance } from '../utils/distance';
import { getSegmentSnrOpacity, weightByUsage, tracerouteSegmentWeight, type SnrColorScale } from '../utils/mapHelpers';
import {
  parseSnapshotRoutePositions,
  resolveSegmentPosition,
  buildLiveNodePositionMap,
  decomposeTraceroute,
  hasReturnPath,
  isUnknownSnr,
  isValidRouteNode,
  averageNonSentinelSnr,
  type TracerouteRenderSegment,
} from '../utils/tracerouteSegments';
import { TraceroutePathsLayer } from '../components/map/layers/TraceroutePathsLayer';
import { darkOverlayColors } from '../config/overlayColors';
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
  snrColors?: SnrColorScale;
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
 * Fallback SNR color scale for the (structurally optional) `ThemeColors.snrColors`
 * field. In practice App.tsx always supplies a real scheme-derived scale
 * (`schemeColors.snrColors`); this only guards the type-level `undefined`
 * case so the shared `TraceroutePathsLayer`'s required `snrColors` prop
 * always has a value.
 */
const FALLBACK_SNR_COLORS: SnrColorScale = darkOverlayColors.snrColors;

// `isValidRouteNode` (reserved/broadcast node-number filtering) is imported
// from `tracerouteSegments.ts` — that's the single home; see its doc comment.
// #1862 snapshot parsing + snapshot-then-live position resolution likewise go
// through the shared `parseSnapshotRoutePositions`/`resolveSegmentPosition`/
// `buildLiveNodePositionMap` utils.

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
  // Shared live-node position map for the #1862 snapshot-then-live fallback,
  // built via the shared `buildLiveNodePositionMap` (also fixes the
  // lat/lng===0 falsy-zero bug on the live side, not just the snapshot side).
  const liveNodePositions = useMemo(
    () =>
      buildLiveNodePositionMap(nodesPositionDigest, (n) => ({
        nodeNum: n.nodeNum,
        lat: n.position?.latitude,
        lng: n.position?.longitude,
      })),
    [nodesPositionDigest],
  );

  // Memoize base traceroute paths (showPaths) - doesn't depend on selectedNodeId
  // This prevents re-rendering markers when clicking to select a node
  const traceroutePathsElements = useMemo(() => {
    if (!showPaths) return null;

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
      nodeNums: [number, number];
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

        // #1862 — snapshot positions via the shared util (fixes a
        // lat/lng===0 truthy-check bug in the old per-consumer copy).
        const snapshotPositions = parseSnapshotRoutePositions(tr.routePositions);
        const resolvePosition = (nodeNum: number): [number, number] | null =>
          resolveSegmentPosition(nodeNum, snapshotPositions, liveNodePositions);

        // Build forward path: responder -> route -> requester (fromNodeNum -> toNodeNum)
        const forwardSequence: number[] = [tr.fromNodeNum, ...routeForward, tr.toNodeNum];
        const forwardPositions: Array<{ nodeNum: number; pos: [number, number] }> = [];

        // Build forward sequence with positions (prefer snapshot positions)
        forwardSequence.forEach(nodeNum => {
          const pos = resolvePosition(nodeNum);
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
          const pos = resolvePosition(nodeNum);
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

    // Build shared render segments, carrying each occurrence's hop node
    // numbers directly on the segment (`fromNodeNum`/`toNodeNum`) so the
    // popup/className below can read them straight off `seg` instead of a
    // side-table lookup.
    const renderSegments: TracerouteRenderSegment[] = filteredSegments.map(segment => {
      const segmentKey = segment.nodeNums.slice().sort().join('-');
      const usage = segmentUsage.get(segmentKey) || 1;
      // A segment is MQTT/IP only when the firmware reported the unknown-SNR
      // sentinel for that specific hop (issue #2931). Don't infer from
      // `node.viaMqtt` — that flag tracks how the node's own NodeInfo last
      // reached us, not how its radio segments work; a single MQTT/UDP
      // bridge node would otherwise mark every adjacent segment as IP and
      // cascade the dashed style across an entire route that's actually
      // mostly radio.
      const isMqttSegment = segmentHasMqtt.get(segmentKey) === true;
      const snrSamples = segmentSNRs.get(segmentKey) || [];
      const avgSnr = averageNonSentinelSnr(snrSamples);
      const latestTimestamp = segmentLatestTimestamp.get(segmentKey);

      return {
        key: segment.key,
        from: segment.positions[0],
        to: segment.positions[1],
        fromNodeNum: segment.nodeNums[0],
        toNodeNum: segment.nodeNums[1],
        // Aggregated bidirectionally across (possibly many) traceroutes —
        // not a single forward/return leg, so 'neutral' (curvature 0 either
        // way for this layer, per the consumer table).
        leg: 'neutral',
        avgSnr,
        isMqtt: isMqttSegment,
        usageCount: usage,
        timestamp: latestTimestamp,
        snrSamples,
      };
    });

    // O(1) node lookup by nodeNum for the popup render-prop below, built
    // once per memo recomputation instead of a linear `.find()` per segment.
    const nodeByNum = new Map<number, NodePositionDigest>();
    for (const n of nodesPositionDigest) nodeByNum.set(n.nodeNum, n);

    // Popup content (recharts SegmentSnrChart moves in verbatim) — a single
    // render-prop reading hop identity straight off the segment.
    const renderBasePopup = (seg: TracerouteRenderSegment): React.ReactNode => {
      const nodeNum1 = seg.fromNodeNum;
      const nodeNum2 = seg.toNodeNum;
      const segmentKey = [nodeNum1, nodeNum2].sort().join('-');
      const usage = segmentUsage.get(segmentKey) || 1;
      const node1 = nodeByNum.get(nodeNum1);
      const node2 = nodeByNum.get(nodeNum2);
      const isMqttSegment = seg.isMqtt;
      const node1Name =
        nodeNum1 === BROADCAST_ADDR
          ? '(unknown)'
          : node1?.user?.longName || node1?.user?.shortName || `!${nodeNum1.toString(16)}`;
      const node2Name =
        nodeNum2 === BROADCAST_ADDR
          ? '(unknown)'
          : node2?.user?.longName || node2?.user?.shortName || `!${nodeNum2.toString(16)}`;

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
      const snrData = seg.snrSamples ?? [];
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

        // Prepare chart data for 3+ samples (sorted by time of day). Every
        // base-layer sample is pushed with a timestamp (see the aggregation
        // loop above) — the `?? 0` only satisfies `snrSamples`' structurally
        // optional `timestamp` field (shared across all `TracerouteRenderSegment`
        // consumers, some of which don't always have one).
        if (snrData.length >= 3) {
          chartData = snrData
            .map(d => {
              const ts = d.timestamp ?? 0;
              const date = new Date(ts);
              const hours = date.getHours();
              const minutes = date.getMinutes();
              // Convert to decimal hours (0-24) for continuous time axis
              const timeDecimal = hours + minutes / 60;
              return {
                timeDecimal,
                timeLabel: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
                snr: parseFloat(d.snr.toFixed(1)),
                fullTimestamp: ts,
              };
            })
            .sort((a, b) => a.timeDecimal - b.timeDecimal);
        }
      }

      return (
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
                  const freshNode = nodesPositionDigest.find(n => n.nodeNum === nodeNum1);
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
                  const freshNode = nodesPositionDigest.find(n => n.nodeNum === nodeNum2);
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
                  callbacks.onSelectRouteSegment(nodeNum1, nodeNum2);
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
      );
    };

    const baseSegmentClassName = (seg: TracerouteRenderSegment): string =>
      `route-segment node-${seg.fromNodeNum} node-${seg.toNodeNum}`;

    return [
      <TraceroutePathsLayer
        key="base-traceroute-layer"
        segments={renderSegments}
        snrColors={themeColors.snrColors ?? FALLBACK_SNR_COLORS}
        colorMode="snr"
        mqttColor={themeColors.mqttSegment ?? themeColors.overlay0}
        curvature={0}
        weight={seg => weightByUsage(seg.usageCount ?? 1)}
        opacity={seg => getSegmentSnrOpacity(seg.snrSamples, seg.isMqtt)}
        dashMode="mqtt-unknown"
        temporalFade
        renderPopup={renderBasePopup}
        segmentClassName={baseSegmentClassName}
      />,
    ];
  }, [showPaths, traceroutesDigest, nodesPositionDigest, distanceUnit, maxNodeAgeHours, themeColors.snrColors, themeColors.mqttSegment, themeColors.overlay0, callbacks, visibleNodeNums, mapZoom, liveNodePositions]);

  // Separate memoization for selected node traceroute (showRoute)
  // This can change independently without re-rendering the base map markers
  const selectedNodeTraceroute = useMemo(() => {
    // Skip rendering traceroute if the selected node is the current/local node
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );

    if (!selectedTrace) return null;

    try {
      // Route arrays are stored exactly as Meshtastic provides them (no
      // backend reversal). `decomposeTraceroute` filters reserved/broadcast
      // placeholder node numbers out of the route internally, so the raw
      // JSON is passed straight through.
      //
      // #1862 — snapshot positions via the shared util.
      const snapshotPositions = parseSnapshotRoutePositions(selectedTrace.routePositions);
      const resolvePosition = (nodeNum: number): [number, number] | null =>
        resolveSegmentPosition(nodeNum, snapshotPositions, liveNodePositions);

      // #1862/#2051/#2931 — per-traceroute decomposition (shared util). The
      // forward and return legs are gated independently: `route` gates the
      // forward leg, `hasReturnPath` gates the return leg (#2051) — a
      // traceroute can render one leg without the other.
      const segments = decomposeTraceroute(
        {
          fromNodeNum: selectedTrace.fromNodeNum,
          toNodeNum: selectedTrace.toNodeNum,
          route: selectedTrace.route,
          routeBack: selectedTrace.routeBack,
          snrTowards: selectedTrace.snrTowards,
          snrBack: selectedTrace.snrBack,
          timestamp: selectedTrace.timestamp,
          createdAt: selectedTrace.createdAt,
        },
        { resolvePosition }
      );

      if (segments.length === 0) return null;

      const fromNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.fromNodeNum);
      const toNode = nodesPositionDigest.find(n => n.nodeNum === selectedTrace.toNodeNum);
      const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
      const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;

      const nameForNode = (num: number): string => {
        const n = nodesPositionDigest.find(nd => nd.nodeNum === num);
        return n?.user?.longName || n?.user?.shortName || `!${num.toString(16)}`;
      };

      // Leg-level popup metadata (distance, path listing) — computed once per
      // leg and reused across all of that leg's per-hop popups, matching the
      // pre-existing behavior where these were leg-level constants reused
      // inside the per-hop render loop.
      const legDistanceKm = (leg: 'forward' | 'return'): number =>
        segments
          .filter(s => s.leg === leg)
          .reduce((sum, s) => sum + calculateDistance(s.from[0], s.from[1], s.to[0], s.to[1]), 0);

      const legPathLabel = (leg: 'forward' | 'return'): string => {
        const legSegments = segments.filter(s => s.leg === leg);
        if (legSegments.length === 0) return '';
        // Reconstruct the hop sequence directly from each segment's
        // fromNodeNum/toNodeNum (segments are in traversal order).
        const nums: number[] = [];
        legSegments.forEach((s, i) => {
          if (i === 0) nums.push(s.fromNodeNum);
          nums.push(s.toNodeNum);
        });
        return nums.map(nameForNode).join(' → ');
      };

      const forwardDistanceKm = legDistanceKm('forward');
      const backDistanceKm = legDistanceKm('return');
      const forwardPathLabel = legPathLabel('forward');
      const backPathLabel = legPathLabel('return');

      const renderSelectedPopup = (seg: TracerouteRenderSegment): React.ReactNode => {
        const isForward = seg.leg === 'forward';
        const legDistance = isForward ? forwardDistanceKm : backDistanceKm;
        return (
          <DraggablePopup>
            <div className="route-popup">
              <h4>{isForward ? 'Forward Path' : 'Return Path'}</h4>
              <div className="route-endpoints">
                {isForward ? (
                  <><strong>{fromName}</strong> → <strong>{toName}</strong></>
                ) : (
                  <><strong>{toName}</strong> → <strong>{fromName}</strong></>
                )}
              </div>
              <div className="route-usage">
                Path:{' '}{isForward ? forwardPathLabel : backPathLabel}
              </div>
              {legDistance > 0 && (
                <div className="route-usage">
                  Distance: <strong>{formatDistance(legDistance, distanceUnit)}</strong>
                </div>
              )}
              {(seg.avgSnr !== null || seg.isMqtt) && (
                <div className="route-usage" style={{ marginTop: '8px', borderTop: '1px solid var(--ctp-surface0)', paddingTop: '4px' }}>
                  Segment SNR: <strong>{seg.avgSnr !== null ? `${seg.avgSnr.toFixed(1)} dB` : 'Unknown'}</strong>
                  {seg.isMqtt && ' (IP)'}
                </div>
              )}
            </div>
          </DraggablePopup>
        );
      };

      return [
        <TraceroutePathsLayer
          key="selected-traceroute-layer"
          segments={segments}
          snrColors={themeColors.snrColors ?? FALLBACK_SNR_COLORS}
          colorMode="fixed-leg"
          legColors={{
            forward: themeColors.tracerouteForward ?? themeColors.blue,
            return: themeColors.tracerouteReturn ?? themeColors.red,
          }}
          curvature={0.2}
          weight={tracerouteSegmentWeight}
          opacity={0.9}
          dashMode="mqtt-unknown"
          showArrows
          renderPopup={renderSelectedPopup}
        />,
      ];
    } catch (error) {
      logger.error('Error rendering selected node traceroute:', error);
      return null;
    }
  }, [showRoute, selectedNodeId, traceroutesDigest, nodesPositionDigest, currentNodeId, distanceUnit, themeColors.red, themeColors.blue, themeColors.tracerouteForward, themeColors.tracerouteReturn, themeColors.snrColors, liveNodePositions]);

  // Compute the set of node numbers involved in the selected traceroute.
  // Used for filtering map markers to only show nodes in the active
  // traceroute. Guards/semantics mirror the selectedNodeTraceroute memo
  // above: forward and return legs are gated independently (a return-only
  // traceroute — empty `route`, populated `routeBack`/`snrBack` — still
  // frames/filters its return-leg nodes, matching that it still renders
  // return segments), so the marker filter always covers exactly the nodes
  // whose segments the shared layer actually draws.
  const tracerouteNodeNums = useMemo(() => {
    // Only compute when showRoute is enabled and there's a selected node
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );

    if (!selectedTrace) return null;

    const hasForwardRoute =
      !!selectedTrace.route && selectedTrace.route !== 'null' && selectedTrace.route !== '';

    try {
      let rawRouteBack: unknown = [];
      if (selectedTrace.routeBack && selectedTrace.routeBack !== 'null' && selectedTrace.routeBack !== '') {
        rawRouteBack = JSON.parse(selectedTrace.routeBack);
      }
      const routeBack = (Array.isArray(rawRouteBack) ? rawRouteBack : []).filter(isValidRouteNode);
      const hasReturn = hasReturnPath(routeBack, selectedTrace.snrBack);

      // Neither leg has data — decomposeTraceroute would render nothing.
      if (!hasForwardRoute && !hasReturn) return null;

      const nodeNums = new Set<number>();
      nodeNums.add(selectedTrace.fromNodeNum);
      nodeNums.add(selectedTrace.toNodeNum);

      if (hasForwardRoute) {
        const rawRouteForward = JSON.parse(selectedTrace.route);
        const routeForward = (Array.isArray(rawRouteForward) ? rawRouteForward : []).filter(isValidRouteNode);
        routeForward.forEach((num: number) => nodeNums.add(num));
      }

      if (hasReturn) {
        routeBack.forEach((num: number) => nodeNums.add(num));
      }

      return nodeNums.size > 0 ? nodeNums : null;
    } catch (error) {
      logger.error('Error computing traceroute node numbers:', error);
      return null;
    }
  }, [showRoute, selectedNodeId, currentNodeId, traceroutesDigest]);

  // Compute bounding box of the selected traceroute for zoom-to-fit.
  // Position resolution goes through the shared snapshot-then-live utils
  // (typeof-based #1862 snapshot checks) — the same resolution the rendered
  // segments use — so zoom-to-fit frames exactly what is drawn.
  const tracerouteBounds = useMemo((): [[number, number], [number, number]] | null => {
    if (!tracerouteNodeNums || tracerouteNodeNums.size === 0) return null;

    // Parse snapshot positions from the selected traceroute (#1862, shared util)
    const selectedTrace = traceroutesDigest.find(
      tr => tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
    );
    const snapshotPositions = parseSnapshotRoutePositions(selectedTrace?.routePositions);

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let hasValidPositions = false;

    tracerouteNodeNums.forEach(nodeNum => {
      const pos = resolveSegmentPosition(nodeNum, snapshotPositions, liveNodePositions);
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
  }, [tracerouteNodeNums, liveNodePositions, traceroutesDigest, selectedNodeId]);

  return {
    traceroutePathsElements,
    selectedNodeTraceroute,
    tracerouteNodeNums,
    tracerouteBounds,
  };
}
