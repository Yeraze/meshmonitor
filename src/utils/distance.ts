/**
 * Distance calculation utilities for Meshtastic nodes
 */

/**
 * Calculate the great circle distance between two points on Earth using the Haversine formula
 * @param lat1 Latitude of point 1 in degrees
 * @param lon1 Longitude of point 1 in degrees
 * @param lat2 Latitude of point 2 in degrees
 * @param lon2 Longitude of point 2 in degrees
 * @returns Distance in kilometers
 */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Convert kilometers to miles
 */
export function kmToMiles(km: number): number {
  return km * 0.621371;
}

/**
 * Format distance for display based on user preference
 * @param km Distance in kilometers
 * @param unit 'km' or 'mi'
 * @param decimals Number of decimal places (default: 1)
 * @returns Formatted string with unit
 */
export function formatDistance(km: number, unit: 'km' | 'mi' = 'km', decimals: number = 1): string {
  if (unit === 'mi') {
    const miles = kmToMiles(km);
    return `${miles.toFixed(decimals)} mi`;
  }
  return `${km.toFixed(decimals)} km`;
}

/**
 * Node position interface for distance calculations
 */
interface NodeWithPosition {
  user?: { id?: string };
  position?: {
    latitude?: number;
    longitude?: number;
  };
}

/**
 * Calculate and format distance from home node to target node
 * @param homeNode The home/local node with position data
 * @param targetNode The target node to calculate distance to
 * @param unit Distance unit preference ('km' or 'mi')
 * @returns Formatted distance string or null if positions unavailable
 */
export function getDistanceToNode(
  homeNode: NodeWithPosition | undefined,
  targetNode: NodeWithPosition,
  unit: 'km' | 'mi'
): string | null {
  // Check if home node has valid position (use != null to allow 0 coordinates)
  if (homeNode?.position?.latitude == null || homeNode?.position?.longitude == null) return null;
  // Check if target node has valid position
  if (targetNode.position?.latitude == null || targetNode.position?.longitude == null) return null;
  // Don't show distance to self
  if (homeNode.user?.id && homeNode.user.id === targetNode.user?.id) return null;

  const km = calculateDistance(
    homeNode.position.latitude,
    homeNode.position.longitude,
    targetNode.position.latitude,
    targetNode.position.longitude
  );
  return formatDistance(km, unit);
}

/**
 * Format a human-readable accuracy estimate for a given Meshtastic position precision value.
 * Meshtastic encodes positions as int32 (1 unit = 1e-7 degrees). With N precision bits,
 * the lower (32-N) bits are zeroed, so resolution = 2^(32-N) * 1e-7 degrees.
 * @param bits Precision bits (0-32). 0 = disabled, 32 = full precision (~1 cm)
 * @param unit 'km' for metric (m/km) or 'mi' for imperial (ft/mi)
 * @returns Human-readable accuracy string like "~100 m", "~1.5 km", "~300 ft", "~2 mi"
 */
export function formatPrecisionAccuracy(bits: number, unit: 'km' | 'mi'): string {
  if (bits <= 0) return 'Disabled';
  const accuracyMeters = Math.pow(2, 32 - bits) * 1e-7 * 111320;

  if (unit === 'mi') {
    const feet = accuracyMeters * 3.28084;
    if (feet < 1) {
      return '< 1 ft';
    }
    if (feet < 528) {
      return `~${Math.round(feet)} ft`;
    }
    const miles = feet / 5280;
    if (miles < 10) {
      return `~${miles.toFixed(1)} mi`;
    }
    return `~${Math.round(miles)} mi`;
  }

  // Metric
  if (accuracyMeters < 1) {
    return '< 1 m';
  }
  if (accuracyMeters < 1000) {
    return `~${Math.round(accuracyMeters)} m`;
  }
  const km = accuracyMeters / 1000;
  if (km < 10) {
    return `~${km.toFixed(1)} km`;
  }
  return `~${Math.round(km)} km`;
}
