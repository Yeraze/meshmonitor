/**
 * Utility functions for detecting and handling overlapping map markers
 */

import { DeviceInfo } from '../types/device';

/**
 * Calculate if two coordinates are close enough to be considered overlapping
 * at a given zoom level. The threshold adapts based on zoom - higher zoom
 * requires markers to be closer to be considered overlapping.
 *
 * @param lat1 - Latitude of first point
 * @param lon1 - Longitude of first point
 * @param lat2 - Latitude of second point
 * @param lon2 - Longitude of second point
 * @param zoomLevel - Current map zoom level (1-20)
 * @returns true if coordinates are considered overlapping at this zoom
 */
export function areCoordinatesOverlapping(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  zoomLevel: number
): boolean {
  // Base threshold in degrees (roughly 50-100 pixels at zoom 10)
  // At zoom level 10: 1 degree ≈ 11132 km, so 0.001 degrees ≈ 11 meters
  const baseThreshold = 0.0005; // ~55 meters at equator

  // Adaptive threshold: decreases as zoom increases
  // At higher zoom, markers need to be closer to be considered overlapping
  // Formula: threshold = base / 2^(zoom - 10)
  // Zoom 8: threshold = base * 4 (wider overlap detection)
  // Zoom 10: threshold = base (default)
  // Zoom 13: threshold = base / 8 (tighter overlap detection)
  // Zoom 15: threshold = base / 32 (very tight)
  const zoomFactor = Math.pow(2, zoomLevel - 10);
  const threshold = baseThreshold / zoomFactor;

  // Simple distance calculation (good enough for small distances)
  const latDiff = Math.abs(lat1 - lat2);
  const lonDiff = Math.abs(lon1 - lon2);

  return latDiff < threshold && lonDiff < threshold;
}

/**
 * Group nodes by their position, identifying clusters of overlapping nodes
 *
 * @param nodes - Array of nodes with position data
 * @param zoomLevel - Current map zoom level
 * @returns Map of position keys to arrays of overlapping nodes
 */
export function groupOverlappingNodes(
  nodes: DeviceInfo[],
  zoomLevel: number
): Map<string, DeviceInfo[]> {
  const groups = new Map<string, DeviceInfo[]>();

  // Process each node
  for (const node of nodes) {
    if (!node.position?.latitude || !node.position?.longitude) {
      continue;
    }

    // Check if this node belongs to an existing group
    let foundGroup = false;
    for (const group of groups.values()) {
      const firstNode = group[0];
      if (
        firstNode.position?.latitude &&
        firstNode.position?.longitude &&
        areCoordinatesOverlapping(
          node.position.latitude,
          node.position.longitude,
          firstNode.position.latitude,
          firstNode.position.longitude,
          zoomLevel
        )
      ) {
        // Add to existing group
        group.push(node);
        foundGroup = true;
        break;
      }
    }

    // If not found in any group, create a new group
    if (!foundGroup) {
      const key = `${node.position.latitude.toFixed(6)}_${node.position.longitude.toFixed(6)}`;
      groups.set(key, [node]);
    }
  }

  return groups;
}

/**
 * Get statistics about overlapping nodes
 *
 * @param nodes - Array of nodes with position data
 * @param zoomLevel - Current map zoom level
 * @returns Statistics object
 */
export function getOverlapStatistics(
  nodes: DeviceInfo[],
  zoomLevel: number
): {
  totalNodes: number;
  overlappingGroups: number;
  largestGroup: number;
  nodesInOverlap: number;
} {
  const groups = groupOverlappingNodes(nodes, zoomLevel);

  let largestGroup = 0;
  let nodesInOverlap = 0;
  let overlappingGroups = 0;

  for (const group of groups.values()) {
    if (group.length > 1) {
      overlappingGroups++;
      nodesInOverlap += group.length;
      largestGroup = Math.max(largestGroup, group.length);
    }
  }

  return {
    totalNodes: nodes.length,
    overlappingGroups,
    largestGroup,
    nodesInOverlap,
  };
}
