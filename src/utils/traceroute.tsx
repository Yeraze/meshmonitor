import React from 'react';
import { DeviceInfo } from '../types/device';
import { calculateDistance, formatDistance } from './distance';

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
 * @param fromNum - Responder/remote node number (path starts here)
 * @param toNum - Requester/local node number (path ends here)
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

  try {
    const routeArray = JSON.parse(route);
    const snrArray = JSON.parse(snr || '[]');

    const pathElements: React.ReactNode[] = [];
    let totalDistanceKm = 0;

    // Build the complete path: fromNum -> intermediate hops -> toNum
    const fullPath = [fromNum, ...routeArray, toNum];

    fullPath.forEach((nodeNum, idx) => {
      if (typeof nodeNum !== 'number') return;

      const node = nodes.find(n => n.nodeNum === nodeNum);
      const nodeName = formatNodeName(nodeNum, nodes);

      // Get SNR for this hop (SNR array corresponds to hops between nodes)
      const snrValue = snrArray[idx] !== undefined ? snrArray[idx] : null;
      const snrDisplay = snrValue !== null ? ` (${snrValue} dB)` : '';

      // Check if this segment should be highlighted
      const isSegmentStart = options?.highlightSegment &&
        options.highlightNodeNum1 !== undefined &&
        options.highlightNodeNum2 !== undefined &&
        idx < fullPath.length - 1 && (
          (nodeNum === options.highlightNodeNum1 && fullPath[idx + 1] === options.highlightNodeNum2) ||
          (nodeNum === options.highlightNodeNum2 && fullPath[idx + 1] === options.highlightNodeNum1)
        );

      if (idx > 0) {
        pathElements.push(' → ');
      }

      // Highlight the segment if requested
      if (isSegmentStart) {
        const nextNodeName = formatNodeName(fullPath[idx + 1], nodes);
        const nextSnrValue = snrArray[idx + 1] !== undefined ? snrArray[idx + 1] : null;
        const nextSnrDisplay = nextSnrValue !== null ? ` (${nextSnrValue} dB)` : '';

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
            {nodeName}{snrDisplay} → {nextNodeName}{nextSnrDisplay}
          </span>
        );

        // Skip the next node since we just rendered it
        fullPath.splice(idx + 1, 1);
        snrArray.splice(idx + 1, 1);
      } else {
        pathElements.push(
          <span key={idx}>{nodeName}{snrDisplay}</span>
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
