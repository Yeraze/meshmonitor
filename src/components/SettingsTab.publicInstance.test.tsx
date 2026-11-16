/**
 * @vitest-environment jsdom
 *
 * Public-instance mode section (#5156 Phase 1 WP1). Same isolation setup as
 * SettingsTab.elevation.test.tsx (mocked contexts and child sections,
 * mode="global").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
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

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { user: { isAdmin: true } },
    // canWriteSettings gates the (unrelated, also-global) Position Estimation
    // section — keep it out of the render so this suite doesn't also need to
    // mock PositionEstimationSection.
    hasPermission: () => false,
  }),
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
vi.mock('./configuration/FirmwareUpdateSection', () => ({ default: () => null }));
vi.mock('./configuration/ChannelDatabaseSection', () => ({ default: () => null }));
vi.mock('./CustomThemeManagement', () => ({ CustomThemeManagement: () => null }));
vi.mock('./CustomTilesetManager', () => ({ CustomTilesetManager: () => null }));
vi.mock('./LanguageSelector', () => ({ LanguageSelector: () => null }));
vi.mock('./PositionEstimationSection', () => ({ default: () => null }));
vi.mock('./MeshWarsSection', () => ({ default: () => null }));
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
      return { ok: true, headers: jsonHeaders, json: async () => ({ databaseType: 'sqlite', firmwareOtaEnabled: false }) } as unknown as Response;
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
  mode: 'global' as const,
};

function renderSettings() {
  return render(<SettingsTab {...baseProps} />);
}

const SUBS = [
  'publicInstanceHideLongNames',
  'publicInstanceHidePublicKeys',
  'publicInstanceRoundTimestamps',
  'publicInstanceHideMessageText',
] as const;

const el = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('SettingsTab — Public-instance mode section (#5156)', () => {
  beforeEach(() => {
    serverSettings = {};
    csrfFetchMock.mockClear();
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    saveBarCapture.current = null;
    installFetchMock();
  });

  it('disables the sub-toggles while the master is off, defaults them on', async () => {
    renderSettings();
    await waitFor(() => expect(el('publicInstanceModeEnabled')).not.toBeNull());
    expect(el('publicInstanceModeEnabled').checked).toBe(false);
    for (const id of SUBS) {
      expect(el(id).disabled).toBe(true);
      expect(el(id).checked).toBe(true);
    }
  });

  it('lays the toggles out inline with the shared checkbox-row class', async () => {
    renderSettings();
    await waitFor(() => expect(el('publicInstanceModeEnabled')).not.toBeNull());
    for (const id of ['publicInstanceModeEnabled', ...SUBS]) {
      expect(el(id).closest('label')?.className).toMatch(/checkboxRow/);
    }
  });

  it('enables the sub-toggles when the master is on', async () => {
    serverSettings = { publicInstanceModeEnabled: '1' };
    renderSettings();
    await waitFor(() => expect(el('publicInstanceModeEnabled')?.checked).toBe(true));
    for (const id of SUBS) expect(el(id).disabled).toBe(false);
  });

  it('keeps sub-toggle values when the master goes off and saves all five keys', async () => {
    serverSettings = { publicInstanceModeEnabled: '1', publicInstanceHideLongNames: '0' };
    renderSettings();
    await waitFor(() => expect(el('publicInstanceModeEnabled')?.checked).toBe(true));
    await waitFor(() => expect(el('publicInstanceHideLongNames').checked).toBe(false));

    fireEvent.click(el('publicInstanceHidePublicKeys')); // on -> off
    await waitFor(() => expect(el('publicInstanceHidePublicKeys').checked).toBe(false));
    fireEvent.click(el('publicInstanceModeEnabled')); // master off
    await waitFor(() => expect(el('publicInstanceModeEnabled').checked).toBe(false));

    for (const id of SUBS) expect(el(id).disabled).toBe(true);
    expect(el('publicInstanceHideLongNames').checked).toBe(false);
    expect(el('publicInstanceHidePublicKeys').checked).toBe(false);
    expect(el('publicInstanceRoundTimestamps').checked).toBe(true);

    await saveBarCapture.current!.onSave();
    const [, options] = csrfFetchMock.mock.calls[csrfFetchMock.mock.calls.length - 1];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.publicInstanceModeEnabled).toBe('0');
    expect(body.publicInstanceHideLongNames).toBe('0');
    expect(body.publicInstanceHidePublicKeys).toBe('0');
    expect(body.publicInstanceRoundTimestamps).toBe('1');
    expect(body.publicInstanceHideMessageText).toBe('1');
  });

  it('warns that the CoT feed is not redacted only when both it and the mode are on', async () => {
    const warning = () => document.querySelector('[data-testid="public-instance-cot-warning"]');
    for (const [settings, expected] of [
      [{ publicInstanceModeEnabled: '1', cotFeedEnabled: '1' }, true],
      [{ publicInstanceModeEnabled: '1', cotFeedEnabled: '0' }, false],
      [{ publicInstanceModeEnabled: '0', cotFeedEnabled: '1' }, false],
    ] as const) {
      serverSettings = { ...settings };
      const { unmount } = renderSettings();
      await waitFor(() => expect(el('publicInstanceModeEnabled')).not.toBeNull());
      await waitFor(() => expect(el('publicInstanceModeEnabled').checked).toBe(settings.publicInstanceModeEnabled === '1'));
      await new Promise(r => setTimeout(r, 50));
      expect(warning() !== null).toBe(expected);
      unmount();
    }
  });
});
