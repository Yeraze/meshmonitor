/**
 * Pure, leaflet-free helpers shared by every neighbor-link renderer (Map
 * Consolidation epic #4047, Phase 7, WP1). Extracted from the near-identical
 * `snrToOpacity`/unordered-pair-dedup logic duplicated across DashboardMap,
 * MapAnalysis's `NeighborLinksLayer`/`MeshCoreNeighborLinksLayer`, and
 * MeshCoreMap, plus the bearing math NodesTab used for its unidirectional
 * arrow decorations (NodesTab.tsx, neighbor-link block). Consumed by the
 * descriptor-based `map/layers/NeighborLinksLayer.tsx` and by each
 * consumer's adapter — kept leaflet-free so adapters (and this file's own
 * tests) don't need to pull in `leaflet`/`react-leaflet`.
 */

/**
 * SNR → line opacity, the `null → 0.4, clamp((snr + 10) / 20, 0.2, 1)` form
 * used verbatim by DashboardMap, MapAnalysis's `NeighborLinksLayer` /
 * `MeshCoreNeighborLinksLayer`, and MeshCoreMap. NodesTab uses a different
 * 4-tier SNR → weight/opacity table instead — that stays in the NodesTab
 * adapter's own `pathOptions` computation; do NOT force it onto this helper.
 */
export function snrToNeighborOpacity(snr: number | null): number {
  if (snr === null) return 0.4;
  return Math.max(0.2, Math.min(1, (snr + 10) / 20));
}

/**
 * Collapse an array of edges that may report both `A→B` and `B→A` for the
 * same unordered pair down to one entry each, keeping the first occurrence.
 * The canonical `a < b ? "a~b" : "b~a"` pairing used by DashboardMap's
 * meshtastic + MeshCore neighbor-link dedup and MapAnalysis. `keyA`/`keyB`
 * extract each endpoint's identity (nodeNum, publicKey, …) — both must
 * return the same key type for a given `items` array so the `<` comparison
 * is meaningful (numeric for nodeNum, lexicographic for string keys).
 */
export function dedupByUnorderedPair<T, K extends string | number>(
  items: T[],
  keyA: (item: T) => K,
  keyB: (item: T) => K,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const a = keyA(item);
    const b = keyB(item);
    const pairKey = a < b ? `${a}~${b}` : `${b}~${a}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    out.push(item);
  }
  return out;
}

/**
 * Default fractions along a neighbor-link line at which direction arrows are
 * drawn (NodesTab's unidirectional-arrow decoration: 25%/50%/75% along the
 * line for visibility at any zoom). Consumers may override via
 * `NeighborLinkDescriptor.arrows.fractions`.
 */
export const neighborArrowFractions: number[] = [0.25, 0.5, 0.75];

/**
 * Bearing (degrees, 0 = "up"/north in the equirectangular sense
 * `createArrowIcon` expects — NOT a true great-circle bearing) from `from`
 * to `to`, longitude-delta scaled by `cos(midpoint latitude)` to correct for
 * latitude. Extracted verbatim from NodesTab's neighbor-link arrow bearing
 * calculation (`Math.atan2((toLng - fromLng) * cos(latMid), toLat - fromLat)`
 * in degrees). The shared `NeighborLinksLayer` calls this with `from` =
 * the link's second position and `to` = the link's first position, so an
 * arrow points from the second endpoint toward the first — matching
 * NodesTab's "arrow points FROM neighbor TO node" convention where
 * `positions = [[nodeLat, nodeLng], [neighborLat, neighborLng]]`.
 */
export function bearingBetween(from: [number, number], to: [number, number]): number {
  const latMid = (from[0] + to[0]) / 2;
  return (
    Math.atan2((to[1] - from[1]) * Math.cos((latMid * Math.PI) / 180), to[0] - from[0]) *
    (180 / Math.PI)
  );
}
