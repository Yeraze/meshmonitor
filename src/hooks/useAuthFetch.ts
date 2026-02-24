/**
 * Hook for making authenticated API requests with CSRF token handling
 *
 * Provides a fetch wrapper that automatically:
 * - Adds CSRF tokens to mutation requests (POST, PUT, DELETE, PATCH)
 * - Retries failed requests due to CSRF token expiration
 * - Includes credentials for session authentication
 * - Handles request timeouts
 */

import { useCallback } from 'react';
import { useCsrf } from '../contexts/CsrfContext';

/** Type for the authFetch function */
export type AuthFetchFn = (
  url: string,
  options?: RequestInit,
  retryCount?: number,
  timeoutMs?: number
) => Promise<Response>;

/**
 * Hook to get an authenticated fetch function
 *
 * @returns Authenticated fetch function with CSRF token handling
 *
 * @example
 * ```tsx
 * const authFetch = useAuthFetch();
 *
 * // GET request (no CSRF token needed)
 * const response = await authFetch('/api/data');
 *
 * // POST request (CSRF token automatically added)
 * const response = await authFetch('/api/data', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ key: 'value' })
 * });
 * ```
 */
export function useAuthFetch(): AuthFetchFn {
  const { getToken: getCsrfToken, refreshToken: refreshCsrfToken } = useCsrf();

  const authFetch = useCallback(
    async (
      url: string,
      options?: RequestInit,
      retryCount = 0,
      timeoutMs = 10000
    ): Promise<Response> => {
      const headers = new Headers(options?.headers);

      // Add CSRF token for mutation requests
      const method = options?.method?.toUpperCase() || 'GET';
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        const csrfToken = getCsrfToken();
        if (csrfToken) {
          headers.set('X-CSRF-Token', csrfToken);
          console.log('[authFetch] ✓ CSRF token added to request');
        } else {
          console.error('[authFetch] ✗ NO CSRF TOKEN - Request may fail!');
        }
      }

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          headers,
          credentials: 'include',
          signal: controller.signal,
        });

        // Handle 403 CSRF errors with automatic token refresh and retry
        if (response.status === 403 && retryCount < 1) {
          if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
            // Clone response to check if it's a CSRF error without consuming the body
            const clonedResponse = response.clone();
            const error = await clonedResponse.json().catch(() => ({ error: '' }));
            if (error.error && error.error.toLowerCase().includes('csrf')) {
              console.warn('[authFetch] 403 CSRF error - Refreshing token and retrying...');
              sessionStorage.removeItem('csrfToken');
              await refreshCsrfToken();
              return authFetch(url, options, retryCount + 1, timeoutMs);
            }
          }
        }

        // Silently handle auth errors to prevent console spam
        if (response.status === 401 || response.status === 403) {
          return response;
        }

        return response;
      } catch (error) {
        // Check for AbortError from both Error and DOMException for browser compatibility
        if (
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        // Always clear timeout to prevent memory leaks
        clearTimeout(timeoutId);
      }
    },
    [getCsrfToken, refreshCsrfToken]
  );

  return authFetch;
}
