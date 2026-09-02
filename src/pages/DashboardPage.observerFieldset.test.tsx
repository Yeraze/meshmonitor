/**
 * @vitest-environment jsdom
 *
 * Coverage for the MeshCore Analyzer Observer fieldset in the source
 * add/edit modal (#4457 Phase 3; multi-broker editor #5014 Phase 2 WP2,
 * spec §4 + §7.2). Mock block copied wholesale from
 * DashboardPage.meshcoreAdminCheckbox.test.tsx per the WP2 brief — that file
 * is the working, complete set for this page.
 *
 * The global react-i18next mock (src/test/setup.ts) only accepts a two-arg
 * `t(key, options?)` — a third `params` argument (used for `{{index}}` /
 * `{{max}}` interpolation in real i18n) is silently dropped, and the mock
 * returns the raw `key` whenever the second arg is a string (the fallback).
 * So every assertion here matches on the i18n KEY, never the interpolated
 * fallback text — consistent with the rest of this file.
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

/** Clicks a broker preset button, matched by a fragment of its i18n key
 * (the mocked `t()` renders the raw key as button text — see file header). */
function clickPreset(keyFragment: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(keyFragment) }));
}

function brokerRow(index: number) {
  return screen.getByTestId(`observer-broker-row-${index}`);
}

/** Fetch router covering the three Analyzer Observer save-path endpoints
 * (#5014 Phase 2 WP2, §3.5): the source PUT/POST, GET .../observer/status,
 * and PUT .../observer/credentials. Anything else (config bootstrap,
 * csrf-token) echoes success like `mockFetchOk`. */
function mockObserverFetchRouter(opts: {
  statusBrokerKeys?: string[];
  credResponse?: () => { ok: boolean; status?: number; headers?: any; json: () => Promise<any> };
} = {}) {
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/observer/status') && method === 'GET') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            running: false,
            configured: true,
            authMode: 'password',
            keyStored: false,
            connected: false,
            publishes: 0,
            dropped: 0,
            lastPublishAt: null,
            lastError: null,
            tokenExpiresAt: null,
            brokers: (opts.statusBrokerKeys ?? []).map((key) => ({
              key,
              url: key,
              label: null,
              authMode: 'password',
              tokenAudience: null,
              configured: true,
              keyStored: false,
              connected: false,
              publishes: 0,
              dropped: 0,
              lastPublishAt: null,
              lastError: null,
              tokenExpiresAt: null,
            })),
          },
        }),
      }) as any;
    }
    if (url.endsWith('/observer/credentials') && method === 'PUT') {
      if (opts.credResponse) return Promise.resolve(opts.credResponse()) as any;
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) }) as any;
    }
    return Promise.resolve({ ok: true, json: async () => ({ ...currentSource }) }) as any;
  }) as any;
}

