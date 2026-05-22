/**
 * Merge per-source `nodes` rows into one representative row per `nodeNum`
 * for the unified Nodes view (issue #3135).
 *
 * Background: since migration 029 the `nodes` table has a composite PK
 * `(nodeNum, sourceId)`, so a node heard on multiple sources lives as one
 * row per source. The unified consumers (`/api/poll` and `/api/nodes` with
 * no `sourceId`) query the table unscoped, which returns every row. Without
 * a merge step the UI shows the node once per source — and any source that
 * only saw a transit packet has `longName/shortName = null`, so the user
 * sees "Node <nodeNum>" duplicates next to the labeled row.
 *
 * The merge picks the newest row by `lastHeard` (then `updatedAt` as a
 * tiebreaker) and back-fills any empty fields from older rows. The two
 * user-intent booleans (`isFavorite`, `isIgnored`) are OR'd across sources
 * so a flag set in any source is honored in the unified view.
 */
import type { DbNode } from '../../db/types.js';

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function mergeNodesAcrossSources(rows: DbNode[]): DbNode[] {
  if (rows.length <= 1) return rows;

  const groups = new Map<number, DbNode[]>();
  for (const row of rows) {
    const list = groups.get(row.nodeNum);
    if (list) list.push(row);
    else groups.set(row.nodeNum, [row]);
  }

  const merged: DbNode[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    group.sort((a, b) => {
      const lh = (b.lastHeard ?? 0) - (a.lastHeard ?? 0);
      if (lh !== 0) return lh;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    const winner: Record<string, any> = { ...group[0] };

    for (let i = 1; i < group.length; i++) {
      const older = group[i] as unknown as Record<string, any>;
      for (const key of Object.keys(older)) {
        if (isEmpty(winner[key]) && !isEmpty(older[key])) {
          winner[key] = older[key];
        }
      }
    }

    winner.isFavorite = group.some((n) => n.isFavorite === true);
    winner.isIgnored = group.some((n) => n.isIgnored === true);
    winner.favoriteLocked = group.some((n) => n.favoriteLocked === true);

    const maxLastHeard = group.reduce(
      (max, n) => Math.max(max, n.lastHeard ?? 0),
      0,
    );
    if (maxLastHeard > 0) winner.lastHeard = maxLastHeard;

    const maxUpdatedAt = group.reduce(
      (max, n) => Math.max(max, n.updatedAt ?? 0),
      0,
    );
    if (maxUpdatedAt > 0) winner.updatedAt = maxUpdatedAt;

    merged.push(winner as DbNode);
  }

  merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return merged;
}
