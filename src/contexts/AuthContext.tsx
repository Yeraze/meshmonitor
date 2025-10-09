/**
 * Authentication Context
 *
 * Manages user authentication state, login/logout, and permissions
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { logger } from '../utils/logger';

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

export interface PermissionSet {
  dashboard?: { read: boolean; write: boolean };
  nodes?: { read: boolean; write: boolean };
  messages?: { read: boolean; write: boolean };
  settings?: { read: boolean; write: boolean };
  configuration?: { read: boolean; write: boolean };
  info?: { read: boolean; write: boolean };
  automation?: { read: boolean; write: boolean };
}

export interface AuthStatus {
  authenticated: boolean;
  user: User | null;
  permissions: PermissionSet;
  oidcEnabled: boolean;
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

const AuthContext = createContext<AuthContextType | undefined>(undefined);

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
        oidcEnabled: false
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

      // Clear auth state
      setAuthStatus({
        authenticated: false,
        user: null,
        permissions: {},
        oidcEnabled: authStatus?.oidcEnabled || false
      });

      logger.debug('Logout successful');
    } catch (error) {
      logger.error('Logout failed:', error);
      throw error;
    }
  }, [authStatus?.oidcEnabled]);

  // Check if user has specific permission
  const hasPermission = useCallback((resource: keyof PermissionSet, action: 'read' | 'write'): boolean => {
    if (!authStatus?.authenticated) {
      return false;
    }

    // Admins have all permissions
    if (authStatus.user?.isAdmin) {
      return true;
    }

    // Check specific permission
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
