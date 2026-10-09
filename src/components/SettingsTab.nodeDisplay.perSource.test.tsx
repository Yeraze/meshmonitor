/**
 * @vitest-environment jsdom
 *
 * SettingsTab — per-source Node Display GET/POST split (#4412 Phase 3 WP4).
 * Mirrors SettingsTab.elevation.test.tsx's isolation strategy: mock every
 * dependency that isn't the behaviour under test, so this suite can render
 * SettingsTab standalone.
 *
 * Unlike the elevation suite, `useSettings()` here is a REAL (stateful) hook
 * built on `React.useState` inside the mock factory — not a static object
 * with inert `vi.fn()` setters — because item (4) below needs the dimming
 * trio's context setters to actually update the value applyDraft() reads
 * back on the next render (a static mock's setters are no-ops, so
 * "hasChanges clears after save" can never go true→false against one).
 *
 * Covers the phase's centrepiece assertions (spec §5.1):
 *  1. mode="source" inside a SourceProvider GETs /api/settings?sourceId=X.
 *  2. Save in source mode issues two POSTs; the scoped one carries exactly
 *     NODE_DISPLAY_SETTING_KEYS (by count AND name against the constant
 *     itself), the unscoped one carries none of them.
 *  3. mode="global" issues one POST with all keys (byte-identical shape to
 *     pre-split behaviour).
 *  4. Editing a dimming input marks the SaveBar dirty; saving clears it.
 *
 * #4412 Phase 4 WP4: the former item 5 here (`sourceType="meshcore"` hides
 * localStatsIntervalMinutes/nodeHopsCalculation) was removed along with the
 * SettingsTab branch it exercised. SettingsTab never mounts under a MeshCore
 * route (see D1/D2 in docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE4_SPEC.md),
 * so the branch was dead code and its test passed vacuously. MeshCore's Node
 * Display settings now live in MeshCoreNodeDisplaySection, covered by
 * MeshCoreNodeDisplaySection.test.tsx.
 *
 * #5364/#5365 Phase 1 WP5: NODE_DISPLAY_SETTING_KEYS grew from ten to
 * thirteen (the frozen seeded ten + three unseeded likely-aircraft keys,
 * spec §4.6). Items 2/3 above still assert against the imported constant
 * itself, so they cover the new count automatically with no code change.
 * The new "Likely aircraft detection" describe block below covers the
 * aircraft-specific behaviour: load/save, range clamping, and the
 * elevation-off warning.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import SettingsTab from './SettingsTab';
import { SourceProvider } from '../contexts/SourceContext';
import { NODE_DISPLAY_SETTING_KEYS, SETTINGS_TAB_PER_SOURCE_KEYS } from '../constants/nodeDisplayDefaults';
import { GLOBAL_ONLY_SETTINGS_KEYS } from '../server/constants/settings';

// ---------------------------------------------------------------------------
// Contexts / hooks — same isolation strategy as SettingsTab.elevation.test.tsx
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
      numberScope?: { invalid: boolean; reset: () => void };
    };
  },
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: {
    current: null as null | {
      hasChanges: boolean;
      onSave: () => Promise<void>;
      onDismiss: () => void;
      // #5649: SettingsTab hands the SaveBar its number-field scope; the real
      // SaveBar refuses to save while `invalid` is true.
      numberScope?: { invalid: boolean; reset: () => void };
    },
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { user: { isAdmin: true } },
    // canWriteSettings gates the (unrelated, global-only) Position Estimation
    // section — keep it out of the render so this suite doesn't also need to
    // mock PositionEstimationSection's internals.
    hasPermission: () => false,
  }),
}));

const { showToastMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
}));
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
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

// Real (stateful) useSettings() — see file header. `React.useState` inside a
// vi.mock factory is fine: it's invoked as an ordinary hook from inside
// SettingsTab's own render, same call order every render.
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  getEffectiveTileset: () => 'osm',
  useSettings: () => {
    const [nodeDimmingEnabled, setNodeDimmingEnabled] = React.useState(false);
    const [nodeDimmingStartHours, setNodeDimmingStartHours] = React.useState(1);
    const [nodeDimmingMinOpacity, setNodeDimmingMinOpacity] = React.useState(0.3);
    const [hideIncompleteNodes, setHideIncompleteNodes] = React.useState(false);
    const [nodeHopsCalculation, setNodeHopsCalculation] = React.useState<'nodeinfo' | 'traceroute' | 'messages'>('nodeinfo');
    return {
      customThemes: [],
      customTilesets: [],
      enableAudioNotifications: false,
      setEnableAudioNotifications: vi.fn(),
      linkPreviewsEnabled: true,
      setLinkPreviewsEnabled: vi.fn(),
      discardInvalidPositions: true,
      setDiscardInvalidPositions: vi.fn(),
      noIndexEnabled: false,
      setNoIndexEnabled: vi.fn(),
      meshcoreChannelRetryEnabled: false,
      setMeshcoreChannelRetryEnabled: vi.fn(),
      nodeDimmingEnabled,
      setNodeDimmingEnabled,
      nodeDimmingStartHours,
      setNodeDimmingStartHours,
      nodeDimmingMinOpacity,
      setNodeDimmingMinOpacity,
      nodeHopsCalculation,
      setNodeHopsCalculation,
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
      hideIncompleteNodes,
      showIncompleteNodes: !hideIncompleteNodes,
      setHideIncompleteNodes,
    };
  },
}));

// ---------------------------------------------------------------------------
// Child sections unrelated to Node Display — stub to null so this suite only
// exercises the GET/save-split and the Node Display JSX. Same list as
// SettingsTab.elevation.test.tsx (both mode="source" and mode="global" render
// paths are exercised here, so both section trees need stubbing).
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
vi.mock('./TapbackEmojiSettings', () => ({ default: () => null }));
vi.mock('./settings/EmbedSettings', () => ({ default: () => null }));
vi.mock('./configuration/DefaultMapCenterPicker', () => ({ DefaultMapCenterPicker: () => null }));
vi.mock('./GeoJsonLayerManager', () => ({ default: () => null }));
vi.mock('./MapStyleManager', () => ({ default: () => null }));

// ---------------------------------------------------------------------------
// Mount-time raw `fetch` calls (system status / db health / server settings —
// none of these go through ApiService's mocked methods or csrfFetch).
// apiService.get() is left un-mocked so the real ApiService.request() runs
// against this fetch mock — that's how the scoped/unscoped `/api/settings`
// URL actually gets exercised for real.
// ---------------------------------------------------------------------------
let serverSettings: Record<string, string>;
let capturedSettingsGetUrls: string[];

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const jsonHeaders = { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) };
    if (url.includes('/api/config')) {
      return { ok: true, headers: jsonHeaders, json: async () => ({ baseUrl: '' }) } as unknown as Response;
    }
    if (url.includes('/api/system/status')) {
      return { ok: true, headers: jsonHeaders, json: async () => ({ isDocker: false }) } as unknown as Response;
    }
    if (url.includes('/api/health')) {
      return { ok: true, headers: jsonHeaders, json: async () => ({ databaseType: 'sqlite', firmwareOtaEnabled: false }) } as unknown as Response;
    }
    if (url.includes('/api/settings')) {
      capturedSettingsGetUrls.push(url);
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

beforeEach(() => {
  serverSettings = {};
  capturedSettingsGetUrls = [];
  csrfFetchMock.mockClear();
  csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  showToastMock.mockClear();
  saveBarCapture.current = null;
  installFetchMock();
});

describe('SettingsTab — scoped GET (#4412 Phase 3 WP4a)', () => {
  it('mode="source" inside a SourceProvider GETs /api/settings scoped to the active source', async () => {
    serverSettings = { localStatsIntervalMinutes: '45' };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => {
      const input = document.getElementById('localStatsIntervalMinutes') as HTMLInputElement;
      expect(input.value).toBe('45');
    });

    expect(capturedSettingsGetUrls.some((u) => u.includes('/api/settings?sourceId=source-a'))).toBe(true);
  });

  it('mode="global" (no SourceProvider) GETs /api/settings unscoped', async () => {
    render(<SettingsTab {...baseProps} mode="global" />);

    await waitFor(() => expect(capturedSettingsGetUrls.length).toBeGreaterThan(0));

    expect(capturedSettingsGetUrls.some((u) => u.includes('sourceId='))).toBe(false);
    expect(capturedSettingsGetUrls.some((u) => u.endsWith('/api/settings'))).toBe(true);
  });
});

describe('SettingsTab — TX-target window when the node window is 0 (#5376)', () => {
  it('loads the stored per-source value, shows the TX warning, and saves an edit on the scoped POST', async () => {
    serverSettings = { txTargetMaxAgeHoursWhenUnlimited: '72' };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    const input = await waitFor(() => {
      const el = document.getElementById('txTargetMaxAgeHoursWhenUnlimited') as HTMLInputElement;
      expect(el.value).toBe('72');
      return el;
    });
    expect(input.min).toBe('1');
    expect(input.max).toBe('720');
    expect(document.querySelector('[data-testid="tx-target-window-warning"]')).not.toBeNull();

    fireEvent.change(input, { target: { value: '12' } });
    expect(saveBarCapture.current).not.toBeNull();
    await saveBarCapture.current!.onSave();

    const calls = csrfFetchMock.mock.calls as [string, RequestInit][];
    const scopedCall = calls.find(([url]) => url.includes('sourceId='));
    const globalCall = calls.find(([url]) => !url.includes('sourceId='));
    expect(JSON.parse(scopedCall![1].body as string).txTargetMaxAgeHoursWhenUnlimited).toBe('12');
    expect(JSON.parse(globalCall![1].body as string)).not.toHaveProperty('txTargetMaxAgeHoursWhenUnlimited');
  });
});

describe('SettingsTab — split save (#4412 Phase 3 WP4b)', () => {
  it('save in source mode issues two POSTs: the scoped one carries exactly the ten Node Display keys, the unscoped one carries none of them', async () => {
    serverSettings = { localStatsIntervalMinutes: '45' };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => {
      const input = document.getElementById('localStatsIntervalMinutes') as HTMLInputElement;
      expect(input.value).toBe('45');
    });

    expect(saveBarCapture.current).not.toBeNull();
    await saveBarCapture.current!.onSave();

    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
    const calls = csrfFetchMock.mock.calls as [string, RequestInit][];
    const scopedCall = calls.find(([url]) => url.includes('sourceId='));
    const globalCall = calls.find(([url]) => !url.includes('sourceId='));
    expect(scopedCall).toBeDefined();
    expect(globalCall).toBeDefined();
    expect(scopedCall![0]).toBe('/api/settings?sourceId=source-a');
    expect(globalCall![0]).toBe('/api/settings');

    const scopedBody = JSON.parse(scopedCall![1].body as string);
    const globalBody = JSON.parse(globalCall![1].body as string);

    // The non-negotiable assertion (spec §2.2 R6 / §4.4): by COUNT and by
    // NAME against NODE_DISPLAY_SETTING_KEYS itself, not a hand-copied list —
    // a key silently dropping from the scoped POST must fail this.
    // #5376 adds the per-source TX-target window to the scoped body.
    expect(Object.keys(scopedBody).sort()).toEqual([...SETTINGS_TAB_PER_SOURCE_KEYS].sort());
    for (const key of NODE_DISPLAY_SETTING_KEYS) {
      expect(scopedBody).toHaveProperty(key);
    }
    for (const key of SETTINGS_TAB_PER_SOURCE_KEYS) {
      expect(globalBody).not.toHaveProperty(key);
    }
    expect(scopedBody.txTargetMaxAgeHoursWhenUnlimited).toBe('24');
    // Sanity: the unscoped body still carries ordinary global keys.
    expect(globalBody).toHaveProperty('temperatureUnit');
  });

  // #5558: appearance is a global preference. A save from inside a source
  // must carry it on the UNSCOPED POST (the sourced route drops global-only
  // keys), so the landing page and Global Settings see the same theme.
  it('save in source mode sends the appearance keys on the unscoped POST and no global-only key on the scoped one', async () => {
    serverSettings = { appearanceMode: 'dark', darkTheme: 'mocha', lightTheme: 'mocha' };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );
    await waitFor(() => expect(saveBarCapture.current).not.toBeNull());
    await saveBarCapture.current!.onSave();

    const calls = csrfFetchMock.mock.calls as [string, RequestInit][];
    const scopedBody = JSON.parse(calls.find(([url]) => url.includes('sourceId='))![1].body as string);
    const globalBody = JSON.parse(calls.find(([url]) => !url.includes('sourceId='))![1].body as string);

    for (const key of ['theme', 'appearanceMode', 'darkTheme', 'lightTheme']) {
      expect(globalBody).toHaveProperty(key);
      expect(scopedBody).not.toHaveProperty(key);
    }
    for (const key of Object.keys(scopedBody)) {
      expect(GLOBAL_ONLY_SETTINGS_KEYS.has(key)).toBe(false);
    }
  });

  it('save in mode="global" issues a single unscoped POST containing all keys, including the ten Node Display keys', async () => {
    serverSettings = { elevationEnabled: 'true', elevationSourceUrl: 'https://barrier.example/tiles' };
    render(<SettingsTab {...baseProps} mode="global" />);

    // Load barrier — waits for fetchServerSettings to resolve before saving,
    // same pattern as SettingsTab.elevation.test.tsx.
    await waitFor(() => {
      const urlInput = document.getElementById('elevationSourceUrl') as HTMLInputElement | null;
      expect(urlInput?.value).toBe('https://barrier.example/tiles');
    });

    expect(saveBarCapture.current).not.toBeNull();
    await saveBarCapture.current!.onSave();

    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = csrfFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings');
    const body = JSON.parse(options.body as string);
    for (const key of NODE_DISPLAY_SETTING_KEYS) {
      expect(body).toHaveProperty(key);
    }
    expect(body).toHaveProperty('temperatureUnit');
  });

  // Pins the partial-write failure mode documented on handleSave's `if
  // (sourceQuery)` branch: the two POSTs are sequential awaits, so a global
  // POST success followed by a scoped POST failure leaves the global half
  // already committed server-side with no rollback. The code's only
  // observable reaction is the generic catch — an error toast and skipping
  // applyDraft — it does not distinguish "both POSTs failed" from "only the
  // second one did".
  it('when the global POST succeeds but the scoped Node Display POST rejects, shows the save-failed toast and does not apply the draft (no rollback of the already-committed global half)', async () => {
    serverSettings = { localStatsIntervalMinutes: '45' };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => {
      const input = document.getElementById('localStatsIntervalMinutes') as HTMLInputElement;
      expect(input.value).toBe('45');
    });
    await waitFor(() => expect(saveBarCapture.current!.hasChanges).toBe(false));

    // Dirty the draft so a post-failure "hasChanges is still true" assertion
    // actually proves applyDraft never ran, rather than trivially holding
    // because nothing was edited.
    const section = document.getElementById('settings-node-display')!;
    const checkbox = within(section)
      .getByText('settings.node_dimming_enabled')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(saveBarCapture.current!.hasChanges).toBe(true));

    csrfFetchMock.mockReset();
    csrfFetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({}) })); // global POST
    csrfFetchMock.mockImplementationOnce(async () => { throw new Error('network error'); }); // scoped POST

    await saveBarCapture.current!.onSave();

    // Both POSTs were attempted (the global one committed before the scoped
    // one threw) — this is the "already applied server-side" half of the
    // partial-write comment.
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);

    // The generic catch fires: save_failed toast, no success toast.
    expect(showToastMock).toHaveBeenCalledWith('settings.save_failed', 'error');
    expect(showToastMock).not.toHaveBeenCalledWith('settings.saved_success', 'success');

    // applyDraft never ran (it's only reached after both awaits succeed), so
    // the edited checkbox is still an unsaved change — the SaveBar stays
    // dirty rather than clearing as it would on a successful save.
    expect(saveBarCapture.current!.hasChanges).toBe(true);
  });
});

describe('SettingsTab — dimming trio dirty-tracking (#4412 Phase 3 WP4c)', () => {
  it('editing the dimming enabled checkbox marks the SaveBar dirty; saving clears it', async () => {
    render(<SettingsTab {...baseProps} mode="source" />);

    await waitFor(() => expect(saveBarCapture.current).not.toBeNull());
    await waitFor(() => expect(saveBarCapture.current!.hasChanges).toBe(false));

    const section = document.getElementById('settings-node-display')!;
    const checkbox = within(section)
      .getByText('settings.node_dimming_enabled')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(saveBarCapture.current!.hasChanges).toBe(true);

    await saveBarCapture.current!.onSave();
    await waitFor(() => expect(saveBarCapture.current!.hasChanges).toBe(false));
  });
});

// #5364/#5365 Phase 1 WP5, spec §5.10/§6.
describe('SettingsTab — likely-aircraft detection (#5364/#5365 Phase 1 WP5)', () => {
  it('an unset source shows the hardcoded defaults: detection on, AGL 500, MSL 5000', async () => {
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => {
      const enabled = document.getElementById('aircraftDetectionEnabled') as HTMLInputElement;
      const agl = document.getElementById('aircraftAglThresholdMeters') as HTMLInputElement;
      const msl = document.getElementById('aircraftMslThresholdMeters') as HTMLInputElement;
      expect(enabled.checked).toBe(true);
      expect(agl.value).toBe('500');
      expect(msl.value).toBe('5000');
    });
  });

  it('loading source A with a stored aircraftAglThresholdMeters shows that value', async () => {
    serverSettings = { aircraftAglThresholdMeters: '800' };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => {
      const agl = document.getElementById('aircraftAglThresholdMeters') as HTMLInputElement;
      expect(agl.value).toBe('800');
    });
  });

  it('editing a threshold and saving sends it on the scoped POST only', async () => {
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    const agl = await waitFor(() => {
      const el = document.getElementById('aircraftAglThresholdMeters') as HTMLInputElement;
      expect(el.value).toBe('500');
      return el;
    });

    fireEvent.change(agl, { target: { value: '900' } });
    await waitFor(() => expect(agl.value).toBe('900'));
    expect(saveBarCapture.current!.hasChanges).toBe(true);

    await saveBarCapture.current!.onSave();

    const calls = csrfFetchMock.mock.calls as [string, RequestInit][];
    const scopedCall = calls.find(([url]) => url.includes('sourceId='));
    const globalCall = calls.find(([url]) => !url.includes('sourceId='));
    expect(scopedCall).toBeDefined();
    expect(globalCall).toBeDefined();
    const scopedBody = JSON.parse(scopedCall![1].body as string);
    const globalBody = JSON.parse(globalCall![1].body as string);
    expect(scopedBody.aircraftAglThresholdMeters).toBe('900');
    expect(globalBody).not.toHaveProperty('aircraftAglThresholdMeters');
  });

  // #5649: these two used to assert a clamp on every keystroke (10 -> 50,
  // 99999 -> 20000). The limit is unchanged, but it is now enforced by
  // blocking: the text stays as typed, the field is marked invalid, the draft
  // keeps the last valid number, and the SaveBar scope reports invalid.
  it('blocks an out-of-range AGL threshold (AIRCRAFT_AGL_RANGE) instead of clamping the keystroke', async () => {
    render(<SettingsTab {...baseProps} mode="source" />);

    const agl = await waitFor(() => {
      const el = document.getElementById('aircraftAglThresholdMeters') as HTMLInputElement;
      expect(el.value).toBe('500');
      return el;
    });

    fireEvent.change(agl, { target: { value: '10' } }); // below min (50)
    await waitFor(() => expect(saveBarCapture.current!.numberScope!.invalid).toBe(true));
    expect(agl.value).toBe('10');
    expect(agl).toHaveAttribute('aria-invalid', 'true');
    expect(saveBarCapture.current!.hasChanges).toBe(false); // 10 never reached the draft

    fireEvent.change(agl, { target: { value: '99999' } }); // above max (20000)
    expect(agl.value).toBe('99999');
    expect(agl).toHaveAttribute('aria-invalid', 'true');
    expect(saveBarCapture.current!.numberScope!.invalid).toBe(true);

    fireEvent.change(agl, { target: { value: '50' } }); // the floor itself is legal
    await waitFor(() => expect(saveBarCapture.current!.numberScope!.invalid).toBe(false));
    expect(agl).not.toHaveAttribute('aria-invalid');
  });

  it('blocks an out-of-range MSL threshold (AIRCRAFT_MSL_RANGE) instead of clamping the keystroke', async () => {
    render(<SettingsTab {...baseProps} mode="source" />);

    const msl = await waitFor(() => {
      const el = document.getElementById('aircraftMslThresholdMeters') as HTMLInputElement;
      expect(el.value).toBe('5000');
      return el;
    });

    fireEvent.change(msl, { target: { value: '10' } }); // below min (500)
    await waitFor(() => expect(saveBarCapture.current!.numberScope!.invalid).toBe(true));
    expect(msl.value).toBe('10');
    expect(msl).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(msl, { target: { value: '99999' } }); // above max (20000)
    expect(msl.value).toBe('99999');
    expect(msl).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(msl, { target: { value: '20000' } });
    await waitFor(() => expect(saveBarCapture.current!.numberScope!.invalid).toBe(false));
  });

  it('disables the threshold inputs when detection is off', async () => {
    serverSettings = { aircraftDetectionEnabled: 'false' };
    render(<SettingsTab {...baseProps} mode="source" />);

    await waitFor(() => {
      const enabled = document.getElementById('aircraftDetectionEnabled') as HTMLInputElement;
      expect(enabled.checked).toBe(false);
    });
    const agl = document.getElementById('aircraftAglThresholdMeters') as HTMLInputElement;
    const msl = document.getElementById('aircraftMslThresholdMeters') as HTMLInputElement;
    expect(agl.disabled).toBe(true);
    expect(msl.disabled).toBe(true);
  });

  it('shows the elevation-off warning when the global elevationEnabled setting is false', async () => {
    serverSettings = { elevationEnabled: 'false' };
    render(<SettingsTab {...baseProps} mode="source" />);

    await waitFor(() => {
      const section = document.getElementById('settings-node-display')!;
      expect(within(section).getByText('settings.aircraft.warn_elevation_disabled')).toBeInTheDocument();
    });
  });

  it('hides the elevation-off warning when elevationEnabled is on (or unset)', async () => {
    render(<SettingsTab {...baseProps} mode="source" />);

    await waitFor(() => {
      const section = document.getElementById('settings-node-display')!;
      expect(within(section).queryByText('settings.aircraft.warn_elevation_disabled')).not.toBeInTheDocument();
    });
  });

  it('the aircraft controls render only inside #settings-node-display', async () => {
    render(<SettingsTab {...baseProps} mode="source" />);

    await waitFor(() => {
      expect(document.getElementById('aircraftDetectionEnabled')).not.toBeNull();
    });
    const section = document.getElementById('settings-node-display')!;
    expect(within(section).getByText('settings.aircraft.title')).toBeInTheDocument();
    // Sanity: nothing with the same id exists twice (would indicate a leak
    // outside the Node Display section).
    expect(document.querySelectorAll('#aircraftDetectionEnabled').length).toBe(1);
  });
});

describe('SettingsTab — aircraft age-out (#5364/#5365 Phase 2)', () => {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  it('an unset source shows the defaults: off, 24 h, Ignore, and "not yet" for the last run', async () => {
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => {
      expect(byId<HTMLInputElement>('aircraftAgeOutEnabled').checked).toBe(false);
      expect(byId<HTMLInputElement>('aircraftAgeOutHours').value).toBe('24');
      expect(byId<HTMLSelectElement>('aircraftAgeOutAction').value).toBe('ignore');
    });
    // Hours and action are inactive while age-out is off.
    expect(byId<HTMLInputElement>('aircraftAgeOutHours').disabled).toBe(true);
    expect(byId<HTMLSelectElement>('aircraftAgeOutAction').disabled).toBe(true);
    expect(screen.getByTestId('aircraft-age-out-last-run')).toHaveTextContent('settings.aircraft.age_out_last_run_never');
    expect(screen.queryByTestId('aircraft-age-out-delete-warning')).not.toBeInTheDocument();
  });

  it('loads stored values and the read-only last-run line', async () => {
    serverSettings = {
      aircraftAgeOutEnabled: 'true',
      aircraftAgeOutHours: '48',
      aircraftAgeOutAction: 'delete',
      aircraftAgeOutLastRunAt: String(Date.UTC(2026, 8, 26, 12, 0, 0)),
      aircraftAgeOutLastResult: JSON.stringify({ agedOut: 2, fixed: 1, lifted: 3, deleted: 0 }),
    };
    render(<SettingsTab {...baseProps} mode="source" />);

    await waitFor(() => {
      expect(byId<HTMLInputElement>('aircraftAgeOutEnabled').checked).toBe(true);
      expect(byId<HTMLInputElement>('aircraftAgeOutHours').value).toBe('48');
      expect(byId<HTMLSelectElement>('aircraftAgeOutAction').value).toBe('delete');
    });
    // Delete carries its warning next to the select.
    expect(screen.getByTestId('aircraft-age-out-delete-warning')).toHaveTextContent('settings.aircraft.age_out_delete_warning');
    expect(screen.getByTestId('aircraft-age-out-last-run')).toHaveTextContent('settings.aircraft.age_out_last_run');
    expect(screen.getByTestId('aircraft-age-out-last-run')).not.toHaveTextContent('never');
  });

  // #5649: was "clamps hours into 6-168 on change" (2 -> 6, 500 -> 168). Same
  // limits, now enforced by blocking rather than by rewriting the keystroke.
  it('blocks hours outside 6-168 instead of clamping the keystroke', async () => {
    serverSettings = { aircraftAgeOutEnabled: 'true' };
    render(<SettingsTab {...baseProps} mode="source" />);

    const hours = await waitFor(() => {
      const el = byId<HTMLInputElement>('aircraftAgeOutHours');
      expect(el.disabled).toBe(false);
      return el;
    });
    fireEvent.change(hours, { target: { value: '2' } });
    await waitFor(() => expect(saveBarCapture.current!.numberScope!.invalid).toBe(true));
    expect(hours.value).toBe('2');
    expect(hours).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(hours, { target: { value: '500' } });
    expect(hours.value).toBe('500');
    expect(hours).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(hours, { target: { value: '168' } });
    await waitFor(() => expect(saveBarCapture.current!.numberScope!.invalid).toBe(false));
  });

  it('saving sends the three postable keys on the scoped POST only, never the server-written pair', async () => {
    serverSettings = {
      aircraftAgeOutLastRunAt: '1700000000000',
      aircraftAgeOutLastResult: JSON.stringify({ agedOut: 1, fixed: 0, lifted: 0, deleted: 0 }),
    };
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    const enabled = await waitFor(() => {
      const el = byId<HTMLInputElement>('aircraftAgeOutEnabled');
      expect(el).not.toBeNull();
      return el;
    });
    fireEvent.click(enabled);
    await waitFor(() => expect(byId<HTMLInputElement>('aircraftAgeOutHours').disabled).toBe(false));
    fireEvent.change(byId<HTMLInputElement>('aircraftAgeOutHours'), { target: { value: '72' } });
    fireEvent.change(byId<HTMLSelectElement>('aircraftAgeOutAction'), { target: { value: 'delete' } });
    await waitFor(() => expect(byId<HTMLSelectElement>('aircraftAgeOutAction').value).toBe('delete'));
    expect(saveBarCapture.current!.hasChanges).toBe(true);

    await saveBarCapture.current!.onSave();

    const calls = csrfFetchMock.mock.calls as [string, RequestInit][];
    const scopedCall = calls.find(([url]) => url.includes('sourceId='));
    const globalCall = calls.find(([url]) => !url.includes('sourceId='));
    const scopedBody = JSON.parse(scopedCall![1].body as string);
    const globalBody = JSON.parse(globalCall![1].body as string);
    expect(scopedBody.aircraftAgeOutEnabled).toBe('true');
    expect(scopedBody.aircraftAgeOutHours).toBe('72');
    expect(scopedBody.aircraftAgeOutAction).toBe('delete');
    for (const key of ['aircraftAgeOutEnabled', 'aircraftAgeOutHours', 'aircraftAgeOutAction',
      'aircraftAgeOutLastRunAt', 'aircraftAgeOutLastResult']) {
      expect(globalBody).not.toHaveProperty(key);
    }
    expect(scopedBody).not.toHaveProperty('aircraftAgeOutLastRunAt');
    expect(scopedBody).not.toHaveProperty('aircraftAgeOutLastResult');
  });
});

// ---------------------------------------------------------------------------
// #5649: number settings can be cleared; a blank or out-of-range field blocks
// Save and never reaches the POST body. `useSaveBar` is mocked in this file,
// so the block is observed as the `numberScope.invalid` flag SettingsTab hands
// it; SaveBar.test.tsx covers the bar refusing to save a section so flagged.
// ---------------------------------------------------------------------------
describe('SettingsTab — clearable number fields (#5649)', () => {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const renderScoped = () =>
    render(
      <SourceProvider sourceId="source-a" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );
  const scope = () => saveBarCapture.current!.numberScope!;
  const postedBodies = () => {
    const calls = csrfFetchMock.mock.calls as [string, RequestInit][];
    return calls
      .filter(([url, init]) => url.includes('/api/settings') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
  };

  it('a blanked interval stays blank, marks the section invalid, and is fixed by typing a number', async () => {
    serverSettings = { localStatsIntervalMinutes: '45' };
    renderScoped();
    const input = await waitFor(() => {
      const el = byId<HTMLInputElement>('localStatsIntervalMinutes');
      expect(el.value).toBe('45');
      return el;
    });
    expect(scope().invalid).toBe(false);

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(scope().invalid).toBe(true));
    // Nothing put 45 (or 0, which would mean "disabled") back in the field.
    expect(input.value).toBe('');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The blank never reached the draft, so there is nothing to save yet.
    expect(saveBarCapture.current!.hasChanges).toBe(false);

    fireEvent.change(input, { target: { value: '20' } });
    await waitFor(() => expect(scope().invalid).toBe(false));
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(saveBarCapture.current!.hasChanges).toBe(true);

    await saveBarCapture.current!.onSave();
    const bodies = postedBodies();
    const scoped = bodies.find((b) => 'localStatsIntervalMinutes' in b)!;
    // Same wire type as before the migration: this key goes as a string.
    expect(scoped.localStatsIntervalMinutes).toBe('20');
  });

  it('keeps the wire types and never posts a blank, NaN or null number', async () => {
    serverSettings = { localStatsIntervalMinutes: '45' };
    renderScoped();
    const age = await waitFor(() => {
      const el = byId<HTMLInputElement>('maxNodeAge');
      expect(el).not.toBeNull();
      return el;
    });
    const stats = byId<HTMLInputElement>('localStatsIntervalMinutes');
    await waitFor(() => expect(stats.value).toBe('45'));

    // One field holds a real edit; another is left blank.
    fireEvent.change(age, { target: { value: '48' } });
    fireEvent.change(stats, { target: { value: '' } });
    await waitFor(() => expect(scope().invalid).toBe(true));
    expect(saveBarCapture.current!.hasChanges).toBe(true);

    // The real SaveBar would not call onSave here. Force it anyway: even then
    // the blank field contributes its last valid number, not '' / NaN / null.
    await saveBarCapture.current!.onSave();
    const bodies = postedBodies();
    expect(bodies.length).toBeGreaterThan(0);
    const scoped = bodies.find((b) => 'maxNodeAgeHours' in b)!;
    expect(scoped.maxNodeAgeHours).toBe(48); // a number, as before
    expect(scoped.localStatsIntervalMinutes).toBe('45');
    for (const body of bodies) {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
        expect(value, key).not.toBe('NaN');
      }
      expect(JSON.stringify(body)).not.toContain('NaN');
    }
  });

  it('blocks a check interval below its floor rather than saving it or turning it into 0', async () => {
    renderScoped();
    const interval = await waitFor(() => {
      const el = byId<HTMLInputElement>('inactiveNodeCheckIntervalMinutes');
      expect(el).not.toBeNull();
      return el;
    });
    const before = interval.value;

    fireEvent.change(interval, { target: { value: '0' } }); // floor is 1 minute
    await waitFor(() => expect(scope().invalid).toBe(true));
    expect(interval.value).toBe('0');
    expect(interval).toHaveAttribute('aria-invalid', 'true');
    expect(saveBarCapture.current!.hasChanges).toBe(false);

    // Dismiss on the real SaveBar calls the scope's reset: the field shows the saved value again.
    scope().reset();
    await waitFor(() => expect(interval.value).toBe(before));
    await waitFor(() => expect(scope().invalid).toBe(false));
  });

  it('accepts 0 for the node window: the server and the help text both define it as "show all"', async () => {
    renderScoped();
    const age = await waitFor(() => {
      const el = byId<HTMLInputElement>('maxNodeAge');
      expect(el).not.toBeNull();
      return el;
    });
    fireEvent.change(age, { target: { value: '0' } });
    await waitFor(() => expect(saveBarCapture.current!.hasChanges).toBe(true));
    expect(age).not.toHaveAttribute('aria-invalid');
    expect(scope().invalid).toBe(false);

    fireEvent.change(age, { target: { value: '-1' } });
    await waitFor(() => expect(scope().invalid).toBe(true));
  });
});
