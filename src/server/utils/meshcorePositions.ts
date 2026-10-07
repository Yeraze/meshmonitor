/**
 * Strip `latitude`/`longitude` (and the #5578 `lastAdvertHadPosition` /
 * `positionSource` position metadata) from a set of contact/node rows. Pure —
 * callers resolve the `viewOnMap` permission themselves (see
 * `maskContactPositionsForViewOnMap` for the single-array case, or resolve
 * once and call this directly when masking more than one array for the same
 * user/source, e.g. GET /snapshot's contacts + nodes).
 */
export function stripPositions<T extends { latitude?: number; longitude?: number }>(items: T[]): T[] {
  return items.map((item) => {
    const extra = item as { lastAdvertHadPosition?: unknown; positionSource?: unknown };
    if (
      item.latitude === undefined && item.longitude === undefined
      && extra.lastAdvertHadPosition === undefined && extra.positionSource === undefined
    ) return item;
    const masked = { ...item };
    delete masked.latitude;
    delete masked.longitude;
    // #5578: whether (and how) a node shares its position is position data too.
    delete (masked as typeof extra).lastAdvertHadPosition;
    delete (masked as typeof extra).positionSource;
    return masked;
  });
}
