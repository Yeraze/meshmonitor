export type LatLng = [number, number];

/** Arithmetic mean of the points, or null for an empty set (Follow target). */
export function averageLatLng(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let lat = 0, lng = 0;
  for (const [a, b] of points) { lat += a; lng += b; }
  return [lat / points.length, lng / points.length];
}

export const AUTOZOOM_PAD = 0.15;

export type FitPlan =
  | { kind: 'none' }                              // empty selection ⇒ no-op
  | { kind: 'single'; center: LatLng }            // 1 point OR all-coincident ⇒ center @ current zoom
  | { kind: 'multi'; bounds: [LatLng, LatLng] };  // padded [SW, NE] for fitBounds

/** Classify the auto-zoom action for a set of points (pad defaults to 15%). */
export function planAutoZoom(points: LatLng[], pad: number = AUTOZOOM_PAD): FitPlan {
  if (points.length === 0) return { kind: 'none' };
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  // 1 point, or every point identical ⇒ no meaningful box: center, don't zoom-to-max.
  if (minLat === maxLat && minLng === maxLng) return { kind: 'single', center: [minLat, minLng] };
  const dLat = (maxLat - minLat) * pad;
  const dLng = (maxLng - minLng) * pad;
  return { kind: 'multi', bounds: [[minLat - dLat, minLng - dLng], [maxLat + dLat, maxLng + dLng]] };
}
