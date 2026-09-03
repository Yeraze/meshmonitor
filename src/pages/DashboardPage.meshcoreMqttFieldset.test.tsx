/**
 * @vitest-environment jsdom
 *
 * Coverage for the MeshCore MQTT ingest source fieldset in the source add/edit
 * modal (#5040 Phase 1). Mock block copied wholesale from
 * DashboardPage.reticulumFieldset.test.tsx — that file is the working,
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
    name: 'Region Feed',
    type: 'meshcore_mqtt',
    enabled: true,
    config,
  };
}

let currentSource = makeSource({
  brokerUrl: 'wss://mqtt.meshmapper.net:443',
  region: 'MCO',
  autoConnect: true,
});

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
  fireEvent.click(screen.getByRole('button', { name: 'edit-Region Feed' }));
}

function selectMcMqttType() {
  fireEvent.change(screen.getByLabelText('source.form.type'), {
    target: { value: 'meshcore_mqtt' },
  });
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

function postedConfig() {
  const call = findPostCall();
  expect(call).toBeDefined();
  return JSON.parse(call[1].body as string).config;
}

describe('MeshCore MQTT ingest source fieldset (#5040 Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSource = makeSource({
      brokerUrl: 'wss://mqtt.meshmapper.net:443',
      region: 'MCO',
      autoConnect: true,
    });
  });

  it('offers the type and shows its fields when selected', () => {
    renderPage();
    openAddModal();
    selectMcMqttType();

    expect(screen.getByPlaceholderText('wss://mqtt.meshmapper.net:443')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('MCO')).toBeInTheDocument();
  });

  it('states up front that the source has no radio', () => {
    // Expectation-setting matters here: a user who does not read this will file
    // "my MeshCore source has no device page" as a bug.
    renderPage();
    openAddModal();
    selectMcMqttType();

    expect(screen.getByText(/source\.form\.mc_mqtt_intro/)).toBeInTheDocument();
  });

  it('POSTs brokerUrl and an upper-cased region', async () => {
    mockFetchOk();
    renderPage();
    openAddModal();
    selectMcMqttType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'Orlando Feed' },
    });
    fireEvent.change(screen.getByPlaceholderText('wss://mqtt.meshmapper.net:443'), {
      target: { value: 'wss://broker.example:443' },
    });
    // Lower case on the way in — the topic segment is upper case, so the form
    // normalises rather than silently subscribing to nothing.
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'mco' } });
    saveModal();

    await waitFor(() => expect(findPostCall()).toBeDefined());
    expect(postedConfig()).toMatchObject({
      brokerUrl: 'wss://broker.example:443',
      region: 'MCO',
      autoConnect: true,
      rejectUnauthorized: true,
    });
  });

  it('omits username/password entirely when left blank', async () => {
    mockFetchOk();
    renderPage();
    openAddModal();
    selectMcMqttType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'Open Broker' },
    });
    fireEvent.change(screen.getByPlaceholderText('wss://mqtt.meshmapper.net:443'), {
      target: { value: 'mqtt://localhost:1883' },
    });
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'test' } });
    saveModal();

    await waitFor(() => expect(findPostCall()).toBeDefined());
    const cfg = postedConfig();
    expect(cfg).not.toHaveProperty('username');
    expect(cfg).not.toHaveProperty('password');
  });

  it('refuses to save without a broker URL', async () => {
    mockFetchOk();
    renderPage();
    openAddModal();
    selectMcMqttType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'No Broker' },
    });
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'MCO' } });
    saveModal();

    await waitFor(() =>
      expect(screen.getByText(/source\.form\.error_mc_mqtt_broker_required/)).toBeInTheDocument(),
    );
    expect(findPostCall()).toBeUndefined();
  });

  it('refuses to save without a region — the topic filter is built from it', async () => {
    mockFetchOk();
    renderPage();
    openAddModal();
    selectMcMqttType();

    fireEvent.change(screen.getByPlaceholderText('source.form.name_placeholder'), {
      target: { value: 'No Region' },
    });
    fireEvent.change(screen.getByPlaceholderText('wss://mqtt.meshmapper.net:443'), {
      target: { value: 'wss://broker.example:443' },
    });
    saveModal();

    await waitFor(() =>
      expect(screen.getByText(/source\.form\.error_mc_mqtt_region_required/)).toBeInTheDocument(),
    );
    expect(findPostCall()).toBeUndefined();
  });

  it('seeds the form from an existing source on edit, but never the password', () => {
    currentSource = makeSource({
      brokerUrl: 'wss://broker.example:443',
      region: 'AMS',
      username: 'meshcore',
      password: 'should-not-be-seeded',
      rejectUnauthorized: false,
      autoConnect: false,
    });
    renderPage();
    openEditModal();

    expect(screen.getByPlaceholderText('wss://mqtt.meshmapper.net:443')).toHaveValue('wss://broker.example:443');
    expect(screen.getByPlaceholderText('MCO')).toHaveValue('AMS');
    // The stored password must never round-trip into the DOM; the server keeps
    // it when this is left blank.
    expect(screen.queryByDisplayValue('should-not-be-seeded')).not.toBeInTheDocument();
  });
});
