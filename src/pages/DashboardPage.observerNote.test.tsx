/**
 * @vitest-environment jsdom
 *
 * The source add/edit modal and the MeshCore Analyzer Observer (#5831).
 * The Observer's broker list used to be edited here (#4457 Phase 3, #5014
 * Phase 2); it moved to the MeshCore Configuration page. The modal now shows
 * a note with a link and carries the stored block through a save unchanged.
 * The editor itself is covered by
 * src/components/MeshCore/MeshCoreObserverSection.brokerEditor.test.tsx.
 *
 * The global react-i18next mock returns the raw key, so assertions match keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DashboardPage from './DashboardPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const baseConfig = {
  transport: 'usb',
  port: '/dev/ttyACM0',
  deviceType: 'companion',
  autoConnect: true,
};

function makeSource(config: Record<string, any>) {
  return {
    id: 'src-mc',
    name: 'MC Source',
    type: 'meshcore',
    enabled: true,
    config,
  };
}

let currentSource = makeSource({ ...baseConfig });

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [currentSource],
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

function openEditModal() {
  fireEvent.click(screen.getByRole('button', { name: 'edit-MC Source' }));
}

function saveModal() {
  fireEvent.click(screen.getByRole('button', { name: /^common\.save$/i }));
}

function mockFetchOk() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ...currentSource }),
  }) as any;
}

function findPutCall() {
  return (global.fetch as any).mock.calls.find(
    ([url, init]: [string, RequestInit]) => url === '/api/sources/src-mc' && init?.method === 'PUT',
  );
}

const storedObserver = {
  enabled: true,
  authMode: 'token',
  iataCode: 'MCO',
  brokers: [
    { url: 'wss://mqtt.meshmapper.net:443', authMode: 'token', tokenAudience: 'mqtt.meshmapper.net', label: 'MeshMapper' },
    { url: 'mqtts://regional.example:8883', authMode: 'password' },
  ],
};

describe('Source modal: the Analyzer Observer moved to MeshCore Configuration (#5831)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSource = makeSource({ ...baseConfig });
  });

  it('no longer edits the Observer: no enable box, region, broker rows, presets or credential fields', async () => {
    currentSource = makeSource({ ...baseConfig, observer: storedObserver });
    renderPage();
    openEditModal();

    const note = await screen.findByTestId('observer-moved-note');
    expect(within(note).getByText('meshcore.form.observer_moved')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'meshcore.form.observer_enable' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('MCO')).not.toBeInTheDocument();
    expect(screen.queryByTestId('observer-broker-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/observer-broker-row-/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /observer_preset_/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/observer_broker_password/)).not.toBeInTheDocument();
  });

  it('links to the MeshCore Configuration page', async () => {
    renderPage();
    openEditModal();
    const note = await screen.findByTestId('observer-moved-note');
    fireEvent.click(within(note).getByRole('button', { name: /meshcore\.form\.observer_open_config/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/source/src-mc/#configuration');
  });

  it('a save carries the stored observer block through unchanged, without the list-only brokerCount', async () => {
    currentSource = makeSource({
      ...baseConfig,
      observer: { ...storedObserver, brokerCount: 2 },
      virtualNode: { enabled: true, port: 5000, allowAdminCommands: true },
    });
    mockFetchOk();
    renderPage();
    openEditModal();
    await screen.findByTestId('observer-moved-note');

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual(storedObserver);
    expect(body.config.virtualNode.port).toBe(5000);
    // One source PUT; no observer status/credential calls from this form.
    const urls = (global.fetch as any).mock.calls.map(([url]: [string]) => url);
    expect(urls.some((u: string) => u.includes('/observer/'))).toBe(false);
  });

  it('a source with no observer block saves without one', async () => {
    mockFetchOk();
    renderPage();
    openEditModal();
    await screen.findByTestId('observer-moved-note');

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config).not.toHaveProperty('observer');
  });

  it('a repeater turns a stored enabled observer off rather than failing the save', async () => {
    currentSource = makeSource({ ...baseConfig, deviceType: 'repeater', observer: storedObserver });
    mockFetchOk();
    renderPage();
    openEditModal();
    const note = await screen.findByTestId('observer-moved-note');
    expect(within(note).getByText('meshcore.form.observer_repeater_note')).toBeInTheDocument();

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual({ ...storedObserver, enabled: false });
  });

  it('maps a server-side observer error code onto its i18n key', async () => {
    currentSource = makeSource({ ...baseConfig, observer: storedObserver });
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/sources/src-mc' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 400,
          headers: { get: () => null },
          json: async () => ({ success: false, error: 'requires companion', code: 'OBSERVER_REQUIRES_COMPANION' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ...currentSource }) });
    }) as any;
    renderPage();
    openEditModal();
    await screen.findByTestId('observer-moved-note');

    saveModal();

    expect(await screen.findByText('meshcore.form.observer_error_requires_companion')).toBeInTheDocument();
  });
});
