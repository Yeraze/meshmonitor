/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
  default: () => <div data-testid="dashboard-sidebar" />,
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

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
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
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
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
});
