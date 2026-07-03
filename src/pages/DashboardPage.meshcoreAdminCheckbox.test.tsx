/**
 * @vitest-environment jsdom
 *
 * Regression coverage for issue #3904 / PR #3905: the MeshCore Edit Source
 * form's save path used to hardcode `allowAdminCommands: false` regardless
 * of any UI state, and the checkbox itself didn't exist. These tests pin
 * both the load (pre-population) and save (persistence) directions so the
 * bug can't silently reappear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from './DashboardPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const meshcoreSource = {
  id: 'src-mc',
  name: 'MC Source',
  type: 'meshcore',
  enabled: true,
  config: {
    transport: 'usb',
    port: '/dev/ttyACM0',
    deviceType: 'companion',
    autoConnect: true,
    virtualNode: { enabled: true, port: 5000, allowAdminCommands: true },
  },
};

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [meshcoreSource],
    isSuccess: true,
    isLoading: false,
  })),
  useSourceStatuses: vi.fn(() => new Map([['src-mc', { sourceId: 'src-mc', connected: true }]])),
  useDashboardSourceData: vi.fn(() => ({
    nodes: [],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: { sourceId: 'src-mc', connected: true },
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

vi.mock('../hooks/useMapAnalysisData', () => ({
  useMeshCoreNeighbors: vi.fn(() => ({ data: { items: [] }, isLoading: false, isError: false })),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(() => ({
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
    },
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    hasPermission: vi.fn(() => true),
    verifyMfa: vi.fn(),
    loginWithOIDC: vi.fn(),
    refreshAuth: vi.fn(),
    hasChannelDbPermission: vi.fn(() => true),
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
    defaultLandingPage: 'unified',
  })),
}));

// Exposes an "Edit" button per source so the test can drive onEditSource
// without needing the real sidebar's markup.
vi.mock('../components/Dashboard/DashboardSidebar', () => ({
  default: ({
    sources,
    onEditSource,
  }: {
    sources: Array<{ id: string; name: string }>;
    onEditSource: (id: string) => void;
  }) => (
    <div data-testid="dashboard-sidebar">
      {sources.map((s) => (
        <button key={s.id} type="button" onClick={() => onEditSource(s.id)}>
          edit-{s.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../components/Dashboard/DashboardMap', () => ({
  default: () => <div data-testid="dashboard-map" />,
}));

vi.mock('../components/LoginModal', () => ({
  default: ({ isOpen }: { isOpen: boolean; onClose: () => void }) =>
    (isOpen ? <div data-testid="login-modal" /> : null),
}));

vi.mock('../init', () => ({
  appBasename: '',
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MeshCore virtual node "Allow admin commands" checkbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pre-populates checked when the source config has allowAdminCommands: true', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'edit-MC Source' }));

    const checkbox = await screen.findByRole('checkbox', {
      name: 'meshcore.form.allow_admin_commands',
    });
    expect(checkbox).toBeChecked();
  });

  it('persists allowAdminCommands: false when the user unchecks it and saves', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...meshcoreSource }),
    }) as any;

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'edit-MC Source' }));

    const checkbox = await screen.findByRole('checkbox', {
      name: 'meshcore.form.allow_admin_commands',
    });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^common\.save$/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/sources/src-mc',
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const call = (global.fetch as any).mock.calls.find(([url]: [string]) => url === '/api/sources/src-mc');
    const body = JSON.parse(call[1].body as string);
    expect(body.config.virtualNode.allowAdminCommands).toBe(false);
  });
});
