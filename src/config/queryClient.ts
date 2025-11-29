/**
 * TanStack Query Client Configuration
 *
 * Centralized configuration for React Query client.
 * Provides sensible defaults for caching, retries, and request deduplication.
 */

import { QueryClient } from '@tanstack/react-query';

/**
 * Shared QueryClient instance for the application
 *
 * Default configuration:
 * - staleTime: 4 seconds (data considered fresh, won't refetch)
 * - gcTime: 5 minutes (unused data kept in cache)
 * - refetchOnWindowFocus: disabled (prevents unexpected refetches)
 * - retry: 1 attempt with 1 second delay
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Prevent duplicate requests - only one request at a time per query key
      staleTime: 4000, // Data considered fresh for 4 seconds
      gcTime: 5 * 60 * 1000, // Keep unused data in cache for 5 minutes
      refetchOnWindowFocus: false, // Don't refetch when window regains focus
      retry: 1, // Only retry once on failure
      retryDelay: 1000, // Wait 1 second before retry
    },
  },
});
