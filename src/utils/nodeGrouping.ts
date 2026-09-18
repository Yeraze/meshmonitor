/**
 * Grouping helpers for the Nodes panel's "Group by role" toggle. Kept as pure
 * functions, separate from NodesTab, so the flattening logic that feeds the
 * virtualized list (see @tanstack/react-virtual, commit 6a254e78) is testable
 * without rendering the whole component.
 *
 * Categorization itself is NOT reimplemented here — {@link getNodeTypeCategory}
 * (nodeTypeCategory.ts) is the single source of truth for what "role" means
 * for a node, covering both Meshtastic device roles and MeshCore advert types.
 */

import { CategorizableNode, getNodeTypeCategory, NODE_TYPE_CATEGORIES, NodeTypeCategory } from './nodeTypeCategory.js';

/** Per-category node count, in the fixed {@link NODE_TYPE_CATEGORIES} order (infrastructure first). */
export interface RoleGroupCount {
  category: NodeTypeCategory;
  count: number;
}

/**
 * Count nodes per category for the role distribution summary. Only categories
 * with at least one node are returned, ordered by the fixed category order
 * rather than by count — so the summary's color/position assignment never
 * depends on how many nodes happen to be in each bucket.
 */
export function countNodesByCategory<T extends CategorizableNode>(nodes: readonly T[]): RoleGroupCount[] {
  const counts = new Map<NodeTypeCategory, number>();
  for (const node of nodes) {
    const category = getNodeTypeCategory(node);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return NODE_TYPE_CATEGORIES
    .filter((category) => counts.has(category))
    .map((category) => ({ category, count: counts.get(category) as number }));
}

/** One row of the flattened, single-list rendering the virtualizer consumes. */
export type GroupedNodeListItem<T> =
  | { type: 'header'; category: NodeTypeCategory; count: number; collapsed: boolean }
  | { type: 'node'; node: T };

/**
 * Flatten nodes into group headers + rows for ONE virtualized list. Grouping
 * must never fall back to rendering every group's children eagerly (that
 * would undo the virtualization from 6a254e78) — a collapsed group's rows are
 * omitted from the returned array entirely, not just hidden with CSS, so the
 * virtualizer never measures or mounts them.
 *
 * `orderWithinGroup` lets the caller apply the same favorites-first + field
 * sort the flat (ungrouped) list already uses, scoped to each group, so
 * sorting and favorites keep working with grouping on.
 */
export function buildGroupedNodeItems<T extends CategorizableNode>(
  nodes: readonly T[],
  orderWithinGroup: (groupNodes: T[]) => T[],
  collapsedCategories: ReadonlySet<NodeTypeCategory>,
): GroupedNodeListItem<T>[] {
  const byCategory = new Map<NodeTypeCategory, T[]>();
  for (const node of nodes) {
    const category = getNodeTypeCategory(node);
    const group = byCategory.get(category);
    if (group) {
      group.push(node);
    } else {
      byCategory.set(category, [node]);
    }
  }

  const items: GroupedNodeListItem<T>[] = [];
  for (const category of NODE_TYPE_CATEGORIES) {
    const group = byCategory.get(category);
    if (!group || group.length === 0) continue;
    const collapsed = collapsedCategories.has(category);
    items.push({ type: 'header', category, count: group.length, collapsed });
    if (!collapsed) {
      for (const node of orderWithinGroup(group)) {
        items.push({ type: 'node', node });
      }
    }
  }
  return items;
}
