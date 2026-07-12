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
 * exactly 0.0, which an equality check would miss. It also catches integer
 * "garbage default" fixes: a Meshtastic position of latitudeI = longitudeI =
 * 2^15 (32768) serializes to 0.0032768°, and 2^16 to 0.0065536° — both are
 * bogus default readings that sit just outside a tighter radius. ~0.01° is
 * roughly 1.1 km at the equator: still absurdly tiny (Null Island is open ocean
 * in the Gulf of Guinea, ~600 km from the nearest land), and it only rejects a
 * coordinate near BOTH 0° lat AND 0° lng, so real prime-meridian/equator nodes
 * (whose other coordinate is far from 0) are never affected.
 */
export const NULL_ISLAND_EPSILON = 0.01;

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
