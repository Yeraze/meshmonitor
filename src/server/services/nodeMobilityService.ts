/**
 * Node Mobility Service
 *
 * Extracted from DatabaseService.updateNodeMobilityAsync so the mobility
 * detection heuristic lives in one testable place, decoupled from the
 * database facade. A node is considered "mobile" when the bounding box of its
 * recent position history spans more than 100 meters.
 */
import type { TelemetryRepository } from '../../db/repositories/telemetry.js';
import type { NodesRepository } from '../../db/repositories/nodes.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import { logger } from '../../utils/logger.js';

export interface NodeMobilityDeps {
  telemetryRepo: TelemetryRepository;
  nodesRepo: NodesRepository;
  /**
   * Patch the in-memory node cache (if any) so subsequent sync reads reflect
   * the freshly-computed mobility flag. The `nodeId` is the string node id
   * (e.g. `!abcd1234`), matching how the cache stores node rows.
   */
  patchCache: (nodeId: string, mobile: number) => void;
}

/**
 * Detect whether a node has moved more than 100 meters based on its last 500
 * position telemetry records, update the persisted mobile flag, patch the
 * in-memory cache, and return the resulting mobility status (0 = stationary,
 * 1 = mobile). Errors are swallowed and reported as non-mobile (0).
 */
export async function updateNodeMobility(nodeId: string, deps: NodeMobilityDeps): Promise<number> {
  try {
    // Get last 500 position telemetry records for this node. Using a larger
    // limit ensures we capture movement over a longer time period (50 was too
    // small — nodes parked for a while would show only recent stationary
    // positions).
    // intentional cross-source: mobility check pools all sources' positions
    const positionTelemetry = await deps.telemetryRepo.getPositionTelemetryByNode(
      nodeId,
      500,
      undefined,
      ALL_SOURCES
    );

    const latitudes = positionTelemetry.filter((t) => t.telemetryType === 'latitude');
    const longitudes = positionTelemetry.filter((t) => t.telemetryType === 'longitude');

    let isMobile = 0;

    // Need at least 2 position records to detect movement
    if (latitudes.length >= 2 && longitudes.length >= 2) {
      const latValues = latitudes.map((t) => t.value);
      const lonValues = longitudes.map((t) => t.value);

      const minLat = Math.min(...latValues);
      const maxLat = Math.max(...latValues);
      const minLon = Math.min(...lonValues);
      const maxLon = Math.max(...lonValues);

      // Calculate distance between min/max corners using Haversine formula
      const R = 6371; // Earth's radius in km
      const dLat = ((maxLat - minLat) * Math.PI) / 180;
      const dLon = ((maxLon - minLon) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((minLat * Math.PI) / 180) *
          Math.cos((maxLat * Math.PI) / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      // If movement is greater than 100 meters (0.1 km), mark as mobile
      isMobile = distance > 0.1 ? 1 : 0;

      logger.debug(
        `📍 Node ${nodeId} mobility check: ${latitudes.length} positions, distance=${distance.toFixed(3)}km, mobile=${isMobile}`
      );
    }

    // Update the mobile flag in the database using the repository
    await deps.nodesRepo.updateNodeMobility(nodeId, isMobile);

    // Patch the in-memory cache so getAllNodes() returns the updated value
    deps.patchCache(nodeId, isMobile);

    return isMobile;
  } catch (error) {
    logger.error(`Failed to update mobility for node ${nodeId}:`, error);
    return 0; // Default to non-mobile on error
  }
}
