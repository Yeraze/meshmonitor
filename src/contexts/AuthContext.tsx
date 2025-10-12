/**
 * Authentication Context
 *
 * Manages user authentication state, login/logout, and permissions
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { logger } from '../utils/logger';
import type { PermissionSet } from '../types/permission';

export interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  authProvider: 'local' | 'oidc';
  isAdmin: boolean;
  isActive: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AuthStatus {
  authenticated: boolean;
  user: User | null;
  permissions: PermissionSet;
  oidcEnabled: boolean;
  localAuthDisabled: boolean;
}

interface AuthContextType {
  authStatus: AuthStatus | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginWithOIDC: () => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  hasPermission: (resource: keyof PermissionSet, action: 'read' | 'write') => boolean;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Check authentication status
  const refreshAuth = useCallback(async () => {
    try {
      const response = await api.get<AuthStatus>('/api/auth/status');
      setAuthStatus(response);
      logger.debug('Auth status refreshed:', response.authenticated);
    } catch (error) {
      logger.error('Failed to fetch auth status:', error);
      // Set unauthenticated state on error
      setAuthStatus({
        authenticated: false,
        user: null,
        permissions: {},
        oidcEnabled: false,
        localAuthDisabled: false
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Check auth status on mount
  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  // Local authentication
  const login = useCallback(async (username: string, password: string) => {
    try {
      const response = await api.post<{ success: boolean; user: User }>('/api/auth/login', {
        username,
        password
      });

      if (response.success) {
        // Refresh auth status to get permissions
        await refreshAuth();

        // Check if the refresh actually authenticated us
        // If login succeeded but status shows unauthenticated, we have a cookie issue
        const statusCheck = await api.get<AuthStatus>('/api/auth/status');
        if (!statusCheck.authenticated) {
          logger.error('Cookie configuration issue detected!');
          logger.error('Login succeeded but session cookie is not being sent by browser');
          throw new Error('Session cookie not working. This may be due to:\n' +
            '1. Accessing via HTTP when secure cookies are enabled\n' +
            '2. Browser blocking cookies\n' +
            '3. Reverse proxy misconfiguration\n\n' +
            'Check browser console and server logs for details.');
        }

        logger.debug('Login successful');
      }
    } catch (error) {
      logger.error('Login failed:', error);
      throw error;
    }
  }, [refreshAuth]);

  // OIDC authentication
  const loginWithOIDC = useCallback(async () => {
    try {
      // Get authorization URL from backend
      const response = await api.get<{ authUrl: string }>('/api/auth/oidc/login');

      // Redirect to OIDC provider
      window.location.href = response.authUrl;
    } catch (error) {
      logger.error('OIDC login failed:', error);
      throw error;
    }
  }, []);

  // Logout
  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout', {});

      // Refresh auth status to get anonymous user permissions
      await refreshAuth();

      logger.debug('Logout successful');
    } catch (error) {
      logger.error('Logout failed:', error);
      throw error;
    }
  }, [refreshAuth]);

  // Check if user has specific permission
  const hasPermission = useCallback((resource: keyof PermissionSet, action: 'read' | 'write'): boolean => {
    // If authenticated and admin, grant all permissions
    if (authStatus?.authenticated && authStatus.user?.isAdmin) {
      return true;
    }

    // Check permissions (works for both authenticated and anonymous users)
    // Anonymous user permissions are returned in authStatus.permissions when not authenticated
    if (!authStatus) {
      return false;
    }

    const resourcePermissions = authStatus.permissions[resource];
    if (!resourcePermissions) {
      return false;
    }

    return resourcePermissions[action] === true;
  }, [authStatus]);

  const value: AuthContextType = {
    authStatus,
    loading,
    login,
    loginWithOIDC,
    logout,
    refreshAuth,
    hasPermission
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
