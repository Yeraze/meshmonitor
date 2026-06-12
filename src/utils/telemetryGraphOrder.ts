/**
 * Stable ordering for the node Info screen's telemetry graphs (#3436).
 *
 * The graph list was previously rendered in the telemetry-grouping Map's
 * insertion order, which reshuffled on almost every update. This comparator
 * gives a deterministic order — favorited metrics first, then alphabetical by
 * display label — so a specific graph stays put between updates and newly
 * available metrics slot into their alphabetical position instead of jumping
 * to the top/bottom at random.
 */
export function compareTelemetryGraphs(
  typeA: string,
  typeB: string,
  favorites: Set<string>,
  getLabel: (type: string) => string,
): number {
  const favA = favorites.has(typeA) ? 0 : 1;
  const favB = favorites.has(typeB) ? 0 : 1;
  if (favA !== favB) return favA - favB;
  return getLabel(typeA).localeCompare(getLabel(typeB));
}
