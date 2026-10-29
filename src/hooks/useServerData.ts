/**
 * Hooks for accessing server data from TanStack Query cache
 *
 * These hooks provide convenient access to data fetched by usePoll,
 * avoiding the need to duplicate state in React contexts.
 *
 * Usage:
 * ```tsx
 * // Instead of:
 * const { nodes } = useData();
 *
 * // Use:
 * const { nodes } = useNodes();
 * ```
 */

import { useMemo, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { usePoll, sourcePollQueryKey, PollData, POLL_QUERY_KEY } from "./usePoll";
import { useSource } from "../contexts/SourceContext";
import { applyPendingNodeOverrides } from "../utils/pendingToggles";
import type { DeviceInfo, Channel } from "../types/device";

// Shared empty fallbacks: a fresh `[]` / `{}` per render would give consumers
// a new reference on every render while the poll has no data, breaking their
// memos and effect dependencies.
const EMPTY_CHANNELS: Channel[] = [];
const EMPTY_UNREADS: Record<string, number> = {};

/**
 * Hook to access nodes from the poll cache
 *
 * Applies any in-flight optimistic favorite/ignored/hide-from-map toggle on
 * top of the raw poll response (#3962 5.4 PR8 — this replaces the
 * reconciliation that used to run once in App.tsx's `processPollData` and
 * write into DataContext). See `applyPendingNodeOverrides` for the overlay
 * logic and `setNodeFieldInCache` below for the write side.
 *
 * @returns Object with nodes array and loading/error states
 */
export function useNodes() {
  const { data, isLoading, error } = usePoll();
  const { sourceId } = useSource();
  const nodes = useMemo(
    () => applyPendingNodeOverrides((data?.nodes ?? []) as DeviceInfo[], sourceId),
    [data, sourceId]
  );
  return {
    nodes,
    isLoading,
    error,
  };
}

/**
 * Optimistically patch one node's fields directly in the poll query cache.
 *
 * Query-cache-native replacement for the old `setNodes(prevNodes => ...)`
 * DataContext writes (#3962 5.4 PR8). Mirrors the pattern already used by
 * `useWebSocket.ts`'s `updateNodeInCache` for real-time node updates — same
 * cache key (`sourcePollQueryKey`), same shape. Callers are still
 * responsible for their own pending-map bookkeeping (see
 * `src/utils/pendingToggles.ts`) when the toggle needs to survive across
 * poll ticks until the server catches up.
 */
export function setNodeFieldInCache(
  queryClient: QueryClient,
  sourceId: string | null,
  nodeNum: number,
  patch: Partial<DeviceInfo>
): void {
  queryClient.setQueryData<PollData>(sourcePollQueryKey(sourceId), (old) => {
    if (!old?.nodes) return old;
    return {
      ...old,
      nodes: old.nodes.map((n) => (n.nodeNum === nodeNum ? { ...n, ...patch } : n)),
    };
  });
}

/**
 * Hook to access channels from the poll cache
 *
 * @returns Object with channels array and loading/error states
 */
export function useChannels() {
  const { data, isLoading, error } = usePoll();
  return {
    channels: (data?.channels ?? EMPTY_CHANNELS) as Channel[],
    isLoading,
    error,
  };
}

/**
 * Hook to access connection status from the poll cache
 *
 * @returns Object with connection info and loading state
 */
export function useConnectionInfo() {
  const { data, isLoading } = usePoll();
  return {
    connection: data?.connection,
    isConnected: data?.connection?.connected ?? false,
    isNodeResponsive: data?.connection?.nodeResponsive ?? false,
    isConfiguring: data?.connection?.configuring ?? false,
    isUserDisconnected: data?.connection?.userDisconnected ?? false,
    isLoading,
  };
}

/**
 * Hook to access telemetry availability from the poll cache
 *
 * @returns Object with Sets of node IDs that have various telemetry types
 */
export function useTelemetryNodes() {
  const { data, isLoading } = usePoll();
  const telemetry = data?.telemetryNodes;
  const prevRef = useRef(telemetry);

  // Preserve previous telemetry data if current response lacks it.
  // This prevents icon flicker when a poll response temporarily
  // has empty/missing telemetry (e.g., server cache invalidation race).
  if (telemetry && (telemetry.nodes?.length || telemetry.weather?.length || telemetry.pkc?.length)) {
    prevRef.current = telemetry;
  }

  const effectiveTelemetry = telemetry?.nodes?.length ? telemetry : prevRef.current;

  // Same Set instance until the contents change: consumers key memos on
  // these, and a fresh Set every render (or every poll with unchanged data)
  // defeated all of them.
  const nodesWithTelemetry = useStableSet(effectiveTelemetry?.nodes);
  const nodesWithWeather = useStableSet(effectiveTelemetry?.weather);
  const nodesWithEstimatedPosition = useStableSet(effectiveTelemetry?.estimatedPosition);
  const nodesWithPKC = useStableSet(effectiveTelemetry?.pkc);
  // nodeId → estimate uncertainty radius in km (issue #3271).
  const rawUncertainty = (effectiveTelemetry as any)?.estimatedUncertainty as Record<string, number> | undefined;
  const estimatedUncertainty = rawUncertainty ?? EMPTY_UNCERTAINTY;

  return {
    nodesWithTelemetry,
    nodesWithWeather,
    nodesWithEstimatedPosition,
    nodesWithPKC,
    // Known nodes with neither a real nor an estimated position (issue #3271).
    unmappedCount: (effectiveTelemetry as any)?.unmappedCount ?? 0,
    estimatedUncertainty,
    isLoading,
  };
}

const EMPTY_UNCERTAINTY: Record<string, number> = Object.freeze({}) as Record<string, number>;

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A Set built from `items`, kept as the same instance while the items are
 * unchanged (same order and values). Order-sensitive on purpose: the server
 * returns these lists in a stable order, and an exact compare stays O(n).
 */
function useStableSet<T>(items: readonly T[] | undefined): Set<T> {
  const ref = useRef<{ items: readonly T[]; set: Set<T> } | null>(null);
  const list = items ?? [];
  if (!ref.current || !sameItems(ref.current.items, list)) {
    ref.current = { items: list, set: new Set(list) };
  }
  return ref.current.set;
}

/**
 * Hook to access device config from the poll cache
 *
 * @returns Object with device configuration and loading state
 */
export function useDeviceConfig() {
  const { data, isLoading } = usePoll();
  return {
    deviceConfig: data?.deviceConfig,
    config: data?.config,
    currentNodeId:
      data?.deviceConfig?.basic?.nodeId ??
      data?.config?.localNodeInfo?.nodeId ??
      "",
    isLoading,
  };
}

/**
 * Hook to access device node numbers (nodes in the connected radio's local database)
 *
 * @returns Set of node numbers in the radio's DB
 */
export function useDeviceNodes() {
  const { data } = usePoll();
  const prevRef = useRef<{ items: readonly number[]; set: Set<number> }>({ items: [], set: new Set() });
  const deviceNodeNums = data?.deviceNodeNums;
  // Keep the last non-empty list (avoids flicker on an empty poll), and keep
  // the same Set instance while its contents are unchanged so it doesn't
  // break memos downstream.
  if (deviceNodeNums && deviceNodeNums.length > 0 && !sameItems(prevRef.current.items, deviceNodeNums)) {
    prevRef.current = { items: deviceNodeNums, set: new Set(deviceNodeNums) };
  }
  return prevRef.current.set;
}

/**
 * Hook to access unread counts from the poll cache
 *
 * @returns Object with unread counts for channels and DMs
 */
export function useUnreadCountsFromPoll() {
  const { data } = usePoll();
  return {
    channelUnreads: data?.unreadCounts?.channels ?? EMPTY_UNREADS,
    dmUnreads: data?.unreadCounts?.directMessages ?? EMPTY_UNREADS,
  };
}

/**
 * Get nodes from cache without subscribing to updates
 * Useful for callbacks and handlers
 *
 * @param queryClient - The query client instance
 * @returns Array of nodes from cache
 */
export function getNodesFromCache(
  queryClient: ReturnType<typeof useQueryClient>
): DeviceInfo[] {
  const data = queryClient.getQueryData<PollData>(POLL_QUERY_KEY);
  return (data?.nodes ?? []) as DeviceInfo[];
}

/**
 * Get channels from cache without subscribing to updates
 * Useful for callbacks and handlers
 *
 * @param queryClient - The query client instance
 * @returns Array of channels from cache
 */
export function getChannelsFromCache(
  queryClient: ReturnType<typeof useQueryClient>
): Channel[] {
  const data = queryClient.getQueryData<PollData>(POLL_QUERY_KEY);
  return (data?.channels ?? []) as Channel[];
}

/**
 * Get current node ID from cache without subscribing to updates
 *
 * @param queryClient - The query client instance
 * @returns Current node ID or empty string
 */
export function getCurrentNodeIdFromCache(
  queryClient: ReturnType<typeof useQueryClient>
): string {
  const data = queryClient.getQueryData<PollData>(POLL_QUERY_KEY);
  return (
    (data?.deviceConfig?.basic?.nodeId as string) ??
    data?.config?.localNodeInfo?.nodeId ??
    ""
  );
}
