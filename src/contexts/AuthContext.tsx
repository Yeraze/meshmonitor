/**
 * Authentication Context
 *
 * Manages user authentication state, login/logout, and permissions
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import api from '../services/api';
import { logger } from '../utils/logger';
import type { PermissionSet, SourcedPermissionSet } from '../types/permission';
import { isSourceyResource } from '../types/permission';
import { useSource } from './SourceContext';

export interface User {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  authProvider: 'local' | 'oidc';
  isAdmin: boolean;
  isActive: boolean;
  passwordLocked: boolean;
  mfaEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface ChannelDbPermissionSet {
  [channelDbId: number]: { viewOnMap: boolean; read: boolean };
}

export interface AuthStatus {
  authenticated: boolean;
  user: User | null;
  /**
   * Permissions split into non-sourcey (`global`) and per-source (`bySource`).
   * No cross-source union — callers must ask about a specific source via
   * `hasPermission(resource, action, { sourceId })` or via SourceContext.
   */
  permissions: SourcedPermissionSet;
  channelDbPermissions: ChannelDbPermissionSet;
  oidcEnabled: boolean;
  localAuthDisabled: boolean;
  anonymousDisabled: boolean;
  meshcoreEnabled: boolean;
}

export interface LoginResult {
  requireMfa?: boolean;
  success?: boolean;
}

