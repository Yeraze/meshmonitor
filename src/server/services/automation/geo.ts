/**
 * Geo helpers (#3653) — haversine distance + geofence transition logic.
 */

const R_KM = 6371;

/** Great-circle distance in km between two lat/lon points. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type GeofenceMode = 'enter' | 'exit' | 'dwell';

/**
 * Decide whether a geofence event fires given the node's previous and current
 * inside/outside state. `prevInside === undefined` is the baseline (first sighting)
 * and never fires — we only know a *transition* once we have a prior state.
 *   enter: outside → inside
 *   exit:  inside  → outside
 *   dwell: inside  → inside (moved while inside)
 */
export function geofenceFires(prevInside: boolean | undefined, nowInside: boolean, mode: GeofenceMode): boolean {
  if (prevInside === undefined) return false;
  switch (mode) {
    case 'enter': return !prevInside && nowInside;
    case 'exit': return prevInside && !nowInside;
    case 'dwell': return prevInside && nowInside;
    default: return false;
  }
}
