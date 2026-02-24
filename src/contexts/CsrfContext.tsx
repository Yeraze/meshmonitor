/**
 * CSRF Token Management Context
 *
 * Provides CSRF token management for secure API requests.
 * Automatically fetches and refreshes tokens as needed.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';
import api from '../services/api';

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

      // Use the API service's BASE_URL detection to ensure consistency
      const baseUrl = await api.getBaseUrl();
      const csrfUrl = `${baseUrl}/api/csrf-token`;

      console.log('[CSRF] Fetching token from:', csrfUrl);

      const response = await fetch(csrfUrl, {
        credentials: 'include',
      });

      if (!response.ok) {
        console.error('[CSRF] Token fetch failed:', response.status);
        throw new Error(`Failed to fetch CSRF token: ${response.status}`);
      }

      const data = await response.json();
      const token = data.csrfToken;

      if (!token) {
        throw new Error('CSRF token not found in response');
      }

      setCsrfToken(token);
      // Also store in sessionStorage as backup
      sessionStorage.setItem('csrfToken', token);
      console.log('[CSRF] Token fetched and stored successfully');
    } catch (error) {
      console.error('[CSRF] Failed to fetch token:', error);
      // Try to use cached token from sessionStorage
      const cachedToken = sessionStorage.getItem('csrfToken');
      if (cachedToken) {
        console.log('[CSRF] Using cached token from sessionStorage');
        setCsrfToken(cachedToken);
      } else {
        console.error('[CSRF] No cached token available');
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
