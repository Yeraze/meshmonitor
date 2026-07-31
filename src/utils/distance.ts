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
 * Max deviation in metres implied by a Meshtastic position precision value.
 * Meshtastic encodes positions as int32 (1 unit = 1e-7 degrees). With N precision
 * bits, the lower (32-N) bits are zeroed, giving a grid cell of 2^(32-N) * 1e-7
 * degrees; half that cell is the furthest the true position can be from the
 * reported one.
 * @param bits Precision bits (1-31). Callers should gate on {@link hasAccuracyCell}.
 */
export function precisionBitsToAccuracyMeters(bits: number): number {
  const METERS_PER_DEGREE = 111111;
  // Half the grid cell size = max deviation from true position
  return Math.pow(2, 32 - bits) * 1e-7 * METERS_PER_DEGREE / 2;
}

/**
 * Format an uncertainty radius as a `±N unit` string, for showing how far a
 * displayed position may be from the true one (#4432).
 *
 * Sub-kilometre values render in metres/feet rather than a useless `±0.09 km`;
 * the unit argument only selects the metric or imperial ladder.
 *
 * Deliberately distinct from {@link formatPrecisionAccuracy}, which prefixes `~`:
 * this returns a hard bound ("the true position is within this radius"), whereas
 * `~` denotes a fuzzy approximation. Do not unify the two on the grounds that
 * they share a rounding ladder — the prefixes carry different claims.
 *
 * @param meters Radius in metres. Non-finite or non-positive input yields null.
 * @param unit 'km' for metric (m/km) or 'mi' for imperial (ft/mi)
 * @returns e.g. "±85 m", "±1.2 km", "±280 ft", "±0.8 mi" — or null if unknown
 */
export function formatUncertaintyRadius(
  meters: number | null | undefined,
  unit: 'km' | 'mi',
): string | null {
  if (meters == null || !Number.isFinite(meters) || meters <= 0) return null;

  const FEET_PER_METER = 3.28084;
  const FEET_PER_MILE = 5280;

  if (unit === 'mi') {
    const feet = meters * FEET_PER_METER;
    if (feet < FEET_PER_MILE / 10) return `±${Math.round(feet)} ft`;
    const miles = feet / FEET_PER_MILE;
    return miles < 10 ? `±${miles.toFixed(1)} mi` : `±${Math.round(miles)} mi`;
  }

  if (meters < 1000) return `±${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 10 ? `±${km.toFixed(1)} km` : `±${Math.round(km)} km`;
}

/**
 * Format a human-readable accuracy estimate for a given Meshtastic position precision value.
 * The accuracy shown is half the grid cell (max deviation from true position),
 * matching the values in the Meshtastic documentation.
 * @param bits Precision bits (0-32). 0 = disabled, 32 = full precision (~1 cm)
 * @param unit 'km' for metric (m/km) or 'mi' for imperial (ft/mi)
 * @returns Human-readable accuracy string like "~100 m", "~1.5 km", "~300 ft", "~2 mi"
 */
export function formatPrecisionAccuracy(bits: number, unit: 'km' | 'mi'): string {
  if (bits <= 0) return 'Disabled';

  const FEET_PER_METER = 3.28084;
  const FEET_PER_MILE = 5280;

  const accuracyMeters = precisionBitsToAccuracyMeters(bits);

  if (unit === 'mi') {
    const feet = accuracyMeters * FEET_PER_METER;
    if (feet < 1) {
      return '< 1 ft';
    }
    if (feet < FEET_PER_MILE / 10) { // 528ft = 0.1 mile
      return `~${Math.round(feet)} ft`;
    }
    const miles = feet / FEET_PER_MILE;
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
