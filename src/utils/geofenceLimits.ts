/**
 * Geofence shape limits shared by the editor (GeofenceMapEditor) and the
 * settings route that validates saved triggers. Lives under src/utils so the
 * server build includes it.
 */

/**
 * Largest circle radius, in km: half the Earth's circumference on the 6371 km
 * sphere Leaflet measures with (π × 6371 ≈ 20015.09), so a circle this size
 * already covers every point. It is also the farthest a map drag can reach, so
 * the drag clamp and the typed-value clamp agree.
 */
export const GEOFENCE_RADIUS_KM_MAX = 20015;
