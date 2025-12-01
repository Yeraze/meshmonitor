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

import { useQueryClient } from "@tanstack/react-query";
import { usePoll, PollData } from "./usePoll";
import type { DeviceInfo, Channel } from "../types/device";

/**
 * Hook to access nodes from the poll cache
 *
 * @returns Object with nodes array and loading/error states
 */
export function useNodes() {
  const { data, isLoading, error } = usePoll();
  return {
    nodes: (data?.nodes ?? []) as DeviceInfo[],
    isLoading,
    error,
  };
}

/**
 * Hook to access channels from the poll cache
 *
 * @returns Object with channels array and loading/error states
 */
export function useChannels() {
  const { data, isLoading, error } = usePoll();
  return {
    channels: (data?.channels ?? []) as Channel[],
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

  return {
    nodesWithTelemetry: new Set(telemetry?.nodes ?? []),
    nodesWithWeather: new Set(telemetry?.weather ?? []),
    nodesWithEstimatedPosition: new Set(telemetry?.estimatedPosition ?? []),
    nodesWithPKC: new Set(telemetry?.pkc ?? []),
    isLoading,
  };
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
 * Hook to access unread counts from the poll cache
 *
 * @returns Object with unread counts for channels and DMs
 */
export function useUnreadCountsFromPoll() {
  const { data } = usePoll();
  return {
    channelUnreads: data?.unreadCounts?.channels ?? {},
    dmUnreads: data?.unreadCounts?.directMessages ?? {},
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
  const data = queryClient.getQueryData<PollData>(["poll"]);
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
  const data = queryClient.getQueryData<PollData>(["poll"]);
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
  const data = queryClient.getQueryData<PollData>(["poll"]);
  return (
    (data?.deviceConfig?.basic?.nodeId as string) ??
    data?.config?.localNodeInfo?.nodeId ??
    ""
  );
}
