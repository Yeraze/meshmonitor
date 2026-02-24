import React from 'react';
import { DeviceInfo } from '../types/device';
import { calculateDistance, formatDistance } from './distance';

/**
 * INT8_MIN (-128) is the Meshtastic sentinel value for unknown SNR.
 * This is used for MQTT gateways, older firmware, or nodes that couldn't decrypt.
 * When scaled by 4 (as stored in protobuf), this becomes -32 dB.
 */
const INT8_MIN_SNR = -128;

/**
 * Formats SNR value for display, showing "MQTT" for unknown/MQTT links
 */
function formatSnrDisplay(snrValue: number | null): string {
  if (snrValue === null) return '';
  // INT8_MIN (-128) indicates unknown SNR (MQTT gateway, old firmware, etc.)
  if (snrValue === INT8_MIN_SNR) {
    return ' (MQTT)';
  }
  return ` (${(snrValue / 4).toFixed(1)} dB)`;
}

/**
 * Formats SNR value for display as a React element, with MQTT styling
 */
function formatSnrElement(snrValue: number | null, key: string): React.ReactNode {
  if (snrValue === null) return null;
  // INT8_MIN (-128) indicates unknown SNR (MQTT gateway, old firmware, etc.)
  if (snrValue === INT8_MIN_SNR) {
    return (
      <span
        key={key}
        style={{
          marginLeft: '0.25rem',
          padding: '0.1rem 0.3rem',
          backgroundColor: 'var(--ctp-overlay0)',
          color: 'var(--ctp-text)',
          borderRadius: '3px',
          fontSize: '0.85em',
          fontWeight: 500,
        }}
      >
        MQTT
      </span>
    );
  }
  return ` (${(snrValue / 4).toFixed(1)} dB)`;
}

/**
 * Formats a node name as "Longname [Shortname]" when both are present and different,
 * otherwise returns the available name or hex ID.
 *
 * @param nodeNum - The node number to format
 * @param nodes - Array of all device information
 * @returns Formatted node name string
 */
export function formatNodeName(nodeNum: number, nodes: DeviceInfo[]): string {
  const node = nodes.find(n => n.nodeNum === nodeNum);
  const longName = node?.user?.longName;
  const shortName = node?.user?.shortName;

  if (longName && shortName && longName !== shortName) {
    return `${longName} [${shortName}]`;
  } else if (longName) {
    return longName;
  } else if (shortName) {
    return shortName;
  }
  return `!${nodeNum.toString(16)}`;
}

/**
 * Formats a traceroute path with node names, SNR values, and optional distance calculation.
 *
 * **IMPORTANT DATA MODEL:**
 * - `fromNum` = Responder/remote node (where the traceroute response came from)
 * - `toNum` = Requester/local node (where the traceroute was initiated)
 * - `route` = Array of intermediate node numbers
 * - `snr` = Array of SNR values corresponding to each node in the path
 *
 * **PARAMETER ORDER FOR TRACEROUTE DISPLAY:**
 * - Forward path: `formatTracerouteRoute(tr.route, tr.snrTowards, tr.fromNodeNum, tr.toNodeNum, ...)`
 * - Return path: `formatTracerouteRoute(tr.routeBack, tr.snrBack, tr.toNodeNum, tr.fromNodeNum, ...)`
 *
 * **PATH BUILDING:**
 * This builds the path as: [fromNum, ...route, toNum]
 *
 * @param route - JSON string of intermediate node numbers, or null if failed
 * @param snr - JSON string of SNR values for each hop, or null
 * @param fromNum - Starting node number (path starts here)
 * @param toNum - Ending node number (path ends here)
 * @param nodes - Array of all device information
 * @param distanceUnit - Unit for distance display ('km', 'mi', 'nm')
 * @param options - Optional configuration for highlighting and segment selection
 * @returns React node with formatted route path
 */
