/**
 * Tests for AuthContext
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AuthProvider, useAuth, AuthContext } from './AuthContext';

// ─── Mock api service ─────────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../services/api', () => ({ default: mockApi }));

// ─── Mock logger ──────────────────────────────────────────────────────────────

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ─── Mock window.location ────────────────────────────────────────────────────

const mockReload = vi.fn();
Object.defineProperty(window, 'location', {
  value: { reload: mockReload, href: '' },
  writable: true,
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockUser = {
  id: 1,
  username: 'admin',
  email: 'admin@test.com',
  displayName: 'Admin User',
  authProvider: 'local' as const,
  isAdmin: false,
  isActive: true,
  passwordLocked: false,
  mfaEnabled: false,
  createdAt: Date.now(),
  lastLoginAt: null,
};

const TEST_SOURCE_ID = 'src-a';

const mockAuthStatus = {
  authenticated: true,
  user: mockUser,
  permissions: {
    global: {},
    bySource: {
      [TEST_SOURCE_ID]: {
        nodes: { read: true, write: false },
        messages: { read: true, write: true },
      },
    },
  },
  channelDbPermissions: {
    1: { viewOnMap: true, read: true },
    2: { viewOnMap: false, read: true },
  },
  oidcEnabled: false,
  localAuthDisabled: false,
  anonymousDisabled: false,
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

// ─── Setup ────────────────────────────────────────────────────────────────────

const defaultChannelDbPerms = [
  { channelDatabaseId: 1, canViewOnMap: true, canRead: true },
  { channelDatabaseId: 2, canViewOnMap: false, canRead: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockReload.mockClear();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/auth/status') return Promise.resolve(mockAuthStatus);
    if (url.includes('channel-database-permissions')) return Promise.resolve({ data: defaultChannelDbPerms });
    return Promise.resolve({});
  });
  mockApi.post.mockResolvedValue({ success: true });
});

// ─── useAuth outside provider ─────────────────────────────────────────────────

describe('useAuth', () => {
  it('throws when used outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(
      'useAuth must be used within an AuthProvider'
    );
  });
});

// ─── AuthProvider — initial load ──────────────────────────────────────────────

describe('AuthProvider — initial load', () => {
  it('starts with loading=true and calls refreshAuth on mount', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockApi.get).toHaveBeenCalledWith('/api/auth/status');
  });

  it('sets authStatus after successful fetch', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authStatus?.authenticated).toBe(true);
    expect(result.current.authStatus?.user?.username).toBe('admin');
  });

  it('sets unauthenticated state on fetch error', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.reject(new Error('Network error'));
      return Promise.resolve({ data: [] });
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authStatus?.authenticated).toBe(false);
    expect(result.current.authStatus?.user).toBeNull();
  });

  it('fetches channel db permissions when authenticated', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.resolve(mockAuthStatus);
      if (url.includes('channel-database-permissions')) {
        return Promise.resolve({ data: [{ channelDatabaseId: 5, canViewOnMap: true, canRead: true }] });
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.authStatus?.channelDbPermissions[5]).toEqual({
      viewOnMap: true,
      read: true,
    });
  });

  it('does not fail when channel db permissions fetch errors', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.resolve(mockAuthStatus);
      if (url.includes('channel-database-permissions')) {
        return Promise.reject(new Error('forbidden'));
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Still loaded, just no extra permissions
    expect(result.current.authStatus?.authenticated).toBe(true);
  });
});

// ─── hasPermission ────────────────────────────────────────────────────────────

describe('hasPermission', () => {
  it('returns false when authStatus is null (still loading)', () => {
    mockApi.get.mockImplementation(() => new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.hasPermission('nodes', 'read')).toBe(false);
  });

  it('returns true for admin user regardless of resource', async () => {
    const adminStatus = {
      ...mockAuthStatus,
      user: { ...mockUser, isAdmin: true },
      permissions: { global: {}, bySource: {} },
    };
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.resolve(adminStatus);
      if (url.includes('channel-database-permissions')) return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasPermission('nodes', 'read')).toBe(true);
    expect(result.current.hasPermission('messages', 'write')).toBe(true);
  });

  it('returns true for resource with read permission (sourcey — pass sourceId)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasPermission('nodes', 'read', { sourceId: TEST_SOURCE_ID })).toBe(true);
  });

  it('returns false for sourcey resource without sourceId (no cross-source leak)', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // `nodes` is granted on TEST_SOURCE_ID only. Without an explicit sourceId
    // and outside a SourceProvider, the check must return false — this is the
    // fix for the cross-source permission leak.
    expect(result.current.hasPermission('nodes', 'read')).toBe(false);
  });

  it('returns false for resource without write permission', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasPermission('nodes', 'write', { sourceId: TEST_SOURCE_ID })).toBe(false);
  });

  it('returns false for unknown resource', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasPermission('unknown_resource' as any, 'read')).toBe(false);
  });
});

// ─── hasChannelDbPermission ───────────────────────────────────────────────────

describe('hasChannelDbPermission', () => {
  it('returns false when no authStatus', () => {
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.hasChannelDbPermission(1, 'read')).toBe(false);
  });

  it('returns true for admin user for all channel databases', async () => {
    const adminStatus = {
      ...mockAuthStatus,
      user: { ...mockUser, isAdmin: true },
    };
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.resolve(adminStatus);
      if (url.includes('channel-database-permissions')) return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasChannelDbPermission(999, 'read')).toBe(true);
    expect(result.current.hasChannelDbPermission(999, 'viewOnMap')).toBe(true);
  });

  it('returns true for channel with viewOnMap permission', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasChannelDbPermission(1, 'viewOnMap')).toBe(true);
  });

  it('returns false for channel without viewOnMap permission', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasChannelDbPermission(2, 'viewOnMap')).toBe(false);
  });

  it('returns false for unknown channel database', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasChannelDbPermission(99, 'read')).toBe(false);
  });
});

// ─── login ────────────────────────────────────────────────────────────────────

describe('login', () => {
  it('returns requireMfa=true when server requires MFA', async () => {
    mockApi.post.mockResolvedValue({ requireMfa: true });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const loginResult = await act(() =>
      result.current.login('admin', 'password')
    );
    expect(loginResult.requireMfa).toBe(true);
  });

  it('throws when login API call fails', async () => {
    mockApi.post.mockRejectedValue(new Error('Unauthorized'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(() => result.current.login('admin', 'badpassword'))
    ).rejects.toThrow('Unauthorized');
  });

  it('throws on cookie configuration issue when login succeeds but status is unauthenticated', async () => {
    // login succeeds but the follow-up status check says not authenticated
    let callCount = 0;
    mockApi.post.mockResolvedValue({ success: true });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') {
        callCount++;
        if (callCount === 1) return Promise.resolve(mockAuthStatus); // mount
        return Promise.resolve({ ...mockAuthStatus, authenticated: false }); // after login
      }
      if (url.includes('channel-database-permissions')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(() => result.current.login('admin', 'password'))
    ).rejects.toThrow(/Session cookie/);
  });
});

// ─── logout ───────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('calls /api/auth/logout and then refreshAuth', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const getCallsBefore = mockApi.get.mock.calls.length;
    await act(() => result.current.logout());
    expect(mockApi.post).toHaveBeenCalledWith('/api/auth/logout', {});
    // refreshAuth is called again after logout (additional get calls)
    expect(mockApi.get.mock.calls.length).toBeGreaterThan(getCallsBefore);
  });

  it('throws when logout API call fails', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockApi.post.mockRejectedValue(new Error('Server error'));
    await expect(act(() => result.current.logout())).rejects.toThrow('Server error');
  });
});

// ─── loginWithOIDC ────────────────────────────────────────────────────────────

describe('loginWithOIDC', () => {
  it('redirects to authUrl from server', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.resolve(mockAuthStatus);
      if (url === '/api/auth/oidc/login') return Promise.resolve({ authUrl: 'https://oidc.example.com/auth' });
      if (url.includes('channel-database-permissions')) return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.loginWithOIDC());
    expect(window.location.href).toBe('https://oidc.example.com/auth');
  });

  it('throws when OIDC login API fails', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/auth/status') return Promise.resolve(mockAuthStatus);
      if (url === '/api/auth/oidc/login') return Promise.reject(new Error('OIDC not configured'));
      if (url.includes('channel-database-permissions')) return Promise.resolve({ data: [] });
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(act(() => result.current.loginWithOIDC())).rejects.toThrow(
      'OIDC not configured'
    );
  });
});
