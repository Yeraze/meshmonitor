/**
 * Position metadata that goes with `latitude`/`longitude`: the #5578
 * `lastAdvertHadPosition` / `positionSource`, and the #5842 location
 * override fields (an override is a position too).
 */
const POSITION_META_KEYS = [
  'lastAdvertHadPosition',
  'positionSource',
  'positionIsOverride',
  'positionOverrideEnabled',
  'latitudeOverride',
  'longitudeOverride',
  'altitudeOverride',
  'positionOverrideIsPrivate',
] as const;

/**
 * Strip `latitude`/`longitude` (and the position metadata in
 * `POSITION_META_KEYS`) from a set of contact/node rows. Pure —
 * callers resolve the `viewOnMap` permission themselves (see
 * `maskContactPositionsForViewOnMap` for the single-array case, or resolve
 * once and call this directly when masking more than one array for the same
 * user/source, e.g. GET /snapshot's contacts + nodes).
 */
export function stripPositions<T extends { latitude?: number; longitude?: number }>(items: T[]): T[] {
  return items.map((item) => {
    const extra = item as Record<string, unknown>;
    if (
      item.latitude === undefined && item.longitude === undefined
      && POSITION_META_KEYS.every((k) => extra[k] === undefined)
    ) return item;
    const masked = { ...item } as Record<string, unknown>;
    delete masked.latitude;
    delete masked.longitude;
    // #5578: whether (and how) a node shares its position is position data too.
    for (const k of POSITION_META_KEYS) delete masked[k];
    return masked as T;
  });
}
