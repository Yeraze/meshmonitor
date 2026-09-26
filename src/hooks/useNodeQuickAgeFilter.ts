/**
 * Shared, view-only state for the Nodes tab quick age filter (#5387).
 *
 * useSourceView (the list) and NodesTab (the map + the control) both read it,
 * so it lives in a tiny module store rather than component state: one pick
 * updates the list and the map together. Persisted per viewer in localStorage;
 * never saved to the server. See src/utils/nodeQuickAgeFilter.ts.
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  type NodeQuickAgeHours,
  parseNodeQuickAgeHours,
  readNodeQuickAgeHours,
  writeNodeQuickAgeHours,
} from '../utils/nodeQuickAgeFilter';

let current: NodeQuickAgeHours = readNodeQuickAgeHours();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): NodeQuickAgeHours {
  return current;
}

/** Set the quick filter (null = follow Settings). Exported for tests. */
export function setNodeQuickAgeHours(hours: NodeQuickAgeHours): void {
  const next = parseNodeQuickAgeHours(hours == null ? null : String(hours));
  if (next === current) return;
  current = next;
  writeNodeQuickAgeHours(next);
  listeners.forEach((l) => l());
}

/** Re-read localStorage into the store. Tests only. */
export function resetNodeQuickAgeStoreForTests(): void {
  current = readNodeQuickAgeHours();
  listeners.forEach((l) => l());
}

export function useNodeQuickAgeFilter(): [NodeQuickAgeHours, (hours: NodeQuickAgeHours) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = useCallback((hours: NodeQuickAgeHours) => setNodeQuickAgeHours(hours), []);
  return [value, set];
}
