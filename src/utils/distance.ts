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
  // Check if home node has valid position
  if (!homeNode?.position?.latitude || !homeNode?.position?.longitude) return null;
  // Check if target node has valid position
  if (!targetNode.position?.latitude || !targetNode.position?.longitude) return null;
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
