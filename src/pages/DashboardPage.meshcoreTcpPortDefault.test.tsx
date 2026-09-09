/**
 * @vitest-environment jsdom
 *
 * MeshCore TCP source port default (#5160).
 *
 * Reported by mattch: adding a MeshCore TCP source pre-filled 4403 — the
 * Meshtastic port — so the source failed to connect until the user worked out
 * the right number. MeshCore's WiFi/Ethernet companion builds listen on 5000.
 *
 * 4403 is not a typo, which is why this is pinned rather than left to a
 * constant nobody reads: MeshCore's less common "native TCP" builds DO use it,
 * and `meshcoreConfig.ts` still falls back to it for a stored config with no
 * port. The form default and that fallback deliberately differ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from './DashboardPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/** A TCP source whose stored config carries no port — the edit fallback path. */
const meshcoreSource = {
  id: 'src-mc',
  name: 'MC Source',
  type: 'meshcore',
  enabled: true,
  config: {
    transport: 'tcp',
    tcpHost: 'mc.example',
    deviceType: 'companion',
    autoConnect: true,
  },
};

/** Same, but with an explicit port that must survive untouched. */
const meshcoreSourceWithPort = {
  ...meshcoreSource,
  id: 'src-mc-port',
  name: 'MC Ported',
  config: { ...meshcoreSource.config, tcpPort: 4403 },
};

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [meshcoreSource, meshcoreSourceWithPort],
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
  useNodeListStyle: () => 'monochrome',
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
    onAddSource,
  }: {
    sources: Array<{ id: string; name: string }>;
    onEditSource: (id: string) => void;
    onAddSource: () => void;
  }) => (
    <div data-testid="dashboard-sidebar">
      <button type="button" onClick={onAddSource}>add-source</button>
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

/** The MeshCore TCP port input, found by its label. */
const portInput = async () =>
  (await screen.findByText('source.form.tcp_port')).parentElement!.querySelector(
    'input[type="number"]',
  ) as HTMLInputElement;

describe('MeshCore TCP port default (#5160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pre-fills 5000 when adding a new MeshCore TCP source', async () => {
    // The reported bug, exactly: this used to read 4403 and the source could
    // not connect until the user changed it by hand.
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'add-source' }));
    fireEvent.change(await screen.findByDisplayValue('source.form.type_meshtastic'), {
      target: { value: 'meshcore' },
    });
    fireEvent.change(await screen.findByDisplayValue('meshcore.form.transport_usb'), {
      target: { value: 'tcp' },
    });

    expect((await portInput()).value).toBe('5000');
  });

  it('offers 5000 as the placeholder too', async () => {
    // The placeholder was also 4403. Leaving it behind would have the field
    // contradict itself the moment someone cleared it.
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'add-source' }));
    fireEvent.change(await screen.findByDisplayValue('source.form.type_meshtastic'), {
      target: { value: 'meshcore' },
    });
    fireEvent.change(await screen.findByDisplayValue('meshcore.form.transport_usb'), {
      target: { value: 'tcp' },
    });

    expect((await portInput()).placeholder).toBe('5000');
  });

  it('falls back to 5000 when editing a source that stored no port', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'edit-MC Source' }));

    expect((await portInput()).value).toBe('5000');
  });

  it('leaves an explicitly stored port alone', async () => {
    // The guard on the fallback: a source deliberately pointed at a native-TCP
    // build on 4403 must not be silently rewritten to 5000 by opening its form.
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'edit-MC Ported' }));

    expect((await portInput()).value).toBe('4403');
  });
});
