/**
 * CSRF-protected fetch hook
 *
 * Provides a fetch wrapper that automatically includes CSRF tokens
 * for mutation requests (POST, PUT, DELETE, PATCH)
 */

import { useCallback } from 'react';
import { useCsrf } from '../contexts/CsrfContext';

export const useCsrfFetch = () => {
  const { getToken: getCsrfToken } = useCsrf();

  const csrfFetch = useCallback(async (
    url: string,
    options?: RequestInit,
    signal?: AbortSignal
  ): Promise<Response> => {
    const headers = new Headers(options?.headers);

    // Add CSRF token for mutation requests
    const method = options?.method?.toUpperCase() || 'GET';
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
        console.log(`[csrfFetch] ✓ CSRF token added to ${method} ${url}`);
      } else {
        console.error(`[csrfFetch] ✗ NO CSRF TOKEN for ${method} ${url} - Request may fail!`);
      }
    }

    // Always include credentials for session cookies
    // Use provided signal for request cancellation (e.g., from TanStack Query)
    return fetch(url, {
      ...options,
      headers,
      credentials: 'include',
      signal: signal || options?.signal,
    });
  }, [getCsrfToken]);

  return csrfFetch;
};
