import { useCallback, useMemo, useState } from 'react';
import {
  buildGroupedNodeItems,
  countNodesByCategory,
  type GroupedNodeListItem,
  type RoleGroupCount,
} from '../utils/nodeGrouping.js';
import type { CategorizableNode, NodeTypeCategory } from '../utils/nodeTypeCategory.js';

/**
 * Shared "Group by role" list model. `nodes` is the filtered set, `flatOrdered`
 * the already-ordered flat list used when grouping is off, and
 * `orderWithinGroup` orders each group (favorites first + sort).
 */
export function useNodeRoleGrouping<T extends CategorizableNode>(
  nodes: readonly T[],
  orderWithinGroup: (groupNodes: T[]) => T[],
  enabled: boolean,
  flatOrdered: readonly T[]
): {
  items: GroupedNodeListItem<T>[];
  distribution: RoleGroupCount[] | null;
  toggleCollapsed: (category: NodeTypeCategory) => void;
} {
  const [collapsed, setCollapsed] = useState<Set<NodeTypeCategory>>(() => new Set());
  const toggleCollapsed = useCallback((category: NodeTypeCategory) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }, []);

  const distribution = useMemo(() => (enabled ? countNodesByCategory(nodes) : null), [enabled, nodes]);

  const items = useMemo<GroupedNodeListItem<T>[]>(() => {
    if (enabled) return buildGroupedNodeItems(nodes, orderWithinGroup, collapsed);
    return flatOrdered.map((node) => ({ type: 'node' as const, node }));
  }, [enabled, nodes, orderWithinGroup, collapsed, flatOrdered]);

  return { items, distribution, toggleCollapsed };
}
