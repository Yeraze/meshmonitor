/**
 * Pure helpers for the Notifications → Battery Alerts "monitored nodes" picker
 * (issue #3486).
 *
 * `selectedMonitoredNodes` is a per-source list of node IDs (bare `nodeId`
 * strings, e.g. `!abcd1234`). The picker only ever shows the *current source's*
 * nodes — `/api/nodes?sourceId=…` is source- and channel-permission-scoped — so
 * IDs that were saved under a different source, or for nodes that no longer
 * exist under the active source, are invisible in the list. The old
 * "Deselect all" only touched the visible/filtered rows, so those stale IDs
 * could never be cleared and the selection count stayed wrong (the user saw
 * "11 node(s) selected" with nothing visibly checked, and low-battery alerts
 * silently matched nothing).
 *
 * These helpers operate on a per-source basis: with no search filter active the
 * buttons act on the whole current source, and the reconcile step drops IDs
 * that don't resolve under it.
 */

/**
 * Drop selected IDs that don't resolve to a node visible under the active
 * source. Used to reconcile a loaded per-source selection against the nodes
 * actually present, so stale cross-source / deleted IDs don't linger.
 */
export function reconcileMonitoredNodes(
  selected: string[],
  availableIds: Iterable<string>,
): string[] {
  const available = availableIds instanceof Set ? availableIds : new Set(availableIds);
  return selected.filter((id) => available.has(id));
}

/**
 * "Select all" semantics.
 * - No search term active → select the entire current source's node set
 *   (per-source replace), so the result is exactly what's shown.
 * - Search active → add just the filtered subset to the existing selection,
 *   preserving targeted multi-add while filtering.
 */
export function selectAllMonitoredNodes(
  selected: string[],
  availableIds: string[],
  filteredIds: string[],
  searchActive: boolean,
): string[] {
  if (searchActive) {
    return [...new Set([...selected, ...filteredIds])];
  }
  return [...new Set(availableIds)];
}

/**
 * "Deselect all" semantics.
 * - No search term active → clear the entire per-source selection, including
 *   any stale IDs not shown in the list (this is the #3486 fix).
 * - Search active → remove only the filtered subset.
 */
export function deselectAllMonitoredNodes(
  selected: string[],
  filteredIds: string[],
  searchActive: boolean,
): string[] {
  if (searchActive) {
    const remove = new Set(filteredIds);
    return selected.filter((id) => !remove.has(id));
  }
  return [];
}
