/**
 * @vitest-environment jsdom
 *
 * Elevation / Terrain settings section (#4111 Phase 3 WP-3). SettingsTab.tsx
 * is a very large component wired into many contexts and child sections; this
 * suite mocks every dependency that isn't the elevation section under test so
 * it can render in isolation. `mode="global"` narrows the rendered sections to
 * `GLOBAL_SECTIONS` (elevation is global, not per-source) which keeps the
 * mocked-child surface as small as possible; `hasPermission` is stubbed to
 * return false so the (also-global, canWriteSettings-gated) Position
 * Estimation section doesn't need its own mock.
 *
 * Covers:
 *  - the enable toggle + source URL load from server settings and persist
 *    into the `POST /api/settings` body on save;
 *  - the Test button calling `ApiService.testElevationSource` and rendering
 *    success/failure copy;
 *  - the `handleSave` dependency-array regression guard (CLAUDE.md gotcha) —
 *    an edited elevation field must appear in the very next save payload.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsTab from './SettingsTab';
import { DEFAULT_TERRARIUM_URL } from '../types/elevation';

// ---------------------------------------------------------------------------
// react-i18next: the global setup.ts mock only handles the 2-arg (key,
// options) form and interpolates into `key`, not into a `defaultValue`. This
// component calls `t(key, defaultValueString, optionsObject)` (3-arg) for
// interpolated copy, so override locally to produce the real English text —
// mirrors MapAnalysisCanvas.test.tsx's override for the same reason.
// ---------------------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      arg2?: string | Record<string, unknown>,
      arg3?: Record<string, unknown>,
    ) => {
      let options: Record<string, unknown> | undefined;
      let defaultValue: string | undefined;
      if (typeof arg2 === 'string') {
        defaultValue = arg2;
        options = arg3;
      } else {
        options = arg2;
        defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : undefined;
      }
      let out = defaultValue ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Contexts / hooks
// ---------------------------------------------------------------------------
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
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

vi.mock('../contexts/SettingsContext', () => ({
  getEffectiveTileset: () => 'osm',
  useSettings: () => ({
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
    setMapCenterTargetZoom: vi.fn(),
    defaultLandingPage: 'dashboard',
    setDefaultLandingPage: vi.fn(),
    appearanceMode: 'system',
    setAppearanceMode: vi.fn(),
    darkTheme: 'catppuccin',
    setDarkTheme: vi.fn(),
    lightTheme: 'catppuccin-latte',
    setLightTheme: vi.fn(),
  }),
}));

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
vi.mock('./configuration/FirmwareUpdateSection', () => ({ default: () => null }));
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

describe('SettingsTab — Elevation / Terrain section (#4111 Phase 3 WP-3)', () => {
  beforeEach(() => {
    serverSettings = { elevationEnabled: 'true', elevationSourceUrl: '' };
    csrfFetchMock.mockClear();
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    testElevationSourceMock.mockReset();
    saveBarCapture.current = null;
    installFetchMock();
  });

  it('loads the enabled state and source URL from server settings', async () => {
    serverSettings = { elevationEnabled: 'false', elevationSourceUrl: 'https://example.com/{z}/{x}/{y}.png' };
    renderSettings();

    const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
    await waitFor(() => expect(urlInput.value).toBe('https://example.com/{z}/{x}/{y}.png'));
    const checkbox = document.getElementById('elevationEnabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('defaults the enable toggle on when the server key is absent (matches useElevationEnabled semantics)', async () => {
    serverSettings = {};
    renderSettings();
    await screen.findByLabelText(/Elevation Source URL/i);
    const checkbox = document.getElementById('elevationEnabled') as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it('persists an edited enable toggle and source URL into the save POST body', async () => {
    // The initial URL must differ from the local-state default ('') so the
    // load barrier below can tell "settings fetch landed" apart from "still
    // showing defaults" — elevationEnabled alone can't (both are true).
    serverSettings = { elevationEnabled: 'true', elevationSourceUrl: 'https://initial.example/{z}/{x}/{y}.png' };
    renderSettings();
    const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
    const checkbox = document.getElementById('elevationEnabled') as HTMLInputElement;

    // Load barrier: the settings fetch populates local state asynchronously;
    // interacting before it lands lets the load overwrite the edits below
    // (failed deterministically on loaded CI runners, passed in isolation).
    await waitFor(() => expect(urlInput.value).toBe('https://initial.example/{z}/{x}/{y}.png'));
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    fireEvent.change(urlInput, { target: { value: 'https://custom.example/{z}/{x}/{y}.png' } });
    // PROBE: the URL change forces a re-render; a controlled checkbox whose
    // state never committed would snap back to checked here.
    await waitFor(() => expect(checkbox.checked).toBe(false));
    await waitFor(() => expect(urlInput.value).toBe('https://custom.example/{z}/{x}/{y}.png'));

    expect(saveBarCapture.current).not.toBeNull();
    await saveBarCapture.current!.onSave();

    expect(csrfFetchMock).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'POST' })
    );
    const [, options] = csrfFetchMock.mock.calls[csrfFetchMock.mock.calls.length - 1];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.elevationEnabled).toBe('false'); // toggled off from the loaded 'true'
    expect(body.elevationSourceUrl).toBe('https://custom.example/{z}/{x}/{y}.png');
  });

  it('handleSave dependency-array regression guard: an edit to ONLY the source URL is reflected in the very next save', async () => {
    // Distinctive initial URL = load barrier signal (see the persistence test).
    serverSettings = { elevationEnabled: 'true', elevationSourceUrl: 'https://initial.example/{z}/{x}/{y}.png' };
    renderSettings();
    const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
    await waitFor(() => expect(urlInput.value).toBe('https://initial.example/{z}/{x}/{y}.png'));

    // Edit nothing else — isolates the elevationSourceUrl dependency. If it
    // were missing from handleSave's useCallback deps (the CLAUDE.md
    // dep-array gotcha), this change alone would not recreate the callback
    // and the stale (empty) URL would be POSTed instead.
    fireEvent.change(urlInput, { target: { value: 'https://regression-guard.example/tiles' } });

    await saveBarCapture.current!.onSave();
    const [, options] = csrfFetchMock.mock.calls[csrfFetchMock.mock.calls.length - 1];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.elevationSourceUrl).toBe('https://regression-guard.example/tiles');
  });

  it('Test button calls ApiService.testElevationSource and renders a success message', async () => {
    testElevationSourceMock.mockResolvedValue({
      success: true,
      detectedType: 'terrarium',
      sampleElevation: 123.4,
      latencyMs: 42,
    });
    renderSettings();
    const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: 'https://probe.example/tiles' } });

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    expect(testElevationSourceMock).toHaveBeenCalledWith('https://probe.example/tiles');
    expect(await screen.findByText(/OK — terrarium, 123.4 m in 42 ms/)).toBeInTheDocument();
  });

  // Browser-validation follow-up to WP-3: clicking Test with an empty URL
  // field was sending an empty `url` and surfacing the route's raw 400
  // "Request body must include a url" message, even though the field's own
  // helper text says an empty value falls back to the default public
  // Terrarium source. Test must probe what will actually be used.
  describe('Test button with an empty source URL (default-fallback follow-up)', () => {
    it('sends the default Terrarium URL instead of an empty string', async () => {
      testElevationSourceMock.mockResolvedValue({
        success: true,
        detectedType: 'terrarium',
        sampleElevation: 8732,
        latencyMs: 294,
      });
      renderSettings();
      // serverSettings.elevationSourceUrl is '' in beforeEach — field starts empty.
      const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
      expect(urlInput.value).toBe('');

      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      expect(testElevationSourceMock).toHaveBeenCalledWith(DEFAULT_TERRARIUM_URL);
    });

    it('trims a whitespace-only field before falling back to the default URL', async () => {
      testElevationSourceMock.mockResolvedValue({
        success: true,
        detectedType: 'terrarium',
        sampleElevation: 100,
        latencyMs: 50,
      });
      renderSettings();
      const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
      fireEvent.change(urlInput, { target: { value: '   ' } });

      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      expect(testElevationSourceMock).toHaveBeenCalledWith(DEFAULT_TERRARIUM_URL);
    });

    it('labels a successful default-source probe result as "(default source)"', async () => {
      testElevationSourceMock.mockResolvedValue({
        success: true,
        detectedType: 'terrarium',
        sampleElevation: 8732,
        latencyMs: 294,
      });
      renderSettings();
      fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

      expect(
        await screen.findByText(/OK — terrarium, 8732 m in 294 ms \(default source\)/)
      ).toBeInTheDocument();
    });

    it('does not append the "(default source)" label when an explicit URL was tested', async () => {
      testElevationSourceMock.mockResolvedValue({
        success: true,
        detectedType: 'terrarium',
        sampleElevation: 123.4,
        latencyMs: 42,
      });
      renderSettings();
      const urlInput = (await screen.findByLabelText(/Elevation Source URL/i)) as HTMLInputElement;
      fireEvent.change(urlInput, { target: { value: 'https://probe.example/tiles' } });
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      const message = await screen.findByText(/OK — terrarium, 123.4 m in 42 ms/);
      expect(message.textContent).not.toMatch(/default source/);
    });
  });

  it('Test button renders the server-reported error on a failed probe', async () => {
    testElevationSourceMock.mockResolvedValue({
      success: false,
      detectedType: 'unknown',
      sampleElevation: null,
      latencyMs: 10,
      error: 'Connection refused',
    });
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText('Connection refused')).toBeInTheDocument();
  });

  it('Test button renders a generic failure message when the probe throws', async () => {
    testElevationSourceMock.mockRejectedValue(new Error('network down'));
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText('network down')).toBeInTheDocument();
  });
});
