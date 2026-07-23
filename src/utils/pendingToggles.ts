/**
 * Expiring store for in-flight optimistic toggles (#4240).
 *
 * Favorite / ignored / hide-from-map all use the same pattern: flip the UI
 * immediately, record the node as "pending", and let the next poll reconcile
 * against the server's value. The record exists so a poll that hasn't caught up
 * yet doesn't visibly revert the user's click, and so rapid double-clicks don't
 * race.
 *
 * The original implementation stored these in plain module-level `Map`s and
 * cleared an entry ONLY from inside the poll's `.map()` over the server's node
 * list. That made clearing conditional on the node reappearing in a later
 * response under the same sourceId — and when it didn't, the entry lived
 * forever and the "already pending" guard silently swallowed every subsequent
 * click, with no network request, until a full page reload. Two real ways to
 * get there:
 *
 *   1. The node stops coming back in the poll (filtered, purged, or hidden by
 *      the map's transport filter — the other half of #4240).
 *   2. The user switches sources. Keys embed the sourceId captured at click
 *      time, so the reconciler computes a different key and never revisits the
 *      orphan.
 *
 * Entries therefore carry a timestamp and expire. Expiry is checked on read
 * (so a stale entry can never gate a click) and swept in bulk once per poll
 * (so orphans don't accumulate). Both paths are independent of the response
 * contents, which is the point.
 */

import type { DeviceInfo } from '../types/device';

/** Generous relative to the ~10s poll: a healthy round-trip reconciles well
 *  before this, so expiry only ever fires on the stuck paths described above. */
export const PENDING_TOGGLE_TTL_MS = 30_000;

interface PendingToggleEntry {
  value: boolean;
  at: number;
}

export class PendingToggleMap {
  private entries = new Map<string, PendingToggleEntry>();

  /** Record an optimistic toggle as in-flight. */
  set(key: string, value: boolean, now: number = Date.now()): void {
    this.entries.set(key, { value, at: now });
  }

  /**
   * The pending value for `key`, or `undefined` when absent or expired.
   * Expired entries are dropped on read.
   */
  get(key: string, now: number = Date.now()): boolean | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now - entry.at > PENDING_TOGGLE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop every expired entry. Independent of any server response. */
  sweep(now: number = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at > PENDING_TOGGLE_TTL_MS) this.entries.delete(key);
    }
  }

  /** Live entry count, including any not-yet-swept expired entries. */
  get size(): number {
    return this.entries.size;
  }
}

/** Sweep several stores in one call (the poll loop handles all three). */
export function sweepAll(maps: PendingToggleMap[], now: number = Date.now()): void {
  for (const map of maps) map.sweep(now);
}

// Track pending favorite/ignored/hide-from-map requests as module-level
// singletons so they persist across remounts (App is re-keyed on source
// switch) and are shared between App.tsx's poll reconciliation
// (processPollData) and the toggle handlers now living in
// `src/hooks/useSourceView.ts` (#3962 5.4 PR4). Keys are composite strings
// `${sourceId}:${nodeNum}` so that an optimistic toggle on Source A does not
// bleed into Source B's view of the same node (bug: single nodeNum key meant
// clicking favorite on Source 1 forced the same optimistic state onto Source
// 2's poll response because both sources share nodeNums on overlapping
// meshes).
export const favoritePendingKey = (sourceId: string | null | undefined, nodeNum: number) =>
  `${sourceId ?? ''}:${nodeNum}`;

export const pendingFavoriteRequests = new PendingToggleMap();
export const pendingIgnoredRequests = new PendingToggleMap();
export const pendingHideFromMapRequests = new PendingToggleMap();

export const ALL_PENDING_TOGGLE_MAPS = [
  pendingFavoriteRequests,
  pendingIgnoredRequests,
  pendingHideFromMapRequests,
];

/**
 * Reapply any still-in-flight favorite/ignored/hide-from-map toggles on top
 * of a freshly-polled node list, sweeping expired entries first.
 *
 * This is the query-cache-native replacement for the reconciliation block
 * that used to live in App.tsx's `processPollData` and write its result into
 * DataContext's `nodes` state (#3962 5.4 PR8 — DataContext no longer mirrors
 * poll-derived nodes at all). `useNodes()` (src/hooks/useServerData.ts) calls
 * this on every read so every consumer of the poll cache sees the same
 * overlay, and the optimistic-write side (toggleFavorite/toggleFavoriteLock
 * in useSourceView.ts, toggleIgnored/toggleHideFromMap in App.tsx) writes the
 * same pending value directly into the query cache via
 * `useServerData.ts`'s `setNodeFieldInCache` so the click and the next poll
 * response converge on the same value instead of flickering back to stale
 * server state for up to one poll interval.
 *
 * Pure aside from the shared pending-map mutation (matching the original
 * reconciliation's own behavior of resolving/deleting entries once the
 * server value catches up) — returns `nodes` unchanged (same reference) when
 * no toggle is in flight, so callers can skip a re-render.
 */
export function applyPendingNodeOverrides(
  nodes: DeviceInfo[],
  sourceId: string | null | undefined
): DeviceInfo[] {
  sweepAll(ALL_PENDING_TOGGLE_MAPS);

  if (
    pendingFavoriteRequests.size === 0 &&
    pendingIgnoredRequests.size === 0 &&
    pendingHideFromMapRequests.size === 0
  ) {
    return nodes;
  }

  return nodes.map(serverNode => {
    const updatedNode = { ...serverNode };

    // Handle pending favorite requests — key is scoped by sourceId so
    // Source A's optimistic toggles don't leak into Source B's view.
    const favKey = favoritePendingKey(sourceId, serverNode.nodeNum);
    const pendingFavoriteState = pendingFavoriteRequests.get(favKey);
    if (pendingFavoriteState !== undefined) {
      if (serverNode.isFavorite === pendingFavoriteState) {
        pendingFavoriteRequests.delete(favKey);
      } else {
        updatedNode.isFavorite = pendingFavoriteState;
      }
    }

    // Handle pending ignored requests — same per-source scoping
    const ignKey = favoritePendingKey(sourceId, serverNode.nodeNum);
    const pendingIgnoredState = pendingIgnoredRequests.get(ignKey);
    if (pendingIgnoredState !== undefined) {
      if (serverNode.isIgnored === pendingIgnoredState) {
        pendingIgnoredRequests.delete(ignKey);
      } else {
        updatedNode.isIgnored = pendingIgnoredState;
      }
    }

    // Handle pending hide-from-map requests — same per-source scoping
    const hfmKey = favoritePendingKey(sourceId, serverNode.nodeNum);
    const pendingHideFromMapState = pendingHideFromMapRequests.get(hfmKey);
    if (pendingHideFromMapState !== undefined) {
      if (Boolean(serverNode.hideFromMap) === pendingHideFromMapState) {
        pendingHideFromMapRequests.delete(hfmKey);
      } else {
        updatedNode.hideFromMap = pendingHideFromMapState;
      }
    }

    return updatedNode;
  });
}
