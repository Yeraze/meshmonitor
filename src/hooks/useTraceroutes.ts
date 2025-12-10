/**
 * Centralized hook for traceroute data access
 *
 * Provides a single source of truth for traceroute data across all views:
 * - Dashboard TracerouteWidget
 * - Node View (getRecentTraceroute)
 * - Traceroute History Modal
 *
 * Data is synchronized via the poll mechanism, ensuring consistent
 * display across all components. Traceroutes are sorted by timestamp DESC
 * (newest first) to match the database ordering.
 */

import { usePoll, PollTraceroute } from './usePoll';
import { useQueryClient } from '@tanstack/react-query';
import { POLL_QUERY_KEY, PollData } from './usePoll';

/**
 * Hook to access traceroute data from the poll cache
 *
 * @returns Object with traceroutes and utility functions
 *
 * @example
 * ```tsx
 * const { traceroutes, getRecentTraceroute, getTraceroutesByNode } = useTraceroutes();
 *
 * // Get all recent traceroutes for dashboard widget
 * const allRecent = traceroutes;
 *
 * // Get most recent traceroute for a specific node (for Node View)
 * const recent = getRecentTraceroute(nodeId);
 *
 * // Get traceroutes between two nodes
 * const history = getTraceroutesByNodePair(fromNodeNum, toNodeNum);
 * ```
 */
export function useTraceroutes() {
  const { data, isLoading, error } = usePoll();

  // Traceroutes from poll, already sorted by timestamp DESC from server
  const traceroutes = (data?.traceroutes ?? []) as PollTraceroute[];

  /**
   * Get the most recent traceroute involving a specific node
   * Used by Node View to show the latest traceroute
   *
   * @param nodeId - The node ID to find traceroutes for
   * @param withinMs - Only consider traceroutes within this time window (default: 24 hours)
   * @returns The most recent traceroute or null
   */
  const getRecentTraceroute = (nodeId: string, withinMs: number = 24 * 60 * 60 * 1000): PollTraceroute | null => {
    const cutoffTime = Date.now() - withinMs;

    // Traceroutes are already sorted by timestamp DESC, so first match is most recent
    const recent = traceroutes.find(
      tr => (tr.fromNodeId === nodeId || tr.toNodeId === nodeId) && tr.timestamp >= cutoffTime
    );

    return recent ?? null;
  };

  /**
   * Get all traceroutes involving a specific node
   * Useful for filtering traceroutes by node
   *
   * @param nodeId - The node ID to filter by
   * @returns Array of traceroutes involving the node (sorted by timestamp DESC)
   */
  const getTraceroutesByNode = (nodeId: string): PollTraceroute[] => {
    return traceroutes.filter(tr => tr.fromNodeId === nodeId || tr.toNodeId === nodeId);
  };

  /**
   * Get traceroutes between two specific nodes
   * Used by Traceroute History Modal for recent entries preview
   *
   * @param fromNodeNum - Source node number
   * @param toNodeNum - Destination node number
   * @param limit - Maximum number of results (default: 10)
   * @returns Array of traceroutes between the nodes (sorted by timestamp DESC)
   */
  const getTraceroutesByNodePair = (
    fromNodeNum: number,
    toNodeNum: number,
    limit: number = 10
  ): PollTraceroute[] => {
    return traceroutes
      .filter(tr =>
        (tr.fromNodeNum === fromNodeNum && tr.toNodeNum === toNodeNum) ||
        (tr.fromNodeNum === toNodeNum && tr.toNodeNum === fromNodeNum)
      )
      .slice(0, limit);
  };

  /**
   * Get the best (lowest hop count) traceroute between two nodes
   * Used by Dashboard Widget to show optimal route
   *
   * @param fromNodeNum - Source node number
   * @param toNodeNum - Destination node number
   * @returns The traceroute with lowest hop count, or null
   */
  const getBestTraceroute = (fromNodeNum: number, toNodeNum: number): PollTraceroute | null => {
    const relevantTraceroutes = traceroutes.filter(tr =>
      (tr.fromNodeNum === fromNodeNum && tr.toNodeNum === toNodeNum) ||
      (tr.fromNodeNum === toNodeNum && tr.toNodeNum === fromNodeNum)
    );

    if (relevantTraceroutes.length === 0) return null;

    return relevantTraceroutes.reduce((best, current) =>
      current.hopCount < best.hopCount ? current : best
    );
  };

  return {
    traceroutes,
    isLoading,
    error,
    getRecentTraceroute,
    getTraceroutesByNode,
    getTraceroutesByNodePair,
    getBestTraceroute,
  };
}

/**
 * Get traceroutes from cache without subscribing to updates
 * Useful for callbacks and handlers outside React components
 *
 * @param queryClient - The query client instance
 * @returns Array of traceroutes from cache
 */
export function getTraceroutesFromCache(
  queryClient: ReturnType<typeof useQueryClient>
): PollTraceroute[] {
  const data = queryClient.getQueryData<PollData>(POLL_QUERY_KEY);
  return (data?.traceroutes ?? []) as PollTraceroute[];
}
