/**
 * @vitest-environment jsdom
 *
 * Where SettingsTab puts the sections the #5683 follow-up moved:
 *
 *   source mode   gains PKI DM decryption (from Device Configuration) and, on
 *                 an MQTT bridge, the bridge setup (from its own page). Loses
 *                 Firmware update (to Device Configuration); a pointer stays.
 *   global mode   gains the Reticulum retention cap (from each Reticulum
 *                 source's Settings page).
 *
 * Each moved section keeps the grant its own routes check, so opening this
 * page with `settings:read` alone shows none of them. And none of them joins
 * the SettingsDraft: an unsaved Settings edit is still there, and still
 * unsaved, with them on the page.
 *
 * The scaffold (every context and unrelated child stubbed) is the one
 * SettingsTab.elevation.test.tsx uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsTab from './SettingsTab';

// ---------------------------------------------------------------------------
// react-i18next: the global setup.ts mock only handles the 2-arg (key,
// options) form and interpolates into `key`, not into a `defaultValue`. This
// component calls `t(key, defaultValueString, optionsObject)` (3-arg) for
// interpolated copy, so override locally to produce the real English text —
// mirrors MapAnalysisCanvas.test.tsx's override for the same reason.
// ---------------------------------------------------------------------------
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});

// ---------------------------------------------------------------------------
// Contexts / hooks
// ---------------------------------------------------------------------------
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    // SettingsTab's own section only: child sections (the Reticulum retention
    // cap on the global page) register theirs through the same hook.
    if ((options as { id?: string }).id !== 'settings') return;
    saveBarCapture.current = options as {
      hasChanges: boolean;
      onSave: () => Promise<void>;
      onDismiss: () => void;
    };
  },
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: {
    current: null as null | { hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void },
  },
}));

// Grants and the source in view are set per test.
const { view } = vi.hoisted(() => ({
  view: {
    isAdmin: true,
    grants: new Set<string>(),
    sourceId: 'src-a' as string | null,
    sourceType: 'meshtastic_tcp' as string | null,
    firmwareOtaEnabled: true,
  },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { user: { isAdmin: view.isAdmin } },
    hasPermission: (resource: string, action: string) => view.grants.has(`${resource}:${action}`),
  }),
}));
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: view.sourceId, sourceName: 'Test source', sourceType: view.sourceType }),
}));
vi.mock('../hooks/useSourceQuery', () => ({
  useSourceQuery: () => (view.sourceId ? `?sourceId=${view.sourceId}` : ''),
}));

vi.mock('../contexts/UIContext', () => {
  // Must be a STABLE object: setShowIncompleteNodes sits in the settings-load
  // effect's dependency array, and a fresh vi.fn() per render re-runs that
  // effect on every render — each re-fetch then clobbers in-test edits with
  // the server values (the CI-order-dependent failure this suite had).
  const ui = { showIncompleteNodes: true, setShowIncompleteNodes: vi.fn() };
  return { useUI: () => ui };
});

vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [] }),
}));

vi.mock('../config/tilesets', () => ({
  getAllTilesets: () => [],
}));

vi.mock('../contexts/SettingsContext', () => {
  // Must be a STABLE object, for the same reason the UIContext mock above is:
  // setHideIncompleteNodes sits in the settings-load effect's dependency array,
  // and a fresh vi.fn() per render re-runs that effect on every render — each
  // re-fetch then clobbers in-test edits with the server values.
  // (#4412 Phase 3 moved showIncompleteNodes/its setter from UIContext to here,
  // which is how this mock inherited that constraint.)
  const settings = {
    customThemes: [],
    customTilesets: [],
    enableAudioNotifications: false,
    setEnableAudioNotifications: vi.fn(),
    linkPreviewsEnabled: true,
    setLinkPreviewsEnabled: vi.fn(),
    meshcoreChannelRetryEnabled: false,
    setMeshcoreChannelRetryEnabled: vi.fn(),
    nodeDimmingEnabled: false,
    setNodeDimmingEnabled: vi.fn(),
    nodeDimmingStartHours: 24,
    setNodeDimmingStartHours: vi.fn(),
    nodeDimmingMinOpacity: 0.3,
    setNodeDimmingMinOpacity: vi.fn(),
    nodeHopsCalculation: 'auto',
    setNodeHopsCalculation: vi.fn(),
    preferredDashboardSortOption: 'custom',
    setPreferredDashboardSortOption: vi.fn(),
    neighborInfoMinZoom: 10,
    setNeighborInfoMinZoom: vi.fn(),
    defaultMapCenterLat: null,
    defaultMapCenterLon: null,
    defaultMapCenterZoom: null,
    setDefaultMapCenterLat: vi.fn(),
    setDefaultMapCenterLon: vi.fn(),
    setDefaultMapCenterZoom: vi.fn(),
    mapCenterTargetZoom: 10,
    mapZoomGateThreshold: 13,
    mapClusteringEnabled: true,
    setMapCenterTargetZoom: vi.fn(),
    setMapZoomGateThreshold: vi.fn(),
    setMapClusteringEnabled: vi.fn(),
    defaultLandingPage: 'dashboard',
    setDefaultLandingPage: vi.fn(),
    appearanceMode: 'system',
    setAppearanceMode: vi.fn(),
    darkTheme: 'catppuccin',
    setDarkTheme: vi.fn(),
    lightTheme: 'catppuccin-latte',
    setLightTheme: vi.fn(),
    hideIncompleteNodes: false,
    showIncompleteNodes: true,
    setHideIncompleteNodes: vi.fn(),
  };
  return {
    getEffectiveTileset: () => 'osm',
    useSettings: () => settings,
  };
});

// ---------------------------------------------------------------------------
// Child sections unrelated to the elevation UI under test. `mode="global"`
// plus `isAdmin=true` (needed so the admin-gated elevation section itself
// renders) still pulls in these global sections' subcomponents — stub them
// all to `null` so this suite only exercises the elevation JSX.
// ---------------------------------------------------------------------------
vi.mock('./PacketMonitorSettings', () => ({ default: () => null }));
vi.mock('./ChannelSoundPicker', () => ({ default: () => null }));
vi.mock('./PkiDmGlobalToggle', () => ({ default: () => null }));
vi.mock('./configuration/SystemBackupSection', () => ({ default: () => null }));
vi.mock('./configuration/DatabaseMaintenanceSection', () => ({ default: () => null }));
vi.mock('./settings/ScriptsSection', () => ({ default: () => null }));
// The sections this suite places. Each stands in as a marker that records
// its props; their own suites cover what they do.
const { marks } = vi.hoisted(() => ({ marks: { pki: [] as unknown[], bridge: [] as unknown[] } }));
vi.mock('./configuration/FirmwareUpdateSection', () => ({
  default: () => <div data-testid="firmware-update-section" />,
}));
vi.mock('./configuration/PkiDmDecryptionSection', () => ({
  default: (props: Record<string, unknown>) => {
    marks.pki.push(props);
    return <div data-testid="pki-dm-section" id={String(props.sectionId)} />;
  },
}));
vi.mock('./MQTT/MqttBridgeConfigurationView', () => ({
  default: (props: Record<string, unknown>) => {
    marks.bridge.push(props);
    return <div data-testid="mqtt-bridge-section" id="settings-mqtt-bridge" />;
  },
}));
vi.mock('./settings/ReticulumRetentionSection', () => ({
  default: () => <div data-testid="reticulum-retention-section" id="settings-reticulum" />,
}));
// Coverage recording renders on MQTT sources and owns TanStack queries.
vi.mock('./settings/CoverageMqttRecordingSection', () => ({ default: () => null }));
vi.mock('./configuration/ChannelDatabaseSection', () => ({ default: () => null }));
vi.mock('./CustomThemeManagement', () => ({ CustomThemeManagement: () => null }));
vi.mock('./CustomTilesetManager', () => ({ CustomTilesetManager: () => null }));
vi.mock('./LanguageSelector', () => ({ LanguageSelector: () => null }));
vi.mock('./PositionEstimationSection', () => ({ default: () => null }));
vi.mock('./TapbackEmojiSettings', () => ({ default: () => null }));
vi.mock('./settings/EmbedSettings', () => ({ default: () => null }));
vi.mock('./configuration/DefaultMapCenterPicker', () => ({ DefaultMapCenterPicker: () => null }));
vi.mock('./GeoJsonLayerManager', () => ({ default: () => null }));
vi.mock('./MapStyleManager', () => ({ default: () => null }));

// ---------------------------------------------------------------------------
// ApiService — spread the real module so unrelated methods stay callable,
// override just testElevationSource (mirrors LinkProfileDrawer.test.tsx's
// getElevationProfile mock pattern).
// ---------------------------------------------------------------------------
const { testElevationSourceMock } = vi.hoisted(() => ({ testElevationSourceMock: vi.fn() }));
vi.mock('../services/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/api')>();
  // Plain object-spread of `actual.default` (the ApiService singleton) only
  // copies its own instance fields (baseUrl, configFetched, ...) — `get`,
  // `post`, etc. live on the class prototype and are silently dropped,
  // which threw "default.get is not a function" once SettingsTab's
  // mount-time system-status/health/settings fetches moved onto
  // apiService.get() (#3962 5.5 PR2). Object.create + Object.assign keeps
  // the prototype chain (so real methods still resolve) while still
  // letting us override just testElevationSource on top, same as before.
  const mockedDefault = Object.assign(
    Object.create(Object.getPrototypeOf(actual.default)),
    actual.default,
    { testElevationSource: (...args: unknown[]) => testElevationSourceMock(...args) },
  );
  return {
    ...actual,
    default: mockedDefault,
  };
});

// ---------------------------------------------------------------------------
// Mount-time raw `fetch` calls (system status / db health / server settings —
// none of these go through ApiService or csrfFetch).
// ---------------------------------------------------------------------------
let serverSettings: Record<string, string>;

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const jsonHeaders = { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) };
    if (url.includes('/api/config')) {
      // ApiService.ensureBaseUrl() hits this before its first request; without
      // a JSON content-type it treats the response as unusable and falls back
      // to retrying with backoff, delaying every apiService.get() below well
      // past this suite's waitFor windows.
      return { ok: true, headers: jsonHeaders, json: async () => ({ baseUrl: '' }) } as unknown as Response;
    }
    if (url.includes('/api/system/status')) {
      return { ok: true, headers: jsonHeaders, json: async () => ({ isDocker: false }) } as unknown as Response;
    }
    if (url.includes('/api/health')) {
      return { ok: true, headers: jsonHeaders, json: async () => ({ databaseType: 'sqlite', firmwareOtaEnabled: view.firmwareOtaEnabled }) } as unknown as Response;
    }
    if (url.includes('/api/settings')) {
      return { ok: true, headers: jsonHeaders, json: async () => serverSettings } as unknown as Response;
    }
    return { ok: true, headers: jsonHeaders, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
}

const noop = vi.fn();

const baseProps = {
  maxNodeAgeHours: 24,
  inactiveNodeThresholdHours: 4,
  inactiveNodeCheckIntervalMinutes: 15,
  inactiveNodeCooldownHours: 1,
  temperatureUnit: 'C' as const,
  distanceUnit: 'km' as const,
  positionHistoryLineStyle: 'linear' as const,
  telemetryVisualizationHours: 24,
  favoriteTelemetryStorageDays: 30,
  preferredSortField: 'longName' as const,
  preferredSortDirection: 'asc' as const,
  timeFormat: '24' as const,
  dateFormat: 'MM/DD/YYYY' as const,
  mapTilesetLight: 'osm' as const,
  mapTilesetDark: 'osm' as const,
  mapPinStyle: 'meshmonitor' as const,
  mapPinColorMode: 'node' as const,
  nodeListStyle: 'monochrome' as const,
  iconStyle: 'lucide' as const,
  theme: 'catppuccin' as const,
  language: 'en',
  solarMonitoringEnabled: false,
  solarMonitoringLatitude: 0,
  solarMonitoringLongitude: 0,
  solarMonitoringAzimuth: 180,
  solarMonitoringDeclination: 30,
  currentNodeId: '',
  nodes: [],
  baseUrl: '',
  onMaxNodeAgeChange: noop,
  onInactiveNodeThresholdHoursChange: noop,
  onInactiveNodeCheckIntervalMinutesChange: noop,
  onInactiveNodeCooldownHoursChange: noop,
  onTemperatureUnitChange: noop,
  onDistanceUnitChange: noop,
  onPositionHistoryLineStyleChange: noop,
  onTelemetryVisualizationChange: noop,
  onFavoriteTelemetryStorageDaysChange: noop,
  onPreferredSortFieldChange: noop,
  onPreferredSortDirectionChange: noop,
  onTimeFormatChange: noop,
  onDateFormatChange: noop,
  onMapTilesetsChange: noop,
  onMapPinStyleChange: noop,
  onMapPinColorModeChange: noop,
  onNodeListStyleChange: noop,
  onIconStyleChange: noop,
  onLanguageChange: noop,
  onSolarMonitoringEnabledChange: noop,
  onSolarMonitoringLatitudeChange: noop,
  onSolarMonitoringLongitudeChange: noop,
  onSolarMonitoringAzimuthChange: noop,
  onSolarMonitoringDeclinationChange: noop,
};

function renderSettings(mode: 'source' | 'global') {
  return render(
    <MemoryRouter>
      <SettingsTab {...baseProps} mode={mode} />
    </MemoryRouter>,
  );
}

const sectionNavIds = () =>
  [...document.querySelectorAll('[data-section-id]')].map((el) => el.getAttribute('data-section-id'));

async function settled() {
  // The mount-time health / settings fetches have landed.
  await waitFor(() => expect(saveBarCapture.current).not.toBeNull());
  await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls
    .some(([url]) => String(url).includes('/api/health'))).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
  marks.pki.length = 0;
  marks.bridge.length = 0;
  saveBarCapture.current = null;
  serverSettings = {};
  view.isAdmin = true;
  view.grants = new Set(['settings:read', 'settings:write', 'configuration:read', 'configuration:write', 'sources:read', 'sources:write']);
  view.sourceId = 'src-a';
  view.sourceType = 'meshtastic_tcp';
  view.firmwareOtaEnabled = true;
  installFetchMock();
});

describe('SettingsTab source mode, Meshtastic radio: PKI DM decryption moved in', () => {
  it('renders the section under its Settings anchor, with a nav chip', async () => {
    renderSettings('source');
    await settled();
    const section = screen.getByTestId('pki-dm-section');
    expect(section.id).toBe('settings-pki-dm');
    expect(marks.pki.at(-1)).toMatchObject({ className: 'settings-section', canWrite: true });
    await waitFor(() => expect(sectionNavIds()).toContain('settings-pki-dm'));
  });

  it('passes canWrite=false with configuration:read only, so the switch is disabled there', async () => {
    view.grants.delete('configuration:write');
    renderSettings('source');
    await settled();
    expect(marks.pki.at(-1)).toMatchObject({ canWrite: false });
  });

  it('is absent without configuration:read: settings:read does not open it', async () => {
    view.grants.delete('configuration:read');
    view.grants.delete('configuration:write');
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('pki-dm-section')).toBeNull();
    expect(sectionNavIds()).not.toContain('settings-pki-dm');
  });

  it.each(['mqtt_bridge', 'mqtt_broker'])('is absent on a %s source, which has no radio key', async (sourceType) => {
    view.sourceType = sourceType;
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('pki-dm-section')).toBeNull();
    expect(sectionNavIds()).not.toContain('settings-pki-dm');
  });

  it('is absent from Global Settings', async () => {
    view.sourceId = null;
    view.sourceType = null;
    renderSettings('global');
    await settled();
    expect(screen.queryByTestId('pki-dm-section')).toBeNull();
  });
});

describe('SettingsTab source mode: Firmware update moved out', () => {
  it('renders a pointer on the old anchor, linked to the Device Configuration section', async () => {
    renderSettings('source');
    await settled();
    const note = await screen.findByTestId('firmware-moved');
    expect(note).toHaveTextContent('Firmware update moved to Device Configuration.');
    expect(note.closest('#settings-firmware')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Open Device Configuration' }).getAttribute('href'))
      .toBe('/source/src-a/configuration#config-firmware');
    expect(screen.queryByTestId('firmware-update-section')).toBeNull();
    expect(sectionNavIds()).not.toContain('settings-firmware');
  });

  it('shows no pointer to a non-admin, who never had the section', async () => {
    view.isAdmin = false;
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('firmware-moved')).toBeNull();
  });

  it('shows no pointer when OTA is off', async () => {
    view.firmwareOtaEnabled = false;
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('firmware-moved')).toBeNull();
  });

  it.each(['mqtt_bridge', 'mqtt_broker'])('shows no pointer on a %s source: it has no Device Configuration page', async (sourceType) => {
    view.sourceType = sourceType;
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('firmware-moved')).toBeNull();
    expect(screen.queryByTestId('firmware-update-section')).toBeNull();
  });
});

describe('SettingsTab source mode, MQTT bridge: the bridge setup moved in', () => {
  beforeEach(() => {
    view.sourceType = 'mqtt_bridge';
  });

  it('renders the bridge section for this source, first, with a nav chip', async () => {
    renderSettings('source');
    await settled();
    const section = screen.getByTestId('mqtt-bridge-section');
    expect(marks.bridge.at(-1)).toMatchObject({ sourceId: 'src-a' });
    const content = section.parentElement!;
    expect(content.firstElementChild).toBe(section);
    await waitFor(() => expect(sectionNavIds()).toContain('settings-mqtt-bridge'));
  });

  it('is absent without sources:read: settings:read does not open it', async () => {
    view.grants.delete('sources:read');
    view.grants.delete('sources:write');
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('mqtt-bridge-section')).toBeNull();
    expect(sectionNavIds()).not.toContain('settings-mqtt-bridge');
  });

  it.each(['meshtastic_tcp', 'mqtt_broker'])('is absent on a %s source', async (sourceType) => {
    view.sourceType = sourceType;
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('mqtt-bridge-section')).toBeNull();
    expect(sectionNavIds()).not.toContain('settings-mqtt-bridge');
  });
});

describe('SettingsTab global mode: the Reticulum retention cap moved in', () => {
  beforeEach(() => {
    view.sourceId = null;
    view.sourceType = null;
  });

  it('renders the section with a nav chip', async () => {
    renderSettings('global');
    await settled();
    expect(screen.getByTestId('reticulum-retention-section')).toBeInTheDocument();
    await waitFor(() => expect(sectionNavIds()).toContain('settings-reticulum'));
  });

  it('is absent from a source Settings page', async () => {
    view.sourceId = 'src-a';
    view.sourceType = 'meshtastic_tcp';
    renderSettings('source');
    await settled();
    expect(screen.queryByTestId('reticulum-retention-section')).toBeNull();
    expect(sectionNavIds()).not.toContain('settings-reticulum');
  });
});

describe('SettingsTab: the moved sections do not join the SettingsDraft', () => {
  const settingsPosts = () =>
    csrfFetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes('/api/settings') && (init as RequestInit | undefined)?.method === 'POST');

  it.each(['meshtastic_tcp', 'mqtt_bridge'])('mounting them on a %s source sends no settings save', async (sourceType) => {
    view.sourceType = sourceType;
    renderSettings('source');
    await settled();
    expect(settingsPosts()).toEqual([]);
  });

  it('they add nothing to what the page calls unsaved', async () => {
    // Same page with and without the moved sections: the dirty flag agrees.
    view.grants = new Set(['settings:read', 'settings:write']);
    const bare = renderSettings('source');
    await settled();
    const withoutThem = saveBarCapture.current!.hasChanges;
    expect(screen.queryByTestId('pki-dm-section')).toBeNull();
    bare.unmount();

    saveBarCapture.current = null;
    view.grants = new Set(['settings:read', 'settings:write', 'configuration:read', 'configuration:write']);
    renderSettings('source');
    await settled();
    expect(screen.getByTestId('pki-dm-section')).toBeInTheDocument();
    expect(saveBarCapture.current!.hasChanges).toBe(withoutThem);
  });

  it('a save sends no key of a moved section (PKI, firmware, bridge config)', async () => {
    view.sourceType = 'mqtt_bridge';
    renderSettings('source');
    await settled();
    await saveBarCapture.current!.onSave();
    const posts = settingsPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const [, init] of posts) {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      for (const key of Object.keys(body)) {
        expect(key).not.toMatch(/pkiDm|firmware|upstream|brokerSourceId|reticulum_destinations_max/i);
      }
    }
  });
});
