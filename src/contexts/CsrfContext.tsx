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
      // Use absolute path to work with BASE_URL
      const response = await fetch('/api/csrf-token', {
        credentials: 'include',
      });

      if (!response.ok) {
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