export function formatTracerouteRoute(
  route: string | null,
  snr: string | null,
  fromNum: number,
  toNum: number,
  nodes: DeviceInfo[],
  distanceUnit: 'km' | 'mi' | 'nm' = 'km',
  options?: {
    highlightSegment?: boolean;
    highlightNodeNum1?: number;
    highlightNodeNum2?: number;
  }
): React.ReactNode {
  // Handle pending/null routes (failed traceroute)
  if (!route || route === 'null') {
    return '(No response received)';
  }

  // Filter function to remove invalid/reserved node numbers from route arrays
  const BROADCAST_ADDR = 4294967295;
  const isValidRouteNode = (nodeNum: number): boolean => {
    if (nodeNum <= 3) return false;  // Reserved
    if (nodeNum === 255) return false;  // 0xff reserved
    if (nodeNum === 65535) return false;  // 0xffff invalid placeholder
    if (nodeNum === BROADCAST_ADDR) return false;  // Broadcast
    return true;
  };

  try {
    const rawRouteArray = JSON.parse(route);
    const rawSnrArray = JSON.parse(snr || '[]');

    // Filter out invalid node numbers and keep SNR values in sync
    const routeArray: number[] = [];
    const snrArray: number[] = [];
    rawRouteArray.forEach((nodeNum: number, idx: number) => {
      if (isValidRouteNode(nodeNum)) {
        routeArray.push(nodeNum);
        if (rawSnrArray[idx] !== undefined) {
          snrArray.push(rawSnrArray[idx]);
        }
      }
    });
    // Add the final hop SNR if present
    if (rawSnrArray.length > rawRouteArray.length) {
      snrArray.push(rawSnrArray[rawRouteArray.length]);
    }

    const pathElements: React.ReactNode[] = [];
    let totalDistanceKm = 0;

    // Build the complete path: fromNum -> intermediate hops -> toNum
    const fullPath = [fromNum, ...routeArray, toNum];

    // Track which indices have been rendered (for skipping highlighted segments)
    const renderedIndices = new Set<number>();

    fullPath.forEach((nodeNum, idx) => {
      if (typeof nodeNum !== 'number') return;

      // Skip if this node was already rendered as part of a highlighted segment
      if (renderedIndices.has(idx)) return;

      const node = nodes.find(n => n.nodeNum === nodeNum);
      const nodeName = formatNodeName(nodeNum, nodes);

      // Get SNR for this hop (SNR array corresponds to hops between nodes)
      const snrValue = snrArray[idx] !== undefined ? snrArray[idx] : null;

      // Check if this segment should be highlighted
      const isSegmentStart = options?.highlightSegment &&
        options.highlightNodeNum1 !== undefined &&
        options.highlightNodeNum2 !== undefined &&
        idx < fullPath.length - 1 && (
          (nodeNum === options.highlightNodeNum1 && fullPath[idx + 1] === options.highlightNodeNum2) ||
          (nodeNum === options.highlightNodeNum2 && fullPath[idx + 1] === options.highlightNodeNum1)
        );

      if (idx > 0 && !renderedIndices.has(idx - 1)) {
        pathElements.push(' → ');
      }

      // Highlight the segment if requested
      if (isSegmentStart) {
        const nextNodeName = formatNodeName(fullPath[idx + 1], nodes);
        const nextSnrValue = snrArray[idx + 1] !== undefined ? snrArray[idx + 1] : null;

        pathElements.push(
          <span
            key={`highlight-${idx}`}
            style={{
              background: 'var(--ctp-yellow)',
              color: 'var(--ctp-base)',
              padding: '0.1rem 0.3rem',
              borderRadius: '3px',
              fontWeight: 'bold'
            }}
          >
            {nodeName}{formatSnrDisplay(snrValue)} → {nextNodeName}{formatSnrDisplay(nextSnrValue)}
          </span>
        );

        // Mark the next node as rendered so we skip it in the loop
        renderedIndices.add(idx + 1);
      } else {
        pathElements.push(
          <React.Fragment key={idx}>
            <span>{nodeName}</span>
            {formatSnrElement(snrValue, `snr-${idx}`)}
          </React.Fragment>
        );
      }

      // Calculate distance to next node if positions are available
      if (idx < fullPath.length - 1) {
        const nextNodeNum = fullPath[idx + 1];
        const nextNode = nodes.find(n => n.nodeNum === nextNodeNum);

        if (node?.position?.latitude && node?.position?.longitude &&
            nextNode?.position?.latitude && nextNode?.position?.longitude) {
          const segmentDistanceKm = calculateDistance(
            node.position.latitude,
            node.position.longitude,
            nextNode.position.latitude,
            nextNode.position.longitude
          );
          totalDistanceKm += segmentDistanceKm;
        }
      }
    });

    // formatDistance only supports 'km' | 'mi', so default 'nm' to 'km'
    const effectiveDistanceUnit: 'km' | 'mi' = distanceUnit === 'nm' ? 'km' : distanceUnit;
    const distanceStr = totalDistanceKm > 0 ? ` [${formatDistance(totalDistanceKm, effectiveDistanceUnit)}]` : '';

    return (
      <>
        {pathElements}
        {distanceStr}
      </>
    );
  } catch (error) {
    console.error('Error formatting traceroute:', error);
    return 'Error parsing route';
  }
}
