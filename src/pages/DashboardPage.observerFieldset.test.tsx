/**
 * @vitest-environment jsdom
 *
 * Coverage for the MeshCore Analyzer Observer fieldset in the source
 * add/edit modal (#4457 Phase 3, WP2, spec §4 + §11.4). Mock block copied
 * wholesale from DashboardPage.meshcoreAdminCheckbox.test.tsx per the WP2
 * brief — that file is the working, complete set for this page.
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

describe('MeshCore Analyzer Observer fieldset (#4457 Phase 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSource = makeSource({ ...baseConfig });
  });

  it('pre-populates all four controls from config.observer', async () => {
    currentSource = makeSource({
      ...baseConfig,
      observer: {
        enabled: true,
        brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
        iataCode: 'MCO',
        tokenAudience: 'meshcore-mqtt',
      },
    });
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).toBeChecked();
    expect(screen.getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443')).toHaveValue(
      'wss://mqtt-us-v1.letsmesh.net:443',
    );
    expect(screen.getByPlaceholderText('MCO')).toHaveValue('MCO');
    expect(screen.getByPlaceholderText('meshcore-mqtt')).toHaveValue('meshcore-mqtt');
  });

  it('hides the three inputs until enable is checked, then shows them', async () => {
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).not.toBeChecked();
    expect(screen.queryByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443')).not.toBeInTheDocument();

    fireEvent.click(enable);
    expect(screen.getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('MCO')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('meshcore-mqtt')).toBeInTheDocument();
  });

  it('saves normalized config.observer values without disturbing config.virtualNode', async () => {
    currentSource = makeSource({
      ...baseConfig,
      virtualNode: { enabled: true, port: 5000, allowAdminCommands: true },
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    fireEvent.click(enable);

    fireEvent.change(screen.getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443'), {
      target: { value: '  wss://mqtt-us-v1.letsmesh.net:443  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'mco' } });
    fireEvent.change(screen.getByPlaceholderText('meshcore-mqtt'), {
      target: { value: '  meshcore-mqtt  ' },
    });

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual({
      enabled: true,
      authMode: 'token',
      brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
      iataCode: 'MCO',
      tokenAudience: 'meshcore-mqtt',
    });
    expect(body.config.virtualNode).toEqual({
      enabled: true,
      port: 5000,
      allowAdminCommands: true,
      allowPkiExport: false,
    });
  });

  it('persists enabled: false when the user unchecks and saves', async () => {
    currentSource = makeSource({
      ...baseConfig,
      observer: {
        enabled: true,
        brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
        iataCode: 'MCO',
        tokenAudience: 'meshcore-mqtt',
      },
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).toBeChecked();
    fireEvent.click(enable);
    expect(enable).not.toBeChecked();

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer.enabled).toBe(false);
  });

  it('a source with no observer block loads unchecked and saves enabled: false', async () => {
    mockFetchOk();
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).not.toBeChecked();

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual({
      enabled: false,
      authMode: 'token',
      brokerUrl: '',
      iataCode: '',
      tokenAudience: '',
    });
    expect(body.config.virtualNode).toBeUndefined();
  });

  // ── password auth mode (#4595) ─────────────────────────────────────────────
  it('hides the Token audience field and saves authMode:password when the mode is switched', async () => {
    currentSource = makeSource({
      ...baseConfig,
      observer: {
        enabled: true,
        brokerUrl: 'mqtt://meshcoretel.ru:1883',
        iataCode: 'ALA',
        tokenAudience: 'meshcore-mqtt',
      },
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    // Token mode: the audience field is present.
    expect(await screen.findByPlaceholderText('meshcore-mqtt')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('meshcore.form.observer_auth_mode'), {
      target: { value: 'password' },
    });

    // Password mode: audience gone, broker/region still there.
    await waitFor(() => expect(screen.queryByPlaceholderText('meshcore-mqtt')).toBeNull());
    expect(screen.getByPlaceholderText('MCO')).toBeInTheDocument();

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual({
      enabled: true,
      authMode: 'password',
      brokerUrl: 'mqtt://meshcoretel.ru:1883',
      iataCode: 'ALA',
      // Dropped — a static-credential broker has no audience to match.
      tokenAudience: '',
    });
    // The password itself must never ride along in the config blob — only the
    // `authMode` discriminator may mention the word.
    expect(body.config.observer).not.toHaveProperty('password');
    expect(body.config.observer).not.toHaveProperty('username');
  });

  it('seeds the selector from a stored password-mode block', async () => {
    currentSource = makeSource({
      ...baseConfig,
      observer: {
        enabled: true,
        authMode: 'password',
        brokerUrl: 'mqtt://meshcoretel.ru:1883',
        iataCode: 'ALA',
      },
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    const select = await screen.findByLabelText('meshcore.form.observer_auth_mode');
    expect((select as HTMLSelectElement).value).toBe('password');
    expect(screen.queryByPlaceholderText('meshcore-mqtt')).toBeNull();
  });

  it('rejects an invalid IATA code client-side without issuing a fetch', async () => {
    global.fetch = vi.fn();
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    fireEvent.click(enable);
    fireEvent.change(screen.getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443'), {
      target: { value: 'wss://mqtt-us-v1.letsmesh.net:443' },
    });
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'XX' } });
    fireEvent.change(screen.getByPlaceholderText('meshcore-mqtt'), {
      target: { value: 'meshcore-mqtt' },
    });

    saveModal();

    await screen.findByText('meshcore.form.observer_error_iata');
    expect(findPutCall()).toBeUndefined();
  });

  it('disables the enable checkbox and shows the repeater note for a repeater device', async () => {
    currentSource = makeSource({ ...baseConfig, deviceType: 'repeater' });
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).toBeDisabled();
    expect(screen.getByText('meshcore.form.observer_repeater_note')).toBeInTheDocument();
  });

  it('maps a server-side OBSERVER_REQUIRES_COMPANION error onto its i18n key', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({
        success: false,
        error: 'The Analyzer Observer requires a Companion device',
        code: 'OBSERVER_REQUIRES_COMPANION',
      }),
    }) as any;
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    fireEvent.click(enable);
    fireEvent.change(screen.getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443'), {
      target: { value: 'wss://mqtt-us-v1.letsmesh.net:443' },
    });
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'MCO' } });
    fireEvent.change(screen.getByPlaceholderText('meshcore-mqtt'), {
      target: { value: 'meshcore-mqtt' },
    });

    saveModal();

    await screen.findByText('meshcore.form.observer_error_requires_companion');
  });
});
