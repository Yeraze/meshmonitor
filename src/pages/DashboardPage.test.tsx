/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from './DashboardPage';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [{ id: 'src-1', name: 'Test Source', type: 'meshtastic_tcp', enabled: true }],
    isSuccess: true,
    isLoading: false,
  })),
  useSourceStatuses: vi.fn(
    () => new Map([['src-1', { sourceId: 'src-1', connected: true }]]),
  ),
  useDashboardSourceData: vi.fn(() => ({
    nodes: [],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: { sourceId: 'src-1', connected: true },
    isLoading: false,
    isError: false,
  })),
  useDashboardUnifiedData: vi.fn(() => ({
    nodes: [],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: null,
    isLoading: false,
    isError: false,
  })),
  useUnifiedStatus: vi.fn(() => ({ nodeCount: 0, connected: false })),
  UNIFIED_SOURCE_ID: '__unified__',
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(() => ({
    authStatus: { authenticated: false, user: null },
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: vi.fn(() => false),
  })),
}));

vi.mock('../contexts/CsrfContext', () => ({
  useCsrf: vi.fn(() => ({
    csrfToken: 'test-token',
    isLoading: false,
    refreshToken: vi.fn(),
    getToken: vi.fn(() => 'test-token'),
  })),
}));

vi.mock('../contexts/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSettings: vi.fn(() => ({
    mapTileset: 'openstreetmap',
    customTilesets: [],
    defaultMapCenterLat: 30.0,
    defaultMapCenterLon: -90.0,
  })),
}));

vi.mock('../components/Dashboard/DashboardSidebar', () => ({
  default: ({ onAddSource, isAdmin }: { onAddSource: () => void; isAdmin: boolean }) => (
    <div data-testid="dashboard-sidebar">
      {isAdmin && (
        <button type="button" onClick={onAddSource}>
          source.add_short
        </button>
      )}
    </div>
  ),
}));

vi.mock('../components/Dashboard/DashboardMap', () => ({
  default: () => <div data-testid="dashboard-map" />,
}));

vi.mock('../components/LoginModal', () => ({
  default: ({ isOpen }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <div data-testid="login-modal" /> : null,
}));

vi.mock('../init', () => ({
  appBasename: '',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage(queryClient?: QueryClient) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Minimal admin auth mock so the "+ Add Source" button renders. */
async function mockAdminAuth() {
  const { useAuth } = await import('../contexts/AuthContext');
  vi.mocked(useAuth).mockReturnValue({
    authStatus: {
      authenticated: true,
      user: {
        id: 1,
        username: 'admin',
        email: null,
        displayName: null,
        authProvider: 'local',
        isAdmin: true,
        isActive: true,
        passwordLocked: false,
        mfaEnabled: false,
        createdAt: 0,
        lastLoginAt: null,
      },
      permissions: {} as any,
      channelDbPermissions: {},
      oidcEnabled: false,
      localAuthDisabled: false,
      anonymousDisabled: false,
      meshcoreEnabled: false,
    },
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: vi.fn(() => true),
    verifyMfa: vi.fn(),
    loginWithOIDC: vi.fn(),
    refreshAuth: vi.fn(),
    hasChannelDbPermission: vi.fn(() => true),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders top bar with "MeshMonitor" text', () => {
    renderPage();
    expect(screen.getByText('MeshMonitor')).toBeInTheDocument();
  });

  it('renders the sidebar', () => {
    renderPage();
    expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
  });

  it('renders the map', () => {
    renderPage();
    expect(screen.getByTestId('dashboard-map')).toBeInTheDocument();
  });

  it('shows "Sign In" button when not authenticated', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /source\.topbar\.sign_in/i })).toBeInTheDocument();
  });

  it('shows username when authenticated', async () => {
    const { useAuth } = await import('../contexts/AuthContext');
    vi.mocked(useAuth).mockReturnValue({
      authStatus: {
        authenticated: true,
        user: {
          id: 1,
          username: 'testuser',
          email: null,
          displayName: null,
          authProvider: 'local',
          isAdmin: false,
          isActive: true,
          passwordLocked: false,
          mfaEnabled: false,
          createdAt: 0,
          lastLoginAt: null,
        },
        permissions: {} as any,
        channelDbPermissions: {},
        oidcEnabled: false,
        localAuthDisabled: false,
        anonymousDisabled: false,
        meshcoreEnabled: false,
      },
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
      hasPermission: vi.fn(() => false),
      verifyMfa: vi.fn(),
      loginWithOIDC: vi.fn(),
      refreshAuth: vi.fn(),
      hasChannelDbPermission: vi.fn(() => false),
    });

    renderPage();
    expect(screen.getByText(/testuser/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Source mutation → cache invalidation (user-reported bug: adding a source
  // doesn't update the sidebar until the 15-second poll fires).
  // -------------------------------------------------------------------------
  describe('source mutations invalidate the source list cache', () => {
    const makeClientWithSpy = () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const spy = vi.spyOn(client, 'invalidateQueries');
      return { client, spy };
    };

    const mockFetchOk = () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'src-new', name: 'New' }),
      }) as any;
    };

    it('invalidates [dashboard, sources] after successful Add Source save', async () => {
      await mockAdminAuth();
      mockFetchOk();
      const { client, spy } = makeClientWithSpy();

      renderPage(client);

      // Open the add-source modal
      fireEvent.click(screen.getByRole('button', { name: /source\.add_short/i }));

      // Fill the minimum required fields via placeholders (translation keys in tests)
      const nameInput = screen.getByPlaceholderText('source.form.name_placeholder') as HTMLInputElement;
      const hostInput = screen.getByPlaceholderText('source.form.host_placeholder') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: 'Test Source' } });
      fireEvent.change(hostInput, { target: { value: '10.0.0.1' } });

      // Save
      fireEvent.click(screen.getByRole('button', { name: /^common\.save$/i }));

      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith({ queryKey: ['dashboard', 'sources'] });
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sources'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('does not invalidate [dashboard, sources] if the save fetch fails', async () => {
      await mockAdminAuth();
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'boom' }),
      }) as any;
      const { client, spy } = makeClientWithSpy();

      renderPage(client);
      fireEvent.click(screen.getByRole('button', { name: /source\.add_short/i }));
      fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), { target: { value: 'X' } });
      fireEvent.change(screen.getByPlaceholderText('source.form.host_placeholder'), { target: { value: '1.2.3.4' } });
      fireEvent.click(screen.getByRole('button', { name: /^common\.save$/i }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });
      // Failed save must NOT invalidate the cache (avoid flapping UI on errors)
      expect(spy).not.toHaveBeenCalledWith({ queryKey: ['dashboard', 'sources'] });
    });
  });
});
