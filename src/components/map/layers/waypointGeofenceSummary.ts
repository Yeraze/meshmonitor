import type { Waypoint } from '../../../types/waypoint';

/** One line describing a waypoint's geofence, or null when it has none (#5922). */
export function geofenceSummary(wp: Waypoint): string | null {
  const parts: string[] = [];
  if (wp.geofenceRadiusM != null && wp.geofenceRadiusM > 0) {
    const r = wp.geofenceRadiusM;
    parts.push(r >= 1000 ? `${(r / 1000).toFixed(1)} km radius` : `${r} m radius`);
  }
  if (wp.boundingBox) parts.push('bounding box');
  if (parts.length === 0) return null;
  const alerts = [wp.notifyOnEnter && 'enter', wp.notifyOnExit && 'exit'].filter(Boolean);
  let line = `Geofence: ${parts.join(' + ')}`;
  if (alerts.length > 0) {
    line += `, alerts on ${alerts.join(' and ')}`;
    if (wp.notifyFavoritesOnly) line += ' (favourites only)';
  }
  return line;
}
