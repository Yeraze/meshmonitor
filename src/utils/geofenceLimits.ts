/**
 * Geofence shape limits shared by the editor (GeofenceMapEditor) and the
 * settings route that validates saved triggers. Lives under src/utils so the
 * server build includes it.
 */

/** Largest circle radius, in km: half the Earth's circumference covers any point. */
export const GEOFENCE_RADIUS_KM_MAX = 20037;