interface AuthContextType {
  authStatus: AuthStatus | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  verifyMfa: (code: string, isBackupCode?: boolean) => Promise<void>;
  loginWithOIDC: () => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  /**
   * Check if the user has a permission.
   *   - For global (non-sourcey) resources: checked against permissions.global.
   *   - For sourcey resources: checked against permissions.bySource[targetSourceId]
   *     where targetSourceId = opts.sourceId ?? current SourceContext sourceId.
   *     If no sourceId is available, the check returns false (no cross-source
   *     union — prevents grant leaks across sources).
   *   - Pass `{ anySource: true }` for cross-source aggregators (unified views):
   *     for sourcey resources the check returns true if ANY source has the
   *     grant. Only use this on views that are intentionally source-agnostic.
   */
  hasPermission: (
    resource: keyof PermissionSet,
    action: 'read' | 'write',
    opts?: { sourceId?: string | null; anySource?: boolean }
  ) => boolean;
  hasChannelDbPermission: (channelDbId: number, action: 'viewOnMap' | 'read') => boolean;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Check authentication status
  const refreshAuth = useCallback(async () => {
    try {
      const response = await api.get<AuthStatus>('/api/auth/status');

      // Fetch channel database permissions if authenticated
      let channelDbPermissions: ChannelDbPermissionSet = {};
      if (response.authenticated && response.user) {
        try {
          const cdPermsResponse = await api.get<{
            data: Array<{ channelDatabaseId: number; canViewOnMap: boolean; canRead: boolean }>;
          }>(`/api/users/${response.user.id}/channel-database-permissions`);

          for (const perm of cdPermsResponse.data || []) {
            channelDbPermissions[perm.channelDatabaseId] = {
              viewOnMap: perm.canViewOnMap,
              read: perm.canRead
            };
          }
        } catch (err) {
          // Non-fatal - user may not have permissions to view this
          logger.debug('Could not fetch channel database permissions:', err);
        }
      }

      setAuthStatus({
        ...response,
        channelDbPermissions
      });
      logger.debug('Auth status refreshed:', response.authenticated);
    } catch (error) {
      logger.error('Failed to fetch auth status:', error);
      // Set unauthenticated state on error
      setAuthStatus({
        authenticated: false,
        user: null,
        permissions: { global: {}, bySource: {} },
        channelDbPermissions: {},
        oidcEnabled: false,
        localAuthDisabled: false,
        anonymousDisabled: false,
        meshcoreEnabled: false
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
  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    try {
      const response = await api.post<{ success?: boolean; requireMfa?: boolean; user?: User }>('/api/auth/login', {
        username,
        password
      });

      // MFA required - return signal to caller
      if (response.requireMfa) {
        return { requireMfa: true };
      }

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

        logger.debug('Login successful - reloading page to apply user preferences');

        // Reload the page to apply user-specific preferences
        window.location.reload();
        return { success: true };
      }

      return {};
    } catch (error) {
      logger.error('Login failed:', error);
      throw error;
    }
  }, [refreshAuth]);

  // MFA verification
  const verifyMfa = useCallback(async (code: string, isBackupCode: boolean = false) => {
    try {
      const body = isBackupCode ? { backupCode: code } : { token: code };
      const response = await api.post<{ success: boolean; user: User }>('/api/auth/verify-mfa', body);

      if (response.success) {
        await refreshAuth();

        // Check session cookie is working
        const statusCheck = await api.get<AuthStatus>('/api/auth/status');
        if (!statusCheck.authenticated) {
          throw new Error('Session cookie not working after MFA verification.');
        }

        logger.debug('MFA verification successful - reloading page');
        window.location.reload();
      }
    } catch (error) {
      logger.error('MFA verification failed:', error);
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

      logger.debug('Logout successful - reloading page to clear user preferences');

      // Reload the page to clear user-specific preferences
      window.location.reload();
    } catch (error) {
      logger.error('Logout failed:', error);
      throw error;
    }
  }, [refreshAuth]);

  // Check if user has specific permission.
  // Callers may pass an explicit sourceId via `opts.sourceId`. When omitted,
  // `useAuth()` fills it in from the active SourceContext (see useAuth below).
  // For sourcey resources with no resolved sourceId, returns false — there is
  // intentionally no cross-source OR-union here.
  const hasPermission = useCallback(
    (
      resource: keyof PermissionSet,
      action: 'read' | 'write',
      opts?: { sourceId?: string | null; anySource?: boolean }
    ): boolean => {
      // If authenticated and admin, grant all permissions
      if (authStatus?.authenticated && authStatus.user?.isAdmin) {
        return true;
      }

      // Check permissions (works for both authenticated and anonymous users)
      // Anonymous user permissions are returned in authStatus.permissions when not authenticated
      if (!authStatus) {
        return false;
      }

      if (isSourceyResource(resource)) {
        if (opts?.anySource) {
          for (const sourceMap of Object.values(authStatus.permissions.bySource)) {
            if (sourceMap[resource]?.[action] === true) return true;
          }
          return false;
        }
        const targetSourceId = opts?.sourceId ?? null;
        if (!targetSourceId) return false;
        const sourceMap = authStatus.permissions.bySource[targetSourceId];
        const resourcePermissions = sourceMap?.[resource];
        return resourcePermissions?.[action] === true;
      }

      // Non-sourcey (global) resources: prefer the global map, but fall back
      // to any per-source row as well. This covers databases where global
      // grants (security, audit, themes, …) were historically saved under a
      // sourceId by the admin PUT endpoint before it learned to split.
      const resourcePermissions = authStatus.permissions.global[resource];
      if (resourcePermissions?.[action] === true) return true;
      for (const sourceMap of Object.values(authStatus.permissions.bySource)) {
        if (sourceMap[resource]?.[action] === true) return true;
      }
      return false;
    },
    [authStatus]
  );

  // Check if user has specific channel database (virtual channel) permission
  const hasChannelDbPermission = useCallback((channelDbId: number, action: 'viewOnMap' | 'read'): boolean => {
    // If authenticated and admin, grant all permissions
    if (authStatus?.authenticated && authStatus.user?.isAdmin) {
      return true;
    }

    if (!authStatus?.channelDbPermissions) {
      return false;
    }

    const channelPermissions = authStatus.channelDbPermissions[channelDbId];
    if (!channelPermissions) {
      return false;
    }

    return channelPermissions[action] === true;
  }, [authStatus]);

  const value: AuthContextType = {
    authStatus,
    loading,
    login,
    verifyMfa,
    loginWithOIDC,
    logout,
    refreshAuth,
    hasPermission,
    hasChannelDbPermission
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

  // Resolve "current source" from SourceContext at the call site so components
  // inside <SourceProvider sourceId={X}> get their permission checks scoped to
  // X automatically. Outside a SourceProvider, `currentSourceId` is null and
  // sourcey permission checks (without an explicit sourceId) return false.
  const { sourceId: currentSourceId } = useSource();

  const boundHasPermission: AuthContextType['hasPermission'] = useMemo(
    () =>
      (resource, action, opts) =>
        context.hasPermission(resource, action, {
          sourceId: opts?.sourceId !== undefined ? opts.sourceId : currentSourceId,
          anySource: opts?.anySource,
        }),
    [context, currentSourceId]
  );

  return { ...context, hasPermission: boundHasPermission };
};
