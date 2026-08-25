/**
 * @vitest-environment jsdom
 *
 * Coverage for the Reticulum source fieldset in the source add/edit modal
 * (#3960 Phase 1b, WP6). Mock block copied wholesale from
 * DashboardPage.observerFieldset.test.tsx — that file is the working,
 * complete mock set for this page.
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

function makeSource(config: Record<string, any>) {
  return {
    id: 'src-rns',
    name: 'RNS Source',
    type: 'reticulum',
    enabled: true,
    config,
  };
}

let currentSource = makeSource({ mode: 'attach', configDir: '/rns', autoConnect: true });

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [currentSource],
    isSuccess: true,
    isLoading: false,
  })),
  useSourceStatuses: vi.fn(() => new Map([['src-rns', { sourceId: 'src-rns', connected: true }]])),
  useDashboardSourceData: vi.fn(() => ({
    nodes: [],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: { sourceId: 'src-rns', connected: true },
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

// Exposes an "Add" button and an "Edit" button per source so the test can
// drive onAddSource/onEditSource without needing the real sidebar's markup.
vi.mock('../components/Dashboard/DashboardSidebar', () => ({
  default: ({
    sources,
    onAddSource,
    onEditSource,
  }: {
    sources: Array<{ id: string; name: string }>;
    onAddSource: () => void;
    onEditSource: (id: string) => void;
  }) => (
    <div data-testid="dashboard-sidebar">
      <button type="button" onClick={onAddSource}>
        source.add_short
      </button>
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

function openAddModal() {
  fireEvent.click(screen.getByRole('button', { name: 'source.add_short' }));
}

function openEditModal() {
  fireEvent.click(screen.getByRole('button', { name: 'edit-RNS Source' }));
}

function selectReticulumType() {
  fireEvent.change(screen.getByLabelText('source.form.type'), { target: { value: 'reticulum' } });
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

function findPostCall() {
  return (global.fetch as any).mock.calls.find(
    ([url, init]: [string, RequestInit]) => url === '/api/sources' && init?.method === 'POST',
  );
}

function findPutCall() {
  return (global.fetch as any).mock.calls.find(
    ([url, init]: [string, RequestInit]) => url === '/api/sources/src-rns' && init?.method === 'PUT',
  );
}

describe('Reticulum source fieldset (#3960 Phase 1b WP6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSource = makeSource({ mode: 'attach', configDir: '/rns', autoConnect: true });
  });

  // ── field visibility ──────────────────────────────────────────────────
  it('shows the config-dir field for attach mode and hides the peer fields', () => {
    renderPage();
    openAddModal();
    selectReticulumType();

    expect(screen.getByPlaceholderText('/rns')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('amsterdam.connect.reticulum.network')).not.toBeInTheDocument();
  });

  it('shows the peer host/port fields for tcp_peer mode and hides config-dir', () => {
    renderPage();
    openAddModal();
    selectReticulumType();

    fireEvent.change(screen.getByLabelText('reticulum.form.mode'), { target: { value: 'tcp_peer' } });

    expect(screen.getByPlaceholderText('amsterdam.connect.reticulum.network')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('4965')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('/rns')).not.toBeInTheDocument();
  });

  // ── config serialization ──────────────────────────────────────────────
  it('POSTs an attach-mode ReticulumSourceConfig', async () => {
    mockFetchOk();
    renderPage();
    openAddModal();
    selectReticulumType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'My RNS' },
    });
    fireEvent.change(screen.getByPlaceholderText('/rns'), { target: { value: '/home/user/.reticulum' } });
    fireEvent.change(screen.getByPlaceholderText('ws://127.0.0.1:8765'), {
      target: { value: '  ws://127.0.0.1:8765  ' },
    });
    fireEvent.change(screen.getByLabelText('reticulum.form.token'), { target: { value: '  s3cret  ' } });

    saveModal();

    await waitFor(() => expect(findPostCall()).toBeTruthy());
    const body = JSON.parse(findPostCall()![1].body as string);
    expect(body.type).toBe('reticulum');
    expect(body.config).toEqual({
      mode: 'attach',
      autoConnect: true,
      bridgeUrl: 'ws://127.0.0.1:8765',
      token: 's3cret',
      configDir: '/home/user/.reticulum',
    });
  });

  it('POSTs a tcp_peer-mode ReticulumSourceConfig with no bridgeUrl/token when left blank', async () => {
    mockFetchOk();
    renderPage();
    openAddModal();
    selectReticulumType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'My RNS Peer' },
    });
    fireEvent.change(screen.getByLabelText('reticulum.form.mode'), { target: { value: 'tcp_peer' } });
    fireEvent.change(screen.getByPlaceholderText('amsterdam.connect.reticulum.network'), {
      target: { value: 'rns.example.org' },
    });
    fireEvent.change(screen.getByPlaceholderText('4965'), { target: { value: '4242' } });

    saveModal();

    await waitFor(() => expect(findPostCall()).toBeTruthy());
    const body = JSON.parse(findPostCall()![1].body as string);
    expect(body.config).toEqual({
      mode: 'tcp_peer',
      autoConnect: true,
      peers: [{ host: 'rns.example.org', port: 4242 }],
    });
  });

  // ── validation ─────────────────────────────────────────────────────────
  it('rejects attach mode with a blank config dir, without issuing a fetch', async () => {
    global.fetch = vi.fn();
    renderPage();
    openAddModal();
    selectReticulumType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'My RNS' },
    });
    saveModal();

    await screen.findByText('source.form.error_reticulum_config_dir_required');
    expect(findPostCall()).toBeUndefined();
  });

  it('rejects tcp_peer mode with a blank host, without issuing a fetch', async () => {
    global.fetch = vi.fn();
    renderPage();
    openAddModal();
    selectReticulumType();
    fireEvent.change(screen.getByLabelText('reticulum.form.mode'), { target: { value: 'tcp_peer' } });

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'My RNS Peer' },
    });
    saveModal();

    await screen.findByText('source.form.error_host_required');
    expect(findPostCall()).toBeUndefined();
  });

  it('rejects a non-ws(s) bridge URL, without issuing a fetch', async () => {
    global.fetch = vi.fn();
    renderPage();
    openAddModal();
    selectReticulumType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'My RNS' },
    });
    fireEvent.change(screen.getByPlaceholderText('/rns'), { target: { value: '/rns' } });
    fireEvent.change(screen.getByPlaceholderText('ws://127.0.0.1:8765'), {
      target: { value: 'http://127.0.0.1:8765' },
    });
    saveModal();

    await screen.findByText('source.form.error_reticulum_bridge_url');
    expect(findPostCall()).toBeUndefined();
  });

  // ── edit hydration round-trip ────────────────────────────────────────
  it('hydrates tcp_peer fields from config on edit and round-trips them on save', async () => {
    currentSource = makeSource({
      mode: 'tcp_peer',
      peers: [{ host: 'rns.example.org', port: 4242 }],
      bridgeUrl: 'wss://bridge.example.org:8765',
      token: 'existing-token',
      autoConnect: false,
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    const modeSelect = await screen.findByLabelText('reticulum.form.mode');
    expect((modeSelect as HTMLSelectElement).value).toBe('tcp_peer');
    expect(screen.getByPlaceholderText('amsterdam.connect.reticulum.network')).toHaveValue('rns.example.org');
    expect(screen.getByPlaceholderText('4965')).toHaveValue(4242);
    expect(screen.getByPlaceholderText('ws://127.0.0.1:8765')).toHaveValue('wss://bridge.example.org:8765');
    expect(screen.getByPlaceholderText('••••••••')).toHaveValue('existing-token');
    expect(screen.getByRole('checkbox', { name: 'source.form.auto_connect' })).not.toBeChecked();

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config).toEqual({
      mode: 'tcp_peer',
      autoConnect: false,
      bridgeUrl: 'wss://bridge.example.org:8765',
      token: 'existing-token',
      peers: [{ host: 'rns.example.org', port: 4242 }],
    });
  });

  it('hydrates attach fields from config on edit', async () => {
    currentSource = makeSource({
      mode: 'attach',
      configDir: '/home/user/.reticulum',
      autoConnect: true,
    });
    renderPage();
    openEditModal();

    const modeSelect = await screen.findByLabelText('reticulum.form.mode');
    expect((modeSelect as HTMLSelectElement).value).toBe('attach');
    expect(screen.getByPlaceholderText('/rns')).toHaveValue('/home/user/.reticulum');
    expect(screen.getByRole('checkbox', { name: 'source.form.auto_connect' })).toBeChecked();
  });
});
