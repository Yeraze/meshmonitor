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
  NODE_QUICK_AGE_STORAGE_KEY,
  type NodeQuickAgeHours,
  parseNodeQuickAgeHours,
  readNodeQuickAgeHours,
  writeNodeQuickAgeHours,
} from '../utils/nodeQuickAgeFilter';

let current: NodeQuickAgeHours = readNodeQuickAgeHours();
const listeners = new Set<() => void>();

// Keep other tabs of this browser in step: a pick in one tab fires `storage`
// in the rest (same pattern as meshcoreUnreadStore).
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== NODE_QUICK_AGE_STORAGE_KEY) return;
  const next = readNodeQuickAgeHours();
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
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
