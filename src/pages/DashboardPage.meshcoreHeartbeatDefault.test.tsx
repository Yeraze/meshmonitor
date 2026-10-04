/**
 * @vitest-environment jsdom
 *
 * MeshCore heartbeat default by device type (#5563).
 *
 * The Repeater serial stall probe is opt-in: off until the user sets it. The
 * source form pre-fills the heartbeat with 30, which is right for a Companion
 * and would switch the probe on for every new Repeater source. So a NEW
 * source shows 0 once Repeater is picked, unless the user already typed a
 * value. An existing source keeps what it saved.
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

/** A saved Repeater source with the probe on: an edit must keep 45. */
const repeaterSource = {
  id: 'src-rpt',
  name: 'RPT Source',
  type: 'meshcore',
  enabled: true,
  config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'repeater', autoConnect: true, heartbeatIntervalSeconds: 45 },
};

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [meshcoreSource, meshcoreSourceWithPort, repeaterSource],
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

/** The MeshCore heartbeat input, found by its label. */
const heartbeatInput = async () =>
  (await screen.findByText('source.form.heartbeat')).parentElement!.querySelector(
    'input[type="number"]',
  ) as HTMLInputElement;

const deviceTypeSelect = async () =>
  (await screen.findByText('meshcore.form.device_type')).parentElement!.querySelector('select') as HTMLSelectElement;

async function openNewMeshCoreForm() {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'add-source' }));
  fireEvent.change(await screen.findByDisplayValue('source.form.type_meshtastic'), {
    target: { value: 'meshcore' },
  });
}

describe('MeshCore heartbeat default by device type (#5563)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps 30 for a new Companion source', async () => {
    await openNewMeshCoreForm();
    expect((await deviceTypeSelect()).value).toBe('companion');
    expect((await heartbeatInput()).value).toBe('30');
  });

  it('shows 0 when Repeater is picked on a new source', async () => {
    await openNewMeshCoreForm();
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'repeater' } });
    expect((await heartbeatInput()).value).toBe('0');
  });

  it('goes back to 30 when the user switches back to Companion', async () => {
    await openNewMeshCoreForm();
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'repeater' } });
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'companion' } });
    expect((await heartbeatInput()).value).toBe('30');
  });

  it('leaves a value the user typed alone', async () => {
    await openNewMeshCoreForm();
    fireEvent.change(await heartbeatInput(), { target: { value: '15' } });
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'repeater' } });
    expect((await heartbeatInput()).value).toBe('15');
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'companion' } });
    expect((await heartbeatInput()).value).toBe('15');
  });

  it('keeps the saved value when editing a Repeater source', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'edit-RPT Source' }));
    expect((await deviceTypeSelect()).value).toBe('repeater');
    expect((await heartbeatInput()).value).toBe('45');
  });

  it('does not rewrite the saved value when the device type changes during an edit', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'edit-RPT Source' }));
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'companion' } });
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'repeater' } });
    expect((await heartbeatInput()).value).toBe('45');
  });

  it('starts from the defaults again after an edit is followed by a new source', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'edit-RPT Source' }));
    expect((await heartbeatInput()).value).toBe('45');
    fireEvent.click(screen.getByRole('button', { name: 'add-source' }));
    fireEvent.change(await screen.findByDisplayValue('source.form.type_meshtastic'), {
      target: { value: 'meshcore' },
    });
    expect((await heartbeatInput()).value).toBe('30');
    fireEvent.change(await deviceTypeSelect(), { target: { value: 'repeater' } });
    expect((await heartbeatInput()).value).toBe('0');
  });
});
