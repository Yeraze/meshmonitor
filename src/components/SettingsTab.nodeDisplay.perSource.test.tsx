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
 *     the ten NODE_DISPLAY_SETTING_KEYS (by count AND name against the
 *     constant itself), the unscoped one carries none of them.
 *  3. mode="global" issues one POST with all keys (byte-identical shape to
 *     pre-split behaviour).
 *  4. Editing a dimming input marks the SaveBar dirty; saving clears it.
 *  5. sourceType="meshcore" hides localStatsIntervalMinutes and
 *     nodeHopsCalculation; sourceType="meshtastic_tcp" shows them. This is
 *     the MeshCore hide-branch's ONLY exercise (§4.4(e) / §6 "not
 *     browser-validatable in this phase" — SettingsTab never mounts under a
 *     MeshCore route until Phase 4).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within, fireEvent, waitFor } from '@testing-library/react';
import SettingsTab from './SettingsTab';
import { SourceProvider } from '../contexts/SourceContext';
import { NODE_DISPLAY_SETTING_KEYS } from '../constants/nodeDisplayDefaults';

// ---------------------------------------------------------------------------
// Contexts / hooks — same isolation strategy as SettingsTab.elevation.test.tsx
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
    // canWriteSettings gates the (unrelated, global-only) Position Estimation
    // section — keep it out of the render so this suite doesn't also need to
    // mock PositionEstimationSection's internals.
    hasPermission: () => false,
  }),
}));

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

// Real (stateful) useSettings() — see file header. `React.useState` inside a
// vi.mock factory is fine: it's invoked as an ordinary hook from inside
// SettingsTab's own render, same call order every render.
vi.mock('../contexts/SettingsContext', () => ({
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
      setMapCenterTargetZoom: vi.fn(),
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
};

beforeEach(() => {
  serverSettings = {};
  capturedSettingsGetUrls = [];
  csrfFetchMock.mockClear();
  csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
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
    expect(Object.keys(scopedBody).sort()).toEqual([...NODE_DISPLAY_SETTING_KEYS].sort());
    for (const key of NODE_DISPLAY_SETTING_KEYS) {
      expect(globalBody).not.toHaveProperty(key);
    }
    // Sanity: the unscoped body still carries ordinary global keys.
    expect(globalBody).toHaveProperty('temperatureUnit');
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

describe('SettingsTab — MeshCore hide-branch (#4412 Phase 3 WP4e)', () => {
  it('hides localStatsIntervalMinutes and nodeHopsCalculation for sourceType="meshcore"', async () => {
    render(
      <SourceProvider sourceId="source-mc" sourceType="meshcore">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => expect(saveBarCapture.current).not.toBeNull());
    expect(document.getElementById('localStatsIntervalMinutes')).not.toBeInTheDocument();
    expect(document.getElementById('nodeHopsCalculation')).not.toBeInTheDocument();
    // The rest of the Node Display section still renders.
    expect(document.getElementById('settings-node-display')).toBeInTheDocument();
  });

  it('shows localStatsIntervalMinutes and nodeHopsCalculation for sourceType="meshtastic_tcp"', async () => {
    render(
      <SourceProvider sourceId="source-mt" sourceType="meshtastic_tcp">
        <SettingsTab {...baseProps} mode="source" />
      </SourceProvider>
    );

    await waitFor(() => expect(saveBarCapture.current).not.toBeNull());
    await waitFor(() => {
      expect(document.getElementById('localStatsIntervalMinutes')).toBeInTheDocument();
      expect(document.getElementById('nodeHopsCalculation')).toBeInTheDocument();
    });
  });
});
