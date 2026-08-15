/**
 * Shared earth-model constants (#4727).
 *
 * These were duplicated three times — `distance.ts` (km, for Haversine),
 * `greatCircle.ts` (m, for direct geodesy) and `propagation.ts` (m, for earth
 * bulge). They agreed, but nothing made them agree, and a silent divergence
 * between the radius used to PLACE a coverage vertex and the radius used to
 * compute the curvature that decides whether that vertex is reachable would be
 * near-impossible to spot from the output.
 */

/** Mean earth radius, metres (IUGG mean radius, rounded). */
export const EARTH_RADIUS_M = 6_371_000;

/** Same value in kilometres, for callers working in km. */
export const EARTH_RADIUS_KM = EARTH_RADIUS_M / 1000;
