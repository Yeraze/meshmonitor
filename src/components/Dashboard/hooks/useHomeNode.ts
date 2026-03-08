/**
 * useHomeNode - Shared hook for finding the home node and bucket size options
 *
 * Used by DistanceDistributionWidget and HopDistanceHeatmapWidget to avoid
 * duplicating the home node lookup logic and bucket size constant.
 */

import { useMemo } from 'react';
import { type NodeInfo } from '../../TelemetryChart';

export const BUCKET_SIZE_OPTIONS = [1, 2, 5, 10, 15, 20, 25, 50, 100] as const;

export function useHomeNode(
  nodes: Map<string, NodeInfo>,
  currentNodeId: string | null,
): NodeInfo | null {
  return useMemo(() => {
    if (!currentNodeId) return null;
    for (const [, node] of nodes) {
      if (node.user?.id === currentNodeId) return node;
    }
    return null;
  }, [nodes, currentNodeId]);
}