describe('MeshCore Analyzer Observer fieldset (#4457 Phase 3, multi-broker #5014 Phase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSource = makeSource({ ...baseConfig });
  });

  it('pre-populates a single broker row from a legacy config.observer block', async () => {
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
    expect(screen.getAllByTestId(/observer-broker-row-/)).toHaveLength(1);
    expect(screen.getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443')).toHaveValue(
      'wss://mqtt-us-v1.letsmesh.net:443',
    );
    expect(screen.getByPlaceholderText('MCO')).toHaveValue('MCO');
    expect(screen.getByPlaceholderText('meshcore-mqtt')).toHaveValue('meshcore-mqtt');
  });

  it('hides the Region field and broker list until enable is checked; no rows exist until a preset is clicked', async () => {
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).not.toBeChecked();
    expect(screen.queryByPlaceholderText('MCO')).not.toBeInTheDocument();

    fireEvent.click(enable);
    expect(screen.getByPlaceholderText('MCO')).toBeInTheDocument();
    // No broker configured yet — a row only appears once a preset is clicked.
    expect(screen.queryByTestId(/observer-broker-row-/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /observer_preset_meshmapper/ })).toBeInTheDocument();

    clickPreset('observer_preset_meshmapper');
    expect(brokerRow(1)).toBeInTheDocument();
    expect(
      within(brokerRow(1)).getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443'),
    ).toHaveValue('wss://mqtt.meshmapper.net:443');
  });

  it('saves normalized config.observer values from a custom broker without disturbing config.virtualNode', async () => {
    currentSource = makeSource({
      ...baseConfig,
      virtualNode: { enabled: true, port: 5000, allowAdminCommands: true },
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    fireEvent.click(enable);

    clickPreset('observer_preset_custom');
    const row = brokerRow(1);
    fireEvent.change(within(row).getByPlaceholderText('wss://mqtt-us-v1.letsmesh.net:443'), {
      target: { value: '  wss://mqtt-us-v1.letsmesh.net:443  ' },
    });
    fireEvent.change(within(row).getByPlaceholderText('meshcore-mqtt'), {
      target: { value: '  meshcore-mqtt  ' },
    });
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'mco' } });

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual({
      enabled: true,
      authMode: 'token',
      iataCode: 'MCO',
      brokers: [{ url: 'wss://mqtt-us-v1.letsmesh.net:443', authMode: 'token', tokenAudience: 'meshcore-mqtt' }],
    });
    expect(body.config.virtualNode).toEqual({
      enabled: true,
      port: 5000,
      allowAdminCommands: true,
      allowPkiExport: false,
    });
  });

  it('persists enabled:false while preserving the broker list when the user unchecks and saves', async () => {
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
    expect(body.config.observer).toEqual({
      enabled: false,
      authMode: 'token',
      iataCode: 'MCO',
      brokers: [{ url: 'wss://mqtt-us-v1.letsmesh.net:443', authMode: 'token', tokenAudience: 'meshcore-mqtt' }],
    });
  });

  it('a source with no observer block loads unchecked and saves enabled:false with no brokers', async () => {
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
      iataCode: '',
      brokers: [],
    });
    expect(body.config.virtualNode).toBeUndefined();
  });

  it('saving an unchanged legacy source migrates to brokers[] with no brokerUrl / top-level tokenAudience', async () => {
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

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(Object.keys(body.config.observer)).toEqual(['enabled', 'authMode', 'iataCode', 'brokers']);
    expect(body.config.observer.brokers).toEqual([
      { url: 'wss://mqtt-us-v1.letsmesh.net:443', authMode: 'token', tokenAudience: 'meshcore-mqtt' },
    ]);
  });

  it('clicking MeshMapper appends a row with the verified URL/audience/label; saving writes both brokers in order', async () => {
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

    clickPreset('observer_preset_meshmapper');

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer.brokers).toEqual([
      { url: 'wss://mqtt-us-v1.letsmesh.net:443', authMode: 'token', tokenAudience: 'meshcore-mqtt' },
      { url: 'wss://mqtt.meshmapper.net:443', authMode: 'token', tokenAudience: 'mqtt.meshmapper.net', label: 'MeshMapper' },
    ]);
  });

  it('clicking LetsMesh US then LetsMesh EU yields a 3-broker save', async () => {
    // A legacy URL distinct from every preset — otherwise adding "LetsMesh
    // US" below would collide with it and trip the duplicate-broker check.
    currentSource = makeSource({
      ...baseConfig,
      observer: {
        enabled: true,
        brokerUrl: 'mqtt://legacy-broker.example.com:1883',
        iataCode: 'MCO',
        tokenAudience: 'meshcore-mqtt',
      },
    });
    mockFetchOk();
    renderPage();
    openEditModal();

    clickPreset('observer_preset_letsmesh_us$');
    clickPreset('observer_preset_letsmesh_eu');

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer.brokers).toHaveLength(3);
    expect(body.config.observer.brokers.map((b: any) => b.url)).toEqual([
      'mqtt://legacy-broker.example.com:1883',
      'wss://mqtt-us-v1.letsmesh.net:443',
      'wss://mqtt-eu-v1.letsmesh.net:443',
    ]);
  });

  it('removes the correct row when three brokers are added and the middle one is removed', async () => {
    mockFetchOk();
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    fireEvent.click(enable);
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'MCO' } });

    clickPreset('observer_preset_meshmapper');
    clickPreset('observer_preset_letsmesh_us$');
    clickPreset('observer_preset_letsmesh_eu');
    expect(screen.getAllByTestId(/observer-broker-row-/)).toHaveLength(3);

    fireEvent.click(within(brokerRow(2)).getByRole('button', { name: /observer_broker_remove/ }));
    expect(screen.getAllByTestId(/observer-broker-row-/)).toHaveLength(2);

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer.brokers.map((b: any) => b.url)).toEqual([
      'wss://mqtt.meshmapper.net:443',
      'wss://mqtt-eu-v1.letsmesh.net:443',
    ]);
  });

  // ── password auth mode (#4595, per-row #5014 Phase 2) ──────────────────────
  it('hides the Token audience field and saves authMode:password on a row switched to password mode', async () => {
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

    // Password mode: audience gone, broker/region still there, credential
    // inputs appear.
    await waitFor(() => expect(screen.queryByPlaceholderText('meshcore-mqtt')).toBeNull());
    expect(screen.getByPlaceholderText('MCO')).toBeInTheDocument();
    expect(screen.getByLabelText('meshcore.form.observer_broker_username')).toBeInTheDocument();
    expect(screen.getByLabelText('meshcore.form.observer_broker_password')).toBeInTheDocument();

    saveModal();

    await waitFor(() => expect(findPutCall()).toBeTruthy());
    const body = JSON.parse(findPutCall()![1].body as string);
    expect(body.config.observer).toEqual({
      enabled: true,
      authMode: 'password',
      iataCode: 'ALA',
      brokers: [{ url: 'mqtt://meshcoretel.ru:1883', authMode: 'password' }],
    });
    // The password itself must never ride along in the config blob.
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
    clickPreset('observer_preset_meshmapper');
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'XX' } });

    saveModal();

    await screen.findByText('meshcore.form.observer_error_iata');
    expect(findPutCall()).toBeUndefined();
  });

  it('blocks save client-side with the too-many-brokers message when 9 brokers are configured, issuing no fetch', async () => {
    currentSource = makeSource({
      ...baseConfig,
      observer: {
        enabled: true,
        authMode: 'token',
        iataCode: 'MCO',
        brokers: Array.from({ length: 9 }, (_, i) => ({
          url: `wss://broker${i}.example.com:443`,
          authMode: 'token',
          tokenAudience: `aud${i}`,
        })),
      },
    });
    global.fetch = vi.fn();
    renderPage();
    openEditModal();

    expect(await screen.findAllByTestId(/observer-broker-row-/)).toHaveLength(9);

    saveModal();

    await screen.findByText('meshcore.form.observer_error_too_many_brokers');
    expect(findPutCall()).toBeUndefined();
  });

  it('blocks save client-side with a duplicate-broker message when the same preset is added twice, issuing no fetch', async () => {
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    fireEvent.click(enable);
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'MCO' } });

    clickPreset('observer_preset_meshmapper');
    clickPreset('observer_preset_meshmapper');

    global.fetch = vi.fn();
    saveModal();

    await screen.findByText('meshcore.form.observer_error_duplicate_broker');
    expect(findPutCall()).toBeUndefined();
  });

  it('disables the enable checkbox, shows the repeater note, and hides preset buttons for a repeater device', async () => {
    currentSource = makeSource({ ...baseConfig, deviceType: 'repeater' });
    renderPage();
    openEditModal();

    const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
    expect(enable).toBeDisabled();
    expect(screen.getByText('meshcore.form.observer_repeater_note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /observer_preset_meshmapper/ })).not.toBeInTheDocument();
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
    clickPreset('observer_preset_meshmapper');
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'MCO' } });

    saveModal();

    await screen.findByText('meshcore.form.observer_error_requires_companion');
  });

  // ── per-broker credential save path (#5014 Phase 2 WP2, §3.5) ──────────────
  describe('per-broker credential save path', () => {
    it('fetches observer/status for the authoritative brokerKey and issues exactly one credential PUT', async () => {
      currentSource = makeSource({
        ...baseConfig,
        observer: {
          enabled: true,
          brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
          authMode: 'password',
          iataCode: 'MCO',
        },
      });
      mockObserverFetchRouter({ statusBrokerKeys: ['wss://mqtt-us-v1.letsmesh.net:443'] });
      renderPage();
      openEditModal();

      fireEvent.change(screen.getByLabelText('meshcore.form.observer_broker_username'), {
        target: { value: 'alice' },
      });
      fireEvent.change(screen.getByLabelText('meshcore.form.observer_broker_password'), {
        target: { value: 'hunter2' },
      });

      saveModal();

      await waitFor(() => expect(findPutCall()).toBeTruthy());
      await waitFor(() =>
        expect(
          (global.fetch as any).mock.calls.some(
            ([url, init]: [string, RequestInit]) => url.endsWith('/observer/status') && init?.method === 'GET',
          ),
        ).toBe(true),
      );

      const credCalls = (global.fetch as any).mock.calls.filter(
        ([url, init]: [string, RequestInit]) => url.endsWith('/observer/credentials') && init?.method === 'PUT',
      );
      expect(credCalls).toHaveLength(1);
      const credBody = JSON.parse(credCalls[0][1].body as string);
      expect(credBody).toEqual({
        brokerKey: 'wss://mqtt-us-v1.letsmesh.net:443',
        username: 'alice',
        password: 'hunter2',
      });
    });

    it('serializes credential PUTs across two password-mode rows — never Promise.all', async () => {
      mockFetchOk();
      renderPage();
      openEditModal();

      const enable = await screen.findByRole('checkbox', { name: 'meshcore.form.observer_enable' });
      fireEvent.click(enable);
      fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'MCO' } });

      clickPreset('observer_preset_meshmapper');
      clickPreset('observer_preset_letsmesh_us$');

      fireEvent.change(within(brokerRow(1)).getByLabelText('meshcore.form.observer_auth_mode'), {
        target: { value: 'password' },
      });
      fireEvent.change(within(brokerRow(2)).getByLabelText('meshcore.form.observer_auth_mode'), {
        target: { value: 'password' },
      });
      fireEvent.change(within(brokerRow(1)).getByLabelText('meshcore.form.observer_broker_username'), {
        target: { value: 'user1' },
      });
      fireEvent.change(within(brokerRow(1)).getByLabelText('meshcore.form.observer_broker_password'), {
        target: { value: 'pass1' },
      });
      fireEvent.change(within(brokerRow(2)).getByLabelText('meshcore.form.observer_broker_username'), {
        target: { value: 'user2' },
      });
      fireEvent.change(within(brokerRow(2)).getByLabelText('meshcore.form.observer_broker_password'), {
        target: { value: 'pass2' },
      });

      const credResolvers: Array<() => void> = [];
      let credCallCount = 0;
      global.fetch = vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url.endsWith('/observer/status') && method === 'GET') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                brokers: [
                  { key: 'wss://mqtt.meshmapper.net:443' },
                  { key: 'wss://mqtt-us-v1.letsmesh.net:443' },
                ],
              },
            }),
          }) as any;
        }
        if (url.endsWith('/observer/credentials') && method === 'PUT') {
          credCallCount += 1;
          return new Promise((resolve) => {
            credResolvers.push(() => resolve({ ok: true, json: async () => ({ success: true }) } as any));
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ...currentSource }) }) as any;
      }) as any;

      saveModal();

      await waitFor(() => expect(credCallCount).toBe(1));
      // Give any pending microtasks a chance to run — the second PUT must
      // NOT start while the first is still outstanding.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(credCallCount).toBe(1);

      credResolvers[0]();
      await waitFor(() => expect(credCallCount).toBe(2));
      credResolvers[1]();

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /^common\.save$/i })).not.toBeInTheDocument(),
      );
    });

    it('a credential PUT returning UNKNOWN_BROKER leaves the modal open with a partial-failure message and does not retry the source PUT', async () => {
      currentSource = makeSource({
        ...baseConfig,
        observer: {
          enabled: true,
          brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
          authMode: 'password',
          iataCode: 'MCO',
        },
      });
      mockObserverFetchRouter({
        statusBrokerKeys: ['wss://mqtt-us-v1.letsmesh.net:443'],
        credResponse: () => ({
          ok: false,
          status: 400,
          headers: { get: () => null },
          json: async () => ({ success: false, error: 'Unknown broker', code: 'UNKNOWN_BROKER' }),
        }),
      });
      renderPage();
      openEditModal();

      fireEvent.change(screen.getByLabelText('meshcore.form.observer_broker_username'), {
        target: { value: 'alice' },
      });
      fireEvent.change(screen.getByLabelText('meshcore.form.observer_broker_password'), {
        target: { value: 'hunter2' },
      });

      saveModal();

      await screen.findByText(/observer_credentials_partial_error/);

      // Modal stays open — the save form is still present.
      expect(screen.getByRole('button', { name: /^common\.save$/i })).toBeInTheDocument();

      const configPutCalls = (global.fetch as any).mock.calls.filter(
        ([url, init]: [string, RequestInit]) => url === '/api/sources/src-mc' && init?.method === 'PUT',
      );
      expect(configPutCalls).toHaveLength(1);
    });

    it('issues no credential PUT when username/password are left blank on a password-mode row', async () => {
      currentSource = makeSource({
        ...baseConfig,
        observer: {
          enabled: true,
          brokerUrl: 'wss://mqtt-us-v1.letsmesh.net:443',
          authMode: 'password',
          iataCode: 'MCO',
        },
      });
      mockFetchOk();
      renderPage();
      openEditModal();

      saveModal();

      await waitFor(() => expect(findPutCall()).toBeTruthy());
      expect(
        (global.fetch as any).mock.calls.some(([url]: [string]) => url.endsWith('/observer/credentials')),
      ).toBe(false);
      expect(
        (global.fetch as any).mock.calls.some(([url]: [string]) => url.endsWith('/observer/status')),
      ).toBe(false);
    });
  });
});
