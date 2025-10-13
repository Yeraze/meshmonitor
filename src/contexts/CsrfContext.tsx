/**
 * CSRF Token Management Context
 *
 * Provides CSRF token management for secure API requests.
 * Automatically fetches and refreshes tokens as needed.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';

interface CsrfContextType {
  csrfToken: string | null;
  isLoading: boolean;
  refreshToken: () => Promise<void>;
  getToken: () => string | null;
}

const CsrfContext = createContext<CsrfContextType | undefined>(undefined);

export const CsrfProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchToken = useCallback(async () => {
    try {
      setIsLoading(true);

      // Try to detect BASE_URL from current pathname
      // For /meshmonitor/..., we want /meshmonitor/api/csrf-token
      // For /..., we want /api/csrf-token
      const pathname = window.location.pathname;
      const pathParts = pathname.split('/').filter(Boolean);

      // Build potential CSRF token paths
      const potentialPaths: string[] = ['/api/csrf-token'];

      // Add paths from most specific to least specific
      // Stop at known app routes (dashboard, nodes, messages, etc.)
      const appRoutes = ['dashboard', 'nodes', 'messages', 'map', 'traceroute', 'telemetry', 'settings'];
      for (let i = pathParts.length; i > 0; i--) {
        if (appRoutes.includes(pathParts[i - 1])) break;
        const basePath = '/' + pathParts.slice(0, i).join('/');
        potentialPaths.push(`${basePath}/api/csrf-token`);
      }

      // Try each potential path until one works
      let response: Response | null = null;
      let lastError: Error | null = null;

      for (const csrfPath of potentialPaths) {
        try {
          response = await fetch(csrfPath, {
            credentials: 'include',
          });

          if (response.ok) {
            break; // Found working path
          }
        } catch (error) {
          lastError = error as Error;
        }
      }

      if (!response || !response.ok) {
        throw lastError || new Error(`Failed to fetch CSRF token: ${response?.status}`);
      }

      const data = await response.json();
      const token = data.csrfToken;

      if (!token) {
        throw new Error('CSRF token not found in response');
      }

      setCsrfToken(token);
      // Also store in sessionStorage as backup
      sessionStorage.setItem('csrfToken', token);
      logger.debug('CSRF token fetched successfully');
    } catch (error) {
      logger.error('Failed to fetch CSRF token:', error);
      // Try to use cached token from sessionStorage
      const cachedToken = sessionStorage.getItem('csrfToken');
      if (cachedToken) {
        logger.debug('Using cached CSRF token');
        setCsrfToken(cachedToken);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshToken = useCallback(async () => {
    logger.debug('Refreshing CSRF token...');
    await fetchToken();
  }, [fetchToken]);

  const getToken = useCallback(() => {
    return csrfToken || sessionStorage.getItem('csrfToken');
  }, [csrfToken]);

  // Fetch token on mount
  useEffect(() => {
    fetchToken();
  }, [fetchToken]);

  const value: CsrfContextType = {
    csrfToken,
    isLoading,
    refreshToken,
    getToken,
  };

  return <CsrfContext.Provider value={value}>{children}</CsrfContext.Provider>;
};

export const useCsrf = (): CsrfContextType => {
  const context = useContext(CsrfContext);
  if (context === undefined) {
    throw new Error('useCsrf must be used within a CsrfProvider');
  }
  return context;
};
