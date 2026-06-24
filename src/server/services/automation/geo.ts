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
 * Geofence region shape. Mirrors the frontend `GeofenceShape` union
 * (`src/components/auto-responder/types.ts`) but is declared locally so server
 * code does not depend on `src/components/**`. Circle = center + radius;
 * polygon = ordered ring of vertices.
 */
export type GeofenceShape =
  | { type: 'circle'; center: { lat: number; lng: number }; radiusKm: number }
  | { type: 'polygon'; vertices: Array<{ lat: number; lng: number }> };

/** Point-in-polygon via ray casting (mirrors `src/utils/geometry.ts`). */
export function pointInPolygon(lat: number, lon: number, vertices: Array<{ lat: number; lng: number }>): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].lng, yi = vertices[i].lat;
    const xj = vertices[j].lng, yj = vertices[j].lat;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** True when (lat, lon) is inside the shape — haversine for circles, ray-cast for polygons. */
export function pointInShape(lat: number, lon: number, shape: GeofenceShape): boolean {
  if (shape.type === 'circle') {
    return haversineKm(lat, lon, shape.center.lat, shape.center.lng) <= shape.radiusKm;
  }
  return pointInPolygon(lat, lon, shape.vertices);
}

/** Reference point of a shape — the circle center, or the polygon's centroid. */
export function geofenceCenter(shape: GeofenceShape): { lat: number; lng: number } {
  if (shape.type === 'circle') return { lat: shape.center.lat, lng: shape.center.lng };
  const n = shape.vertices.length;
  if (n === 0) return { lat: 0, lng: 0 };
  let latSum = 0, lngSum = 0;
  for (const v of shape.vertices) { latSum += v.lat; lngSum += v.lng; }
  return { lat: latSum / n, lng: lngSum / n };
}

/**
 * Resolve a geofence trigger's params into a `GeofenceShape`, or null if it
 * defines no usable region. Prefers a structured `params.shape` (circle or
 * polygon); falls back to legacy flat `lat`/`lon`/`radiusKm` → a circle so
 * automations saved before the map editor keep working.
 */
export function normalizeGeofenceParams(params: Record<string, unknown>): GeofenceShape | null {
  const raw = params?.shape;
  if (raw && typeof raw === 'object') {
    const s = raw as Record<string, unknown>;
    if (s.type === 'polygon' && Array.isArray(s.vertices)) {
      const vertices = (s.vertices as Array<{ lat?: unknown; lng?: unknown }>)
        .map((v) => ({ lat: Number(v?.lat), lng: Number(v?.lng) }))
        .filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
      if (vertices.length >= 3) return { type: 'polygon', vertices };
    } else if (s.type === 'circle' && s.center && typeof s.center === 'object') {
      const c = s.center as { lat?: unknown; lng?: unknown };
      const lat = Number(c.lat), lng = Number(c.lng), radiusKm = Number(s.radiusKm);
      if ([lat, lng, radiusKm].every(Number.isFinite) && radiusKm > 0) return { type: 'circle', center: { lat, lng }, radiusKm };
    }
  }
  const lat = Number(params?.lat), lng = Number(params?.lon), radiusKm = Number(params?.radiusKm);
  if ([lat, lng, radiusKm].every(Number.isFinite) && radiusKm > 0) return { type: 'circle', center: { lat, lng }, radiusKm };
  return null;
}

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
