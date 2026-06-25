/**
 * "Null Island" filtering — issue #3763.
 *
 * Null Island is the point at 0°N, 0°E in the South Atlantic Ocean. GPS modules
 * emit (0, 0) as their default reading before acquiring a fix, and a stale (0, 0)
 * fix cached before a reboot can still be transmitted and stored. No real mesh
 * infrastructure exists there, so a coordinate at or near (0, 0) is treated as a
 * bogus position and filtered out before it is stored or rendered on the map.
 *
 * A small radius (rather than exact equality) is used because firmware rounding
 * or floating-point serialization can yield values like 0.000001 instead of
 * exactly 0.0, which an equality check would miss. ~0.001° is roughly 111 m at
 * the equator — well inside any realistic GPS error, and far from any deployment.
 */
export const NULL_ISLAND_EPSILON = 0.001;

/**
 * True when a coordinate is at or within {@link NULL_ISLAND_EPSILON} degrees of
 * Null Island (0, 0). Null/undefined inputs are not Null Island (there is no
 * position to reject), so callers should handle missing coordinates separately.
 */
export function isNullIsland(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (latitude == null || longitude == null) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return Math.abs(latitude) < NULL_ISLAND_EPSILON && Math.abs(longitude) < NULL_ISLAND_EPSILON;
}
