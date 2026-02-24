/**
 * Favorite charts hooks using TanStack Query
 *
 * Provides hooks for fetching and toggling favorite telemetry charts.
 * Uses optimistic updates for instant UI feedback.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from './useCsrfFetch';

/**
 * Represents a favorite chart entry stored in settings
 */
export interface FavoriteChart {
  /** Node ID in format !xxxxxxxx */
  nodeId: string;
  /** Type of telemetry (e.g., 'batteryLevel', 'temperature') */
  telemetryType: string;
}

/**
 * Options for useFavorites hook
 */
interface UseFavoritesOptions {
  /** Node ID to filter favorites for */
  nodeId: string;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch favorite charts for a specific node
 *
 * Uses TanStack Query for caching and automatic refetching.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with Set of favorite telemetry types
 *
 * @example
 * ```tsx
 * const { data: favorites } = useFavorites({ nodeId: '!abcd1234' });
 * const isFavorite = favorites?.has('batteryLevel');
 * ```
 */
export function useFavorites({ nodeId, baseUrl = '', enabled = true }: UseFavoritesOptions) {
  return useQuery({
    queryKey: ['favorites', nodeId],
    queryFn: async (): Promise<Set<string>> => {
      const response = await fetch(`${baseUrl}/api/settings`);

      if (!response.ok) {
        return new Set();
      }

      const settings = await response.json();

      if (!settings.telemetryFavorites) {
        return new Set();
      }

      const favoritesArray: FavoriteChart[] = JSON.parse(settings.telemetryFavorites);

      return new Set(favoritesArray.filter(f => f.nodeId === nodeId).map(f => f.telemetryType));
    },
    enabled: enabled && !!nodeId,
    staleTime: 5 * 60 * 1000, // Consider fresh for 5 minutes
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
  });
}

/**
 * Parameters for toggle favorite mutation
 */
interface ToggleFavoriteParams {
  /** Node ID for the favorite */
  nodeId: string;
  /** Telemetry type to toggle */
  telemetryType: string;
  /** Current favorites set (for optimistic update calculation) */
  currentFavorites: Set<string>;
}

/**
 * Options for useToggleFavorite hook
 */
interface UseToggleFavoriteOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Callback on successful toggle */
  onSuccess?: () => void;
  /** Callback on error with message */
  onError?: (message: string) => void;
}

/**
 * Hook to toggle a telemetry chart as favorite
 *
 * Uses TanStack Query mutation with optimistic updates for
 * instant UI feedback. Automatically rolls back on error.
 *
 * @param options - Configuration options
 * @returns TanStack Query mutation for toggling favorites
 *
 * @example
 * ```tsx
 * const toggleFavorite = useToggleFavorite({
 *   onError: msg => showToast(msg, 'error')
 * });
 *
 * // Toggle a favorite
 * toggleFavorite.mutate({
 *   nodeId: '!abcd1234',
 *   telemetryType: 'batteryLevel',
 *   currentFavorites: favorites
 * });
 * ```
 */
export function useToggleFavorite({ baseUrl = '', onSuccess, onError }: UseToggleFavoriteOptions = {}) {
  const queryClient = useQueryClient();
  const csrfFetch = useCsrfFetch();

  return useMutation({
    mutationFn: async ({ nodeId, telemetryType, currentFavorites }: ToggleFavoriteParams): Promise<Set<string>> => {
      // Calculate new favorites
      const newFavorites = new Set(currentFavorites);
      if (newFavorites.has(telemetryType)) {
        newFavorites.delete(telemetryType);
      } else {
        newFavorites.add(telemetryType);
      }

      // Fetch existing favorites for all nodes
      const settingsResponse = await fetch(`${baseUrl}/api/settings`);
      let allFavorites: FavoriteChart[] = [];

      if (settingsResponse.ok) {
        const settings = await settingsResponse.json();
        if (settings.telemetryFavorites) {
          allFavorites = JSON.parse(settings.telemetryFavorites);
          // Remove favorites for current node
          allFavorites = allFavorites.filter(f => f.nodeId !== nodeId);
        }
      }

      // Add new favorites for current node
      newFavorites.forEach(type => {
        allFavorites.push({ nodeId, telemetryType: type });
      });

      // Save updated favorites
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetryFavorites: JSON.stringify(allFavorites),
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('Insufficient permissions to save favorites');
        }
        throw new Error(`Server returned ${response.status}`);
      }

      return newFavorites;
    },

    // Optimistic update: update cache immediately before server responds
    onMutate: async ({ nodeId, telemetryType, currentFavorites }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['favorites', nodeId] });

      // Snapshot the previous value
      const previousFavorites = queryClient.getQueryData<Set<string>>(['favorites', nodeId]);

      // Optimistically update to the new value
      const newFavorites = new Set(currentFavorites);
      if (newFavorites.has(telemetryType)) {
        newFavorites.delete(telemetryType);
      } else {
        newFavorites.add(telemetryType);
      }

      queryClient.setQueryData(['favorites', nodeId], newFavorites);

      // Return context with the snapshotted value
      return { previousFavorites, nodeId };
    },

    // On error, roll back to the previous value
    onError: (error, _variables, context) => {
      if (context?.previousFavorites !== undefined) {
        queryClient.setQueryData(['favorites', context.nodeId], context.previousFavorites);
      }
      onError?.(error instanceof Error ? error.message : 'Failed to save favorite');
    },

    // On success, update cache with server response
    onSuccess: (newFavorites, { nodeId }) => {
      queryClient.setQueryData(['favorites', nodeId], newFavorites);
      onSuccess?.();
    },
  });
}
