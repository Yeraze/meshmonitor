import React, { useState, useEffect, useCallback, useReducer, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import '../styles/settings.css';
import { useSaveBar } from '../hooks/useSaveBar';
import { TemperatureUnit } from '../utils/temperature';
import { SortField, SortDirection } from '../types/ui';
import { version } from '../../package.json';
import apiService from '../services/api';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { getAllTilesets, type TilesetId } from '../config/tilesets';
import PacketMonitorSettings from './PacketMonitorSettings';
import ChannelSoundPicker from './ChannelSoundPicker';
import PkiDmGlobalToggle from './settings/PkiDmGlobalToggle';
import SystemBackupSection from './configuration/SystemBackupSection';
import DatabaseMaintenanceSection from './configuration/DatabaseMaintenanceSection';
import FirmwareUpdateSection from './configuration/FirmwareUpdateSection';
import ChannelDatabaseSection from './configuration/ChannelDatabaseSection';
import { CustomThemeManagement } from './CustomThemeManagement';
import { CustomTilesetManager } from './CustomTilesetManager';
import { getEffectiveTileset, type Theme, type AppearanceMode, type NodeHopsCalculation, useSettings } from '../contexts/SettingsContext';
import { type SortOption as DashboardSortOption } from './Dashboard/types';
import { useUI } from '../contexts/UIContext';
import { LanguageSelector } from './LanguageSelector';
import SectionNav from './SectionNav';
import PositionEstimationSection from './PositionEstimationSection';
import TapbackEmojiSettings from './TapbackEmojiSettings';
import EmbedSettings from './settings/EmbedSettings';
import { DefaultMapCenterPicker } from './configuration/DefaultMapCenterPicker';
import { useAuth } from '../contexts/AuthContext';
import GeoJsonLayerManager from './GeoJsonLayerManager';
import MapStyleManager from './MapStyleManager';
import { useDashboardSources } from '../hooks/useDashboardData';
import { DEFAULT_TERRARIUM_URL } from '../types/elevation';

type DistanceUnit = 'km' | 'mi';
type PositionHistoryLineStyle = 'linear' | 'spline';
type TimeFormat = '12' | '24';
type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
type MapPinStyle = 'meshmonitor' | 'official';
type IconStyle = 'lucide' | 'emoji';

// --- Task 5.3 (#3962 Phase 5) draft-object rewrite ---------------------------------------------
// SettingsTab used to mirror every editable field into its own `local*` useState (49 of them),
// re-seeded/diffed/reset/saved via four hand-maintained dependency arrays enumerating every field
// (~35/~57/~35/~95 deps respectively). This collapses all 49 mirrors into one SettingsDraft
// reducer: `updateField` replaces every `setLocalXxx`, `baseline` (a memoized snapshot of the
// current context/props/initial* values) replaces the props-effect body, `hasChanges` is now
// `!settingsDraftEqual(draft, baseline)` instead of 57 hand-written `!==` comparisons, and
// `resetChanges`/`handleSave` operate on the whole draft generically instead of listing every
// field. See docs/internal/dev-notes/REMEDIATION_PLAN.md §5.3 and CLAUDE.md "Adding New Settings".
//
// Three save channels are preserved (see CLAUDE.md): (A) prop-callback-backed fields fan out via
// the `onXxxChange` props passed down from App.tsx; (B) context-setter-backed fields fan out via
// the (5.1/5.2-stabilized, useCallback-wrapped) SettingsContext/UIContext setters; (C) server-only
// fields have no prop/context home and are dirty-tracked against an `initial*` snapshot captured
// from the settings-fetch effect. `buildBaseline`/`applyDraft` below read/write all three uniformly.
interface SettingsDraft {
  // Category A + B fields, named as their POST-body key (see handleSave's explicit `settings = {}`
  // literal — server.settings-persistence.test.ts regex-parses that literal, so its keys must stay
  // literal source text, not a spread/computed payload).
  maxNodeAgeHours: number;
  inactiveNodeThresholdHours: number;
  inactiveNodeCheckIntervalMinutes: number;
  inactiveNodeCooldownHours: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  positionHistoryLineStyle: PositionHistoryLineStyle;
  telemetryVisualizationHours: number;
  favoriteTelemetryStorageDays: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  mapTilesetLight: TilesetId;
  mapTilesetDark: TilesetId;
  mapPinStyle: MapPinStyle;
  iconStyle: IconStyle;
  neighborInfoMinZoom: number;
  defaultMapCenterLat: number | null;
  defaultMapCenterLon: number | null;
  defaultMapCenterZoom: number | null;
  mapCenterTargetZoom: number;
  defaultLandingPage: string;
  appearanceMode: AppearanceMode;
  darkTheme: Theme;
  lightTheme: Theme;
  nodeHopsCalculation: NodeHopsCalculation;
  preferredDashboardSortOption: DashboardSortOption;
  linkPreviewsEnabled: boolean;
  discardInvalidPositions: boolean;
  noIndexEnabled: boolean;
  meshcoreChannelRetryEnabled: boolean;
  hideIncompleteNodes: boolean;
  solarMonitoringEnabled: boolean;
  solarMonitoringLatitude: number;
  solarMonitoringLongitude: number;
  solarMonitoringAzimuth: number;
  solarMonitoringDeclination: number;
  // Category C: server-only settings, no prop/context home — dirty-tracked against an `initial*`
  // snapshot (see buildBaseline) rather than a prop/context value.
  packetLogEnabled: boolean;
  packetLogMaxCount: number;
  packetLogMaxAgeHours: number;
  homoglyphEnabled: boolean;
  localStatsIntervalMinutes: number;
  meshcoreCliTimeoutSeconds: number;
  analyticsProvider: string;
  analyticsConfig: Record<string, string>;
  appriseApiServerUrl: string;
  elevationEnabled: boolean;
  elevationSourceUrl: string;
}

type SettingsDraftAction =
  | { type: 'field'; patch: Partial<SettingsDraft> }
  | { type: 'reseed'; next: SettingsDraft };

function settingsDraftReducer(state: SettingsDraft, action: SettingsDraftAction): SettingsDraft {
  switch (action.type) {
    case 'field':
      return { ...state, ...action.patch };
    case 'reseed':
      return action.next;
    default:
      return state;
  }
}

// Shallow-equal over the flat draft. Every field but `analyticsConfig` is a primitive (or null),
// compared by `===`; the one nested-object field is compared by JSON content so re-typing a value
// back to its original text doesn't spuriously report a change (matches the old
// `JSON.stringify(localAnalyticsConfig) !== initialAnalyticsConfig` comparison it replaces).
function settingsDraftEqual(a: SettingsDraft, b: SettingsDraft): boolean {
  const keys = Object.keys(a) as (keyof SettingsDraft)[];
  return keys.every((key) => {
    const av = a[key];
    const bv = b[key];
    if (av !== null && bv !== null && typeof av === 'object' && typeof bv === 'object') {
      return JSON.stringify(av) === JSON.stringify(bv);
    }
    return av === bv;
  });
}

// Pure function of (mode, dark, light) — replaces the old `getLocalEffectiveTheme` useCallback,
// which had no callers besides handleSave and doesn't need its own memoized identity.
function computeEffectiveTheme(mode: AppearanceMode, dark: Theme, light: Theme): Theme {
  if (mode === 'dark') return dark;
  if (mode === 'light') return light;
  const systemIsDark = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;
  return systemIsDark ? dark : light;
}

interface SettingsTabProps {
  maxNodeAgeHours: number;
  inactiveNodeThresholdHours: number;
  inactiveNodeCheckIntervalMinutes: number;
  inactiveNodeCooldownHours: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  positionHistoryLineStyle: PositionHistoryLineStyle;
  telemetryVisualizationHours: number;
  favoriteTelemetryStorageDays: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  mapTilesetLight: TilesetId;
  mapTilesetDark: TilesetId;
  mapPinStyle: MapPinStyle;
  iconStyle: IconStyle;
  theme: Theme;
  language: string;
  solarMonitoringEnabled: boolean;
  solarMonitoringLatitude: number;
  solarMonitoringLongitude: number;
  solarMonitoringAzimuth: number;
  solarMonitoringDeclination: number;
  currentNodeId: string;
  nodes: any[];
  baseUrl: string;
  onMaxNodeAgeChange: (hours: number) => void;
  onInactiveNodeThresholdHoursChange: (hours: number) => void;
  onInactiveNodeCheckIntervalMinutesChange: (minutes: number) => void;
  onInactiveNodeCooldownHoursChange: (hours: number) => void;
  onTemperatureUnitChange: (unit: TemperatureUnit) => void;
  onDistanceUnitChange: (unit: DistanceUnit) => void;
  onPositionHistoryLineStyleChange: (style: PositionHistoryLineStyle) => void;
  onTelemetryVisualizationChange: (hours: number) => void;
  onFavoriteTelemetryStorageDaysChange: (days: number) => void;
  onPreferredSortFieldChange: (field: SortField) => void;
  onPreferredSortDirectionChange: (direction: SortDirection) => void;
  onTimeFormatChange: (format: TimeFormat) => void;
  onDateFormatChange: (format: DateFormat) => void;
  onMapTilesetsChange: (light: TilesetId, dark: TilesetId) => void;
  onMapPinStyleChange: (style: MapPinStyle) => void;
  onIconStyleChange: (style: IconStyle) => void;
  onLanguageChange: (language: string) => void;
  onSolarMonitoringEnabledChange: (enabled: boolean) => void;
  onSolarMonitoringLatitudeChange: (latitude: number) => void;
  onSolarMonitoringLongitudeChange: (longitude: number) => void;
  onSolarMonitoringAzimuthChange: (azimuth: number) => void;
  onSolarMonitoringDeclinationChange: (declination: number) => void;
  mode?: 'global' | 'source';
}

const GLOBAL_SECTIONS = new Set([
  'settings-language', 'settings-units', 'settings-appearance', 'settings-link-previews', 'settings-privacy', 'settings-meshcore-messaging', 'settings-map',
  'settings-security',
  'settings-apprise-server', 'settings-elevation', 'settings-backup', 'settings-channel-database',
  'settings-maintenance', 'settings-analytics',
  // Position estimation is a single global, cross-source batch job (issue
  // #3271) — it belongs in global Settings, not the per-source Automation tab.
  'settings-position-estimation',
]);

const SOURCE_SECTIONS = new Set([
  'settings-sorting', 'settings-node-display', 'settings-telemetry',
  'settings-notifications', 'settings-packet-monitor', 'settings-solar',
  'settings-firmware', 'settings-reset-ui',
  'settings-management', 'settings-danger',
]);

const SettingsTab: React.FC<SettingsTabProps> = ({
  maxNodeAgeHours,
  inactiveNodeThresholdHours,
  inactiveNodeCheckIntervalMinutes,
  inactiveNodeCooldownHours,
  temperatureUnit,
  distanceUnit,
  positionHistoryLineStyle,
  telemetryVisualizationHours,
  favoriteTelemetryStorageDays,
  preferredSortField,
  preferredSortDirection,
  timeFormat,
  dateFormat,
  mapTilesetLight,
  mapTilesetDark,
  mapPinStyle,
  iconStyle,
  language,
  solarMonitoringEnabled,
  solarMonitoringLatitude,
  solarMonitoringLongitude,
  solarMonitoringAzimuth,
  solarMonitoringDeclination,
  currentNodeId,
  nodes,
  baseUrl,
  onMaxNodeAgeChange,
  onInactiveNodeThresholdHoursChange,
  onInactiveNodeCheckIntervalMinutesChange,
  onInactiveNodeCooldownHoursChange,
  onTemperatureUnitChange,
  onDistanceUnitChange,
  onPositionHistoryLineStyleChange,
  onTelemetryVisualizationChange,
  onFavoriteTelemetryStorageDaysChange,
  onPreferredSortFieldChange,
  onPreferredSortDirectionChange,
  onTimeFormatChange,
  onDateFormatChange,
  onMapTilesetsChange,
  onMapPinStyleChange,
  onIconStyleChange,
  onLanguageChange,
  onSolarMonitoringEnabledChange,
  onSolarMonitoringLatitudeChange,
  onSolarMonitoringLongitudeChange,
  onSolarMonitoringAzimuthChange,
  onSolarMonitoringDeclinationChange,
  mode
}) => {
  const show = (sectionId: string) =>
    !mode || (mode === 'global' ? GLOBAL_SECTIONS.has(sectionId) : SOURCE_SECTIONS.has(sectionId));

  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { authStatus, hasPermission } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin ?? false;
  // Position Estimation maps to the global `settings` resource on the backend
  // (status → settings:read, save/run-now → settings:write), so gate its UI on
  // the same permission rather than the per-source `automation` resource it
  // used to live under. isAdmin short-circuits inside hasPermission.
  const canWriteSettings = hasPermission('settings', 'write');
  const {
    customThemes,
    customTilesets,
    enableAudioNotifications,
    setEnableAudioNotifications,
    linkPreviewsEnabled,
    setLinkPreviewsEnabled,
    discardInvalidPositions,
    setDiscardInvalidPositions,
    noIndexEnabled,
    setNoIndexEnabled,
    meshcoreChannelRetryEnabled,
    setMeshcoreChannelRetryEnabled,
    nodeDimmingEnabled,
    setNodeDimmingEnabled,
    nodeDimmingStartHours,
    setNodeDimmingStartHours,
    nodeDimmingMinOpacity,
    setNodeDimmingMinOpacity,
    nodeHopsCalculation,
    setNodeHopsCalculation,
    preferredDashboardSortOption,
    setPreferredDashboardSortOption,
    neighborInfoMinZoom,
    setNeighborInfoMinZoom,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    setDefaultMapCenterLat,
    setDefaultMapCenterLon,
    setDefaultMapCenterZoom,
    mapCenterTargetZoom,
    setMapCenterTargetZoom,
    defaultLandingPage,
    setDefaultLandingPage,
    appearanceMode,
    setAppearanceMode,
    darkTheme,
    setDarkTheme,
    lightTheme,
    setLightTheme,
  } = useSettings();
  const { data: availableSources = [] } = useDashboardSources();
  const { showIncompleteNodes, setShowIncompleteNodes } = useUI();

  // Single draft reducer replacing the 49 `local*` mirrors (Task 5.3). Lazy-initialized once from
  // the current context/props values; category-C fields (no context/prop home) start at their
  // pre-fetch defaults and are corrected by the reseed effect once fetchServerSettings resolves.
  const [draft, dispatch] = useReducer(settingsDraftReducer, undefined, (): SettingsDraft => ({
    maxNodeAgeHours,
    inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours,
    temperatureUnit,
    distanceUnit,
    positionHistoryLineStyle,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    mapTilesetLight,
    mapTilesetDark,
    mapPinStyle,
    iconStyle,
    neighborInfoMinZoom,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapCenterTargetZoom,
    defaultLandingPage,
    appearanceMode,
    darkTheme,
    lightTheme,
    nodeHopsCalculation,
    preferredDashboardSortOption,
    linkPreviewsEnabled,
    discardInvalidPositions,
    noIndexEnabled,
    meshcoreChannelRetryEnabled,
    hideIncompleteNodes: !showIncompleteNodes,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    packetLogEnabled: false,
    packetLogMaxCount: 1000,
    packetLogMaxAgeHours: 24,
    homoglyphEnabled: false,
    localStatsIntervalMinutes: 15,
    meshcoreCliTimeoutSeconds: 15,
    analyticsProvider: 'none',
    analyticsConfig: {},
    appriseApiServerUrl: '',
    elevationEnabled: false,
    elevationSourceUrl: '',
  }));

  // Single stable field updater — every JSX onChange calls this instead of a per-field
  // `setLocalXxx`. Referentially stable ([] deps), so it never appears in a dependency array.
  const updateField = useCallback(<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    dispatch({ type: 'field', patch: { [key]: value } as Partial<SettingsDraft> });
  }, []);

  // initial* snapshots: category-C "pristine baseline" for server-only settings with no
  // prop/context home (dirty-tracked against these instead of a prop/context value — see
  // buildBaseline/baseline below). Populated by the server-fetch effect.
  const [initialPacketMonitorSettings, setInitialPacketMonitorSettings] = useState({ enabled: false, maxCount: 1000, maxAgeHours: 24 });
  const [initialHomoglyphEnabled, setInitialHomoglyphEnabled] = useState(false);
  const [initialLocalStatsIntervalMinutes, setInitialLocalStatsIntervalMinutes] = useState(15);
  // MeshCore CLI console reply-timeout (seconds), issue #4027. Local-only server-backed setting
  // (no SettingsContext prop), mirroring localStats above.
  const [initialMeshcoreCliTimeoutSeconds, setInitialMeshcoreCliTimeoutSeconds] = useState(15);
  const [initialAnalyticsProvider, setInitialAnalyticsProvider] = useState<string>('none');
  const [initialAnalyticsConfig, setInitialAnalyticsConfig] = useState<string>('{}');
  const [initialAppriseApiServerUrl, setInitialAppriseApiServerUrl] = useState<string>('');
  // Elevation / Terrain source settings (#4111 Phase 3 WP-3). Mirrors the Apprise API Server
  // pattern above: initial snapshot for dirty-tracking, admins receive the unmasked
  // `elevationSourceUrl` (stripSecretSettings returns the full map to admins).
  const [initialElevationEnabled, setInitialElevationEnabled] = useState(false);
  const [initialElevationSourceUrl, setInitialElevationSourceUrl] = useState('');
  // nodeDimming* lives in SettingsContext directly (not a draft mirror — its JSX binds straight to
  // context state), but is still dirty-tracked/saved/reset alongside the draft (see
  // nodeDimmingChanged / handleSave / resetChanges below).
  const [initialNodeDimmingSettings, setInitialNodeDimmingSettings] = useState({
    enabled: nodeDimmingEnabled,
    startHours: nodeDimmingStartHours,
    minOpacity: nodeDimmingMinOpacity,
  });

  // Transient/derived UI state — stays as plain useState (not draft fields, see §1.3 of the Task
  // 5.3 spec).
  const [isFetchingSolarEstimates, setIsFetchingSolarEstimates] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDocker, setIsDocker] = useState<boolean | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [databaseType, setDatabaseType] = useState<'sqlite' | 'postgres' | 'mysql' | null>(null);
  const [firmwareOtaEnabled, setFirmwareOtaEnabled] = useState(false);
  const [isTestingApprise, setIsTestingApprise] = useState<boolean>(false);
  const [appriseTestResult, setAppriseTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [elevationTestResult, setElevationTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [elevationTesting, setElevationTesting] = useState(false);
  const { showToast } = useToast();

  // Fetch system status to determine if running in Docker
  useEffect(() => {
    const fetchSystemStatus = async () => {
      try {
        const data = await apiService.get<{ isDocker?: boolean }>('/api/system/status');
        setIsDocker(!!data.isDocker);
      } catch (error) {
        logger.error('Failed to fetch system status:', error);
      }
    };
    void fetchSystemStatus();
  }, [baseUrl]);

  // Fetch database type from health endpoint (public, no auth required)
  useEffect(() => {
    const fetchDatabaseType = async () => {
      try {
        const data = await apiService.get<{ databaseType?: 'sqlite' | 'postgres' | 'mysql'; firmwareOtaEnabled?: boolean }>('/api/health');
        if (data.databaseType) {
          setDatabaseType(data.databaseType);
        }
        setFirmwareOtaEnabled(!!data.firmwareOtaEnabled);
      } catch (error) {
        logger.error('Failed to fetch database type:', error);
      }
    };
    void fetchDatabaseType();
  }, [baseUrl]);

  // Fetch packet monitor and other server-stored settings
  useEffect(() => {
    const fetchServerSettings = async () => {
      try {
        const settings = await apiService.get<Record<string, string>>('/api/settings');
        {
          const enabled = settings.packet_log_enabled === '1';
          const maxCount = parseInt(settings.packet_log_max_count || '1000', 10);
          const maxAgeHours = parseInt(settings.packet_log_max_age_hours || '24', 10);
          const hideIncomplete = settings.hideIncompleteNodes === '1';

          updateField('packetLogEnabled', enabled);
          updateField('packetLogMaxCount', maxCount);
          updateField('packetLogMaxAgeHours', maxAgeHours);
          setInitialPacketMonitorSettings({ enabled, maxCount, maxAgeHours });

          // Load hide incomplete nodes setting
          updateField('hideIncompleteNodes', hideIncomplete);
          setShowIncompleteNodes(!hideIncomplete);

          // Load homoglyph optimization setting
          const homoglyphOn = settings.homoglyphEnabled === 'true';
          updateField('homoglyphEnabled', homoglyphOn);
          setInitialHomoglyphEnabled(homoglyphOn);

          // Load link preview setting (issue #3416). Absent key => enabled.
          const linkPreviewsOn = !(settings.linkPreviewsEnabled === '0' || settings.linkPreviewsEnabled === 'false');
          updateField('linkPreviewsEnabled', linkPreviewsOn);

          // Load discard-invalid-positions (default enabled). Absent key => enabled.
          const discardInvalidOn = !(settings.discardInvalidPositions === '0' || settings.discardInvalidPositions === 'false');
          updateField('discardInvalidPositions', discardInvalidOn);

          // Load no-index (#4202). Absent key => disabled.
          const noIndexOn = settings.noIndexEnabled === '1' || settings.noIndexEnabled === 'true';
          updateField('noIndexEnabled', noIndexOn);

          // Load MeshCore channel-send auto-retry (#3979). Absent key => disabled.
          const meshcoreChannelRetryOn = settings.meshcoreChannelRetryEnabled === '1' || settings.meshcoreChannelRetryEnabled === 'true';
          updateField('meshcoreChannelRetryEnabled', meshcoreChannelRetryOn);

          // Load LocalStats interval setting
          const statsInterval = parseInt(settings.localStatsIntervalMinutes || '15', 10);
          updateField('localStatsIntervalMinutes', statsInterval);
          setInitialLocalStatsIntervalMinutes(statsInterval);

          // Load MeshCore CLI console timeout (#4027). Absent/invalid => 15s default.
          const cliTimeoutParsed = parseInt(settings.meshcoreCliTimeoutSeconds || '15', 10);
          const cliTimeout = Number.isFinite(cliTimeoutParsed) ? Math.min(60, Math.max(1, cliTimeoutParsed)) : 15;
          updateField('meshcoreCliTimeoutSeconds', cliTimeout);
          setInitialMeshcoreCliTimeoutSeconds(cliTimeout);

          // Load node dimming initial values from server
          const dimmingEnabled = settings.nodeDimmingEnabled === '1' || settings.nodeDimmingEnabled === 'true';
          const dimmingStartHours = parseFloat(settings.nodeDimmingStartHours) || nodeDimmingStartHours;
          const dimmingMinOpacity = parseFloat(settings.nodeDimmingMinOpacity) || nodeDimmingMinOpacity;
          setInitialNodeDimmingSettings({
            enabled: dimmingEnabled,
            startHours: dimmingStartHours,
            minOpacity: dimmingMinOpacity,
          });

          // Load analytics settings
          if (settings.analyticsProvider) {
            updateField('analyticsProvider', settings.analyticsProvider);
            setInitialAnalyticsProvider(settings.analyticsProvider);
          }
          if (settings.analyticsConfig) {
            try {
              updateField('analyticsConfig', JSON.parse(settings.analyticsConfig));
              setInitialAnalyticsConfig(settings.analyticsConfig);
            } catch { /* ignore parse errors */ }
          }

          // Load Apprise API server URL (#3012)
          const appriseApiServerUrl = typeof settings.appriseApiServerUrl === 'string'
            ? settings.appriseApiServerUrl
            : '';
          updateField('appriseApiServerUrl', appriseApiServerUrl);
          setInitialAppriseApiServerUrl(appriseApiServerUrl);

          // Load Elevation/Terrain source settings (#4111 P3). Defaults to
          // enabled unless the server explicitly stored 'false' — mirrors
          // useElevationEnabled()'s semantics. Admins receive the unmasked
          // elevationSourceUrl value.
          const elevationEnabledOn = settings.elevationEnabled !== 'false';
          updateField('elevationEnabled', elevationEnabledOn);
          setInitialElevationEnabled(elevationEnabledOn);
          const elevationSourceUrl = typeof settings.elevationSourceUrl === 'string'
            ? settings.elevationSourceUrl
            : '';
          updateField('elevationSourceUrl', elevationSourceUrl);
          setInitialElevationSourceUrl(elevationSourceUrl);
        }
      } catch (error) {
        logger.error('Failed to fetch server settings:', error);
      }
    };
    void fetchServerSettings();
    // nodeDimmingStartHours/MinOpacity are only read as a one-time fallback default inside the
    // async callback (parseFloat(...) || nodeDimmingStartHours), matching pre-5.3 behavior; listing
    // them would re-run this mount-time fetch on every dimming edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, setShowIncompleteNodes, updateField]);

  // Baseline: a memoized snapshot of the current context/props/initial* values, in SettingsDraft
  // shape. Replaces the old ~35-dep "update local state when props change" effect body — this
  // still genuinely reads every upstream value (the dep array stays long), but it's now a plain
  // memo with no per-field enumeration anywhere else. Category-C fields read their `initial*`
  // snapshot (set by the fetch effect above) rather than a prop/context value.
  const baseline = useMemo<SettingsDraft>(() => {
    let parsedAnalyticsConfig: Record<string, string> = {};
    try {
      parsedAnalyticsConfig = JSON.parse(initialAnalyticsConfig);
    } catch {
      /* ignore parse errors */
    }
    return {
      maxNodeAgeHours,
      inactiveNodeThresholdHours,
      inactiveNodeCheckIntervalMinutes,
      inactiveNodeCooldownHours,
      temperatureUnit,
      distanceUnit,
      positionHistoryLineStyle,
      telemetryVisualizationHours,
      favoriteTelemetryStorageDays,
      preferredSortField,
      preferredSortDirection,
      timeFormat,
      dateFormat,
      mapTilesetLight,
      mapTilesetDark,
      mapPinStyle,
      iconStyle,
      neighborInfoMinZoom,
      defaultMapCenterLat,
      defaultMapCenterLon,
      defaultMapCenterZoom,
      mapCenterTargetZoom,
      defaultLandingPage,
      appearanceMode,
      darkTheme,
      lightTheme,
      nodeHopsCalculation,
      preferredDashboardSortOption,
      linkPreviewsEnabled,
      discardInvalidPositions,
      noIndexEnabled,
      meshcoreChannelRetryEnabled,
      // Note: hideIncompleteNodes in the draft is inverted from showIncompleteNodes because the UI
      // checkbox says "Hide" while the context uses "show" semantics. Do the inversion here so the
      // draft-vs-baseline diff stays a plain shallow-equal.
      hideIncompleteNodes: !showIncompleteNodes,
      solarMonitoringEnabled,
      solarMonitoringLatitude,
      solarMonitoringLongitude,
      solarMonitoringAzimuth,
      solarMonitoringDeclination,
      packetLogEnabled: initialPacketMonitorSettings.enabled,
      packetLogMaxCount: initialPacketMonitorSettings.maxCount,
      packetLogMaxAgeHours: initialPacketMonitorSettings.maxAgeHours,
      homoglyphEnabled: initialHomoglyphEnabled,
      localStatsIntervalMinutes: initialLocalStatsIntervalMinutes,
      meshcoreCliTimeoutSeconds: initialMeshcoreCliTimeoutSeconds,
      analyticsProvider: initialAnalyticsProvider,
      analyticsConfig: parsedAnalyticsConfig,
      appriseApiServerUrl: initialAppriseApiServerUrl,
      elevationEnabled: initialElevationEnabled,
      elevationSourceUrl: initialElevationSourceUrl,
    };
  }, [maxNodeAgeHours, inactiveNodeThresholdHours, inactiveNodeCheckIntervalMinutes, inactiveNodeCooldownHours,
      temperatureUnit, distanceUnit, positionHistoryLineStyle, telemetryVisualizationHours, favoriteTelemetryStorageDays,
      preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTilesetLight, mapTilesetDark, mapPinStyle,
      iconStyle, neighborInfoMinZoom, defaultMapCenterLat, defaultMapCenterLon, defaultMapCenterZoom, mapCenterTargetZoom,
      defaultLandingPage, appearanceMode, darkTheme, lightTheme, nodeHopsCalculation, preferredDashboardSortOption,
      linkPreviewsEnabled, discardInvalidPositions, noIndexEnabled, meshcoreChannelRetryEnabled, showIncompleteNodes,
      solarMonitoringEnabled, solarMonitoringLatitude, solarMonitoringLongitude, solarMonitoringAzimuth, solarMonitoringDeclination,
      initialPacketMonitorSettings, initialHomoglyphEnabled, initialLocalStatsIntervalMinutes, initialMeshcoreCliTimeoutSeconds,
      initialAnalyticsProvider, initialAnalyticsConfig, initialAppriseApiServerUrl, initialElevationEnabled, initialElevationSourceUrl]);

  // Re-seed the draft's category-A/B fields whenever the upstream props/context values change.
  // PINNED BEHAVIOR (do not add a dirty-guard here — that would be a behavior change, out of
  // scope for this refactor, see Task 5.3 spec §2.3): this unconditionally clobbers any
  // in-progress edit to these fields whenever upstream context/props change, exactly like the
  // props-effect it replaces (old L442–482).
  //
  // Deliberately scoped to category-A/B fields only (NOT the full `baseline`, which also folds
  // in category-C `initial*` snapshots): the original props-effect never depended on `initial*`
  // values — those are seeded independently, in isolation per-field, by the server-settings fetch
  // effect above via direct `updateField` calls. Tying this effect to the full baseline instead
  // would mean an unrelated category-C fetch resolving (e.g. the elevation settings load) blows
  // away every OTHER field's in-progress edit too, which is a strictly worse, newly-introduced
  // behavior the original two-separate-effects design never had (caught by
  // SettingsTab.elevation.test.tsx's Test-button suite).
  useEffect(() => {
    dispatch({
      type: 'field',
      patch: {
        maxNodeAgeHours,
        inactiveNodeThresholdHours,
        inactiveNodeCheckIntervalMinutes,
        inactiveNodeCooldownHours,
        temperatureUnit,
        distanceUnit,
        positionHistoryLineStyle,
        telemetryVisualizationHours,
        favoriteTelemetryStorageDays,
        preferredSortField,
        preferredSortDirection,
        timeFormat,
        dateFormat,
        mapTilesetLight,
        mapTilesetDark,
        mapPinStyle,
        iconStyle,
        neighborInfoMinZoom,
        defaultMapCenterLat,
        defaultMapCenterLon,
        defaultMapCenterZoom,
        mapCenterTargetZoom,
        defaultLandingPage,
        appearanceMode,
        darkTheme,
        lightTheme,
        nodeHopsCalculation,
        preferredDashboardSortOption,
        linkPreviewsEnabled,
        discardInvalidPositions,
        noIndexEnabled,
        meshcoreChannelRetryEnabled,
        hideIncompleteNodes: !showIncompleteNodes,
        solarMonitoringEnabled,
        solarMonitoringLatitude,
        solarMonitoringLongitude,
        solarMonitoringAzimuth,
        solarMonitoringDeclination,
      },
    });
  }, [maxNodeAgeHours, inactiveNodeThresholdHours, inactiveNodeCheckIntervalMinutes, inactiveNodeCooldownHours,
      temperatureUnit, distanceUnit, positionHistoryLineStyle, telemetryVisualizationHours, favoriteTelemetryStorageDays,
      preferredSortField, preferredSortDirection, timeFormat, dateFormat, mapTilesetLight, mapTilesetDark, mapPinStyle,
      iconStyle, neighborInfoMinZoom, defaultMapCenterLat, defaultMapCenterLon, defaultMapCenterZoom, mapCenterTargetZoom,
      defaultLandingPage, appearanceMode, darkTheme, lightTheme, nodeHopsCalculation, preferredDashboardSortOption,
      linkPreviewsEnabled, discardInvalidPositions, noIndexEnabled, meshcoreChannelRetryEnabled, showIncompleteNodes,
      solarMonitoringEnabled, solarMonitoringLatitude, solarMonitoringLongitude, solarMonitoringAzimuth, solarMonitoringDeclination]);

  // Default solar monitoring lat/long to device position if still at 0
  useEffect(() => {
    // Only set defaults if solar monitoring is enabled and values are at 0
    if (solarMonitoringLatitude === 0 && solarMonitoringLongitude === 0 && currentNodeId && nodes.length > 0) {
      const currentNode = nodes.find(n => n.user?.id === currentNodeId);
      if (currentNode?.position?.latitude != null && currentNode?.position?.longitude != null) {
        updateField('solarMonitoringLatitude', currentNode.position.latitude);
        updateField('solarMonitoringLongitude', currentNode.position.longitude);
      }
    }
  }, [currentNodeId, nodes, solarMonitoringLatitude, solarMonitoringLongitude, updateField]);

  // nodeDimming* isn't a draft field (its JSX binds straight to SettingsContext state — see
  // §1.2 of the Task 5.3 spec), so it needs its own small dirty-check folded into hasChanges.
  const nodeDimmingChanged = useMemo(() =>
    nodeDimmingEnabled !== initialNodeDimmingSettings.enabled ||
    nodeDimmingStartHours !== initialNodeDimmingSettings.startHours ||
    nodeDimmingMinOpacity !== initialNodeDimmingSettings.minOpacity,
  [nodeDimmingEnabled, nodeDimmingStartHours, nodeDimmingMinOpacity, initialNodeDimmingSettings]);

  // Derived dirty flag — replaces the old ~57-dep change-detection effect + its own `hasChanges`
  // useState. hasChanges is now purely a function of (draft, baseline, nodeDimmingChanged).
  const hasChanges = useMemo(() => !settingsDraftEqual(draft, baseline) || nodeDimmingChanged, [draft, baseline, nodeDimmingChanged]);

  // Reset local state to current saved values (for SaveBar dismiss). Replaces the old ~35-dep
  // resetChanges useCallback — re-seeding the draft from `baseline` covers every draft field in
  // one dispatch; nodeDimming* (not a draft field) still needs its own three setter calls.
  const resetChanges = useCallback(() => {
    dispatch({ type: 'reseed', next: baseline });
    setNodeDimmingEnabled(initialNodeDimmingSettings.enabled);
    setNodeDimmingStartHours(initialNodeDimmingSettings.startHours);
    setNodeDimmingMinOpacity(initialNodeDimmingSettings.minOpacity);
  }, [baseline, initialNodeDimmingSettings, setNodeDimmingEnabled, setNodeDimmingStartHours, setNodeDimmingMinOpacity]);

  // Category-A prop callbacks (from App.tsx) are latched through a ref kept fresh every render, so
  // `applyDraft` below stays referentially stable even if App.tsx doesn't memoize them. Category-B
  // setters (SettingsContext/UIContext) are already useCallback-stable since 5.1/5.2 and are listed
  // directly in applyDraft's own deps instead.
  const propCallbacksRef = useRef({
    onMaxNodeAgeChange, onInactiveNodeThresholdHoursChange, onInactiveNodeCheckIntervalMinutesChange,
    onInactiveNodeCooldownHoursChange, onTemperatureUnitChange, onDistanceUnitChange, onPositionHistoryLineStyleChange,
    onTelemetryVisualizationChange, onFavoriteTelemetryStorageDaysChange, onPreferredSortFieldChange,
    onPreferredSortDirectionChange, onTimeFormatChange, onDateFormatChange, onMapTilesetsChange, onMapPinStyleChange,
    onIconStyleChange, onSolarMonitoringEnabledChange, onSolarMonitoringLatitudeChange, onSolarMonitoringLongitudeChange,
    onSolarMonitoringAzimuthChange, onSolarMonitoringDeclinationChange,
  });
  propCallbacksRef.current = {
    onMaxNodeAgeChange, onInactiveNodeThresholdHoursChange, onInactiveNodeCheckIntervalMinutesChange,
    onInactiveNodeCooldownHoursChange, onTemperatureUnitChange, onDistanceUnitChange, onPositionHistoryLineStyleChange,
    onTelemetryVisualizationChange, onFavoriteTelemetryStorageDaysChange, onPreferredSortFieldChange,
    onPreferredSortDirectionChange, onTimeFormatChange, onDateFormatChange, onMapTilesetsChange, onMapPinStyleChange,
    onIconStyleChange, onSolarMonitoringEnabledChange, onSolarMonitoringLatitudeChange, onSolarMonitoringLongitudeChange,
    onSolarMonitoringAzimuthChange, onSolarMonitoringDeclinationChange,
  };

  // Collects every propagation call (onXxxChange prop callbacks + context setters + initial*
  // snapshot updates) into one stable callback — this is what lets handleSave reach
  // `[draft, applyDraft]` instead of ~90 changing values.
  const applyDraft = useCallback((d: SettingsDraft) => {
    const cb = propCallbacksRef.current;
    cb.onMaxNodeAgeChange(d.maxNodeAgeHours);
    cb.onInactiveNodeThresholdHoursChange(d.inactiveNodeThresholdHours);
    cb.onInactiveNodeCheckIntervalMinutesChange(d.inactiveNodeCheckIntervalMinutes);
    cb.onInactiveNodeCooldownHoursChange(d.inactiveNodeCooldownHours);
    cb.onTemperatureUnitChange(d.temperatureUnit);
    cb.onDistanceUnitChange(d.distanceUnit);
    cb.onPositionHistoryLineStyleChange(d.positionHistoryLineStyle);
    cb.onTelemetryVisualizationChange(d.telemetryVisualizationHours);
    cb.onFavoriteTelemetryStorageDaysChange(d.favoriteTelemetryStorageDays);
    cb.onPreferredSortFieldChange(d.preferredSortField);
    cb.onPreferredSortDirectionChange(d.preferredSortDirection);
    cb.onTimeFormatChange(d.timeFormat);
    cb.onDateFormatChange(d.dateFormat);
    cb.onMapTilesetsChange(d.mapTilesetLight, d.mapTilesetDark);
    cb.onMapPinStyleChange(d.mapPinStyle);
    cb.onIconStyleChange(d.iconStyle);
    cb.onSolarMonitoringEnabledChange(d.solarMonitoringEnabled);
    cb.onSolarMonitoringLatitudeChange(d.solarMonitoringLatitude);
    cb.onSolarMonitoringLongitudeChange(d.solarMonitoringLongitude);
    cb.onSolarMonitoringAzimuthChange(d.solarMonitoringAzimuth);
    cb.onSolarMonitoringDeclinationChange(d.solarMonitoringDeclination);

    setNeighborInfoMinZoom(d.neighborInfoMinZoom);
    setDefaultMapCenterLat(d.defaultMapCenterLat);
    setDefaultMapCenterLon(d.defaultMapCenterLon);
    setDefaultMapCenterZoom(d.defaultMapCenterZoom);
    setMapCenterTargetZoom(d.mapCenterTargetZoom);
    setDefaultLandingPage(d.defaultLandingPage);
    setAppearanceMode(d.appearanceMode);
    setDarkTheme(d.darkTheme);
    setLightTheme(d.lightTheme);
    setNodeHopsCalculation(d.nodeHopsCalculation);
    setPreferredDashboardSortOption(d.preferredDashboardSortOption);
    setLinkPreviewsEnabled(d.linkPreviewsEnabled);
    setDiscardInvalidPositions(d.discardInvalidPositions);
    setNoIndexEnabled(d.noIndexEnabled);
    setMeshcoreChannelRetryEnabled(d.meshcoreChannelRetryEnabled);
    setShowIncompleteNodes(!d.hideIncompleteNodes);

    // Update initial* snapshots for category-C fields after successful save
    setInitialPacketMonitorSettings({ enabled: d.packetLogEnabled, maxCount: d.packetLogMaxCount, maxAgeHours: d.packetLogMaxAgeHours });
    setInitialHomoglyphEnabled(d.homoglyphEnabled);
    setInitialLocalStatsIntervalMinutes(d.localStatsIntervalMinutes);
    setInitialMeshcoreCliTimeoutSeconds(d.meshcoreCliTimeoutSeconds);
    setInitialAnalyticsProvider(d.analyticsProvider);
    setInitialAnalyticsConfig(JSON.stringify(d.analyticsConfig));
    setInitialAppriseApiServerUrl(d.appriseApiServerUrl.trim());
    setInitialElevationEnabled(d.elevationEnabled);
    setInitialElevationSourceUrl(d.elevationSourceUrl.trim());
  }, [setNeighborInfoMinZoom, setDefaultMapCenterLat, setDefaultMapCenterLon, setDefaultMapCenterZoom,
      setMapCenterTargetZoom, setDefaultLandingPage, setAppearanceMode, setDarkTheme, setLightTheme,
      setNodeHopsCalculation, setPreferredDashboardSortOption, setLinkPreviewsEnabled, setDiscardInvalidPositions,
      setNoIndexEnabled, setMeshcoreChannelRetryEnabled, setShowIncompleteNodes]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const systemIsDark = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : true;
      const effectiveTheme = computeEffectiveTheme(draft.appearanceMode, draft.darkTheme, draft.lightTheme);
      const effectiveTileset = getEffectiveTileset(draft.appearanceMode, draft.mapTilesetDark, draft.mapTilesetLight, systemIsDark);
      const settings = {
        maxNodeAgeHours: draft.maxNodeAgeHours,
        inactiveNodeThresholdHours: draft.inactiveNodeThresholdHours,
        inactiveNodeCheckIntervalMinutes: draft.inactiveNodeCheckIntervalMinutes,
        inactiveNodeCooldownHours: draft.inactiveNodeCooldownHours,
        temperatureUnit: draft.temperatureUnit,
        distanceUnit: draft.distanceUnit,
        positionHistoryLineStyle: draft.positionHistoryLineStyle,
        telemetryVisualizationHours: draft.telemetryVisualizationHours,
        favoriteTelemetryStorageDays: draft.favoriteTelemetryStorageDays,
        preferredSortField: draft.preferredSortField,
        preferredSortDirection: draft.preferredSortDirection,
        timeFormat: draft.timeFormat,
        dateFormat: draft.dateFormat,
        mapTileset: effectiveTileset,
        mapTilesetLight: draft.mapTilesetLight,
        mapTilesetDark: draft.mapTilesetDark,
        mapPinStyle: draft.mapPinStyle,
        iconStyle: draft.iconStyle,
        neighborInfoMinZoom: draft.neighborInfoMinZoom.toString(),
        defaultMapCenterLat: draft.defaultMapCenterLat !== null ? draft.defaultMapCenterLat.toString() : '',
        defaultMapCenterLon: draft.defaultMapCenterLon !== null ? draft.defaultMapCenterLon.toString() : '',
        defaultMapCenterZoom: draft.defaultMapCenterZoom !== null ? draft.defaultMapCenterZoom.toString() : '',
        mapCenterTargetZoom: draft.mapCenterTargetZoom.toString(),
        defaultLandingPage: draft.defaultLandingPage,
        theme: effectiveTheme,
        appearanceMode: draft.appearanceMode,
        darkTheme: draft.darkTheme,
        lightTheme: draft.lightTheme,
        packet_log_enabled: draft.packetLogEnabled ? '1' : '0',
        packet_log_max_count: draft.packetLogMaxCount.toString(),
        packet_log_max_age_hours: draft.packetLogMaxAgeHours.toString(),
        solarMonitoringEnabled: draft.solarMonitoringEnabled ? '1' : '0',
        solarMonitoringLatitude: draft.solarMonitoringLatitude.toString(),
        solarMonitoringLongitude: draft.solarMonitoringLongitude.toString(),
        solarMonitoringAzimuth: draft.solarMonitoringAzimuth.toString(),
        solarMonitoringDeclination: draft.solarMonitoringDeclination.toString(),
        linkPreviewsEnabled: draft.linkPreviewsEnabled ? '1' : '0',
        discardInvalidPositions: draft.discardInvalidPositions ? '1' : '0',
        noIndexEnabled: draft.noIndexEnabled ? '1' : '0',
        meshcoreChannelRetryEnabled: draft.meshcoreChannelRetryEnabled ? '1' : '0',
        hideIncompleteNodes: draft.hideIncompleteNodes ? '1' : '0',
        homoglyphEnabled: String(draft.homoglyphEnabled),
        localStatsIntervalMinutes: draft.localStatsIntervalMinutes.toString(),
        meshcoreCliTimeoutSeconds: draft.meshcoreCliTimeoutSeconds.toString(),
        nodeHopsCalculation: draft.nodeHopsCalculation,
        nodeDimmingEnabled: nodeDimmingEnabled ? '1' : '0',
        nodeDimmingStartHours: nodeDimmingStartHours.toString(),
        nodeDimmingMinOpacity: nodeDimmingMinOpacity.toString(),
        analyticsProvider: draft.analyticsProvider,
        analyticsConfig: JSON.stringify(draft.analyticsConfig),
        appriseApiServerUrl: draft.appriseApiServerUrl.trim(),
        elevationEnabled: draft.elevationEnabled ? 'true' : 'false',
        elevationSourceUrl: draft.elevationSourceUrl.trim(),
      };

      // Save to server
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      // Fan out to parent/context state and update category-C snapshots
      applyDraft(draft);
      setInitialNodeDimmingSettings({
        enabled: nodeDimmingEnabled,
        startHours: nodeDimmingStartHours,
        minOpacity: nodeDimmingMinOpacity,
      });

      showToast(t('settings.saved_success'), 'success');
    } catch (error) {
      logger.error('Error saving settings:', error);
      showToast(t('settings.save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [draft, applyDraft, nodeDimmingEnabled, nodeDimmingStartHours, nodeDimmingMinOpacity, csrfFetch, baseUrl, showToast, t]);

  // Register with SaveBar
  useSaveBar({
    id: 'settings',
    sectionName: t('settings.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  const handleTestAppriseConnection = useCallback(async () => {
    setIsTestingApprise(true);
    setAppriseTestResult(null);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/test-apprise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: draft.appriseApiServerUrl.trim() || undefined }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        setAppriseTestResult({
          ok: false,
          message: errBody.error || `HTTP ${response.status}`,
        });
        return;
      }

      const data: { ok: boolean; status?: number; error?: string; latencyMs?: number } = await response.json();
      if (data.ok) {
        setAppriseTestResult({
          ok: true,
          message: t('settings.apprise_server_test_success', 'Connected successfully ({{latency}}ms)', { latency: data.latencyMs ?? 0 }),
        });
      } else {
        setAppriseTestResult({
          ok: false,
          message: t('settings.apprise_server_test_failure', 'Connection failed: {{error}}', { error: data.error || 'Unknown error' }),
        });
      }
    } catch (error) {
      logger.error('Failed to test Apprise connection:', error);
      setAppriseTestResult({
        ok: false,
        message: t('settings.apprise_server_test_failure', 'Connection failed: {{error}}', { error: error instanceof Error ? error.message : String(error) }),
      });
    } finally {
      setIsTestingApprise(false);
    }
  }, [csrfFetch, baseUrl, draft.appriseApiServerUrl, t]);

  // Probes the (unsaved) elevation source URL via ApiService.testElevationSource
  // (#4111 P3 WP-3) — a raw fetch is banned in components per CLAUDE.md, and
  // this exercises the POST /api/elevation/test route added in Phase 1.
  //
  // An empty/whitespace field means "use the default public Terrarium
  // source" (per the field's own helper text), so Test must probe that
  // default rather than send an empty `url` — the route 400s on that with a
  // raw "Request body must include a url" message that leaked into the UI
  // (browser-validation follow-up to #4111 P3 WP-3).
  const handleTestElevation = useCallback(async () => {
    setElevationTesting(true);
    setElevationTestResult(null);
    const trimmedUrl = draft.elevationSourceUrl.trim();
    const usedDefault = trimmedUrl.length === 0;
    const effectiveUrl = usedDefault ? DEFAULT_TERRARIUM_URL : trimmedUrl;
    try {
      const result = await apiService.testElevationSource(effectiveUrl);
      setElevationTestResult(
        result.success
          ? {
              ok: true,
              message:
                t(
                  'settings.elevation_test_success',
                  'OK — {{type}}, {{elev}} m in {{ms}} ms',
                  {
                    type: result.detectedType,
                    elev: result.sampleElevation ?? 'n/a',
                    ms: result.latencyMs,
                  }
                ) + (usedDefault ? ` ${t('settings.elevation_test_default_source_suffix', '(default source)')}` : ''),
            }
          : { ok: false, message: result.error ?? t('settings.elevation_test_failure_generic', 'Test failed') }
      );
    } catch (error) {
      logger.error('Failed to test elevation source:', error);
      setElevationTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setElevationTesting(false);
    }
  }, [draft.elevationSourceUrl, t]);

  const handleFetchSolarEstimates = async () => {
    setIsFetchingSolarEstimates(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/solar/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to trigger solar estimate fetch');
      }

      showToast(t('settings.solar_fetch_success'), 'success');
    } catch (error) {
      logger.error('Error triggering solar estimate fetch:', error);
      showToast(t('settings.solar_fetch_failed'), 'error');
    } finally {
      setIsFetchingSolarEstimates(false);
    }
  };

  const handleReset = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_reset_title') + '\n\n' +
      t('settings.confirm_reset_defaults') + '\n' +
      '• ' + t('settings.confirm_reset_max_age') + '\n' +
      '• ' + t('settings.confirm_reset_temp') + '\n' +
      '• ' + t('settings.confirm_reset_dist') + '\n' +
      '• ' + t('settings.confirm_reset_telemetry') + '\n' +
      '• ' + t('settings.confirm_reset_sort') + '\n' +
      '• ' + t('settings.confirm_reset_time') + '\n' +
      '• ' + t('settings.confirm_reset_date') + '\n' +
      '• ' + t('settings.confirm_reset_tileset') + '\n' +
      '• ' + t('settings.confirm_reset_pins') + '\n' +
      '• ' + t('settings.confirm_reset_packet') + '\n' +
      '• ' + t('settings.confirm_reset_max_packets') + '\n' +
      '• ' + t('settings.confirm_reset_packet_age') + '\n\n' +
      t('settings.confirm_reset_affects')
    );

    if (!confirmed) return;

    setIsSaving(true);
    try {
      await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'DELETE'
      });

      // Set draft state to defaults
      updateField('maxNodeAgeHours', 24);
      updateField('temperatureUnit', 'C');
      updateField('distanceUnit', 'km');
      updateField('positionHistoryLineStyle', 'spline');
      updateField('telemetryVisualizationHours', 24);
      updateField('favoriteTelemetryStorageDays', 7);
      updateField('preferredSortField', 'longName');
      updateField('preferredSortDirection', 'asc');
      updateField('timeFormat', '24');
      updateField('dateFormat', 'MM/DD/YYYY');
      updateField('mapTilesetLight', 'osm');
      updateField('mapTilesetDark', 'cartoDark');
      updateField('mapPinStyle', 'meshmonitor');
      updateField('appearanceMode', 'system');
      updateField('darkTheme', 'mocha');
      updateField('lightTheme', 'latte');
      updateField('nodeHopsCalculation', 'nodeinfo');
      updateField('preferredDashboardSortOption', 'custom');
      updateField('packetLogEnabled', false);
      updateField('packetLogMaxCount', 1000);
      updateField('packetLogMaxAgeHours', 24);
      updateField('solarMonitoringEnabled', false);
      updateField('solarMonitoringLatitude', 0);
      updateField('solarMonitoringLongitude', 0);
      updateField('solarMonitoringAzimuth', 0);
      updateField('solarMonitoringDeclination', 30);
      updateField('linkPreviewsEnabled', true);
      updateField('discardInvalidPositions', true);
      updateField('meshcoreChannelRetryEnabled', false);

      // Update parent component with defaults
      onMaxNodeAgeChange(24);
      onTemperatureUnitChange('C');
      onDistanceUnitChange('km');
      onPositionHistoryLineStyleChange('spline');
      onTelemetryVisualizationChange(24);
      onFavoriteTelemetryStorageDaysChange(7);
      onPreferredSortFieldChange('longName');
      onPreferredSortDirectionChange('asc');
      onTimeFormatChange('24');
      onDateFormatChange('MM/DD/YYYY');
      onMapTilesetsChange('osm', 'cartoDark');
      onMapPinStyleChange('meshmonitor');
      setAppearanceMode('system');
      setDarkTheme('mocha');
      setLightTheme('latte');
      setNodeHopsCalculation('nodeinfo');
      setPreferredDashboardSortOption('custom');
      onSolarMonitoringEnabledChange(false);
      onSolarMonitoringLatitudeChange(0);
      onSolarMonitoringLongitudeChange(0);
      onSolarMonitoringAzimuthChange(0);
      onSolarMonitoringDeclinationChange(30);
      setLinkPreviewsEnabled(true);
      setDiscardInvalidPositions(true);
      setMeshcoreChannelRetryEnabled(false);

      // Update initial packet monitor settings
      setInitialPacketMonitorSettings({ enabled: false, maxCount: 1000, maxAgeHours: 24 });

      showToast(t('settings.reset_success'), 'success');
    } catch (error) {
      logger.error('Error resetting settings:', error);
      showToast(t('settings.reset_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  };
  const handlePurgeNodes = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_nodes_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_nodes_item1') + '\n' +
      '• ' + t('settings.confirm_purge_nodes_item2') + '\n' +
      '• ' + t('settings.confirm_purge_nodes_item3') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeNodes(0);
      showToast(t('toast.nodes_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging nodes:', error);
      showToast(t('toast.node_purge_failed'), 'error');
    }
  };

  const handlePurgeTelemetry = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_telemetry_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item1') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item2') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item3') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item4') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTelemetry(0);
      showToast(t('toast.telemetry_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging telemetry:', error);
      showToast(t('toast.telemetry_purge_failed'), 'error');
    }
  };

  const handlePurgeMessages = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_messages_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_messages_item1') + '\n' +
      '• ' + t('settings.confirm_purge_messages_item2') + '\n' +
      '• ' + t('settings.confirm_purge_messages_item3') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeMessages(0);
      showToast(t('messages.purged_success'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging messages:', error);
      showToast(t('messages.error_purging'), 'error');
    }
  };

  const handlePurgeTraceroutes = async () => {
    const confirmed = window.confirm(
      t('settings.confirm_purge_traceroutes_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item1') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item2') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item3') + '\n' +
      '• ' + t('settings.confirm_purge_traceroutes_item4') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTraceroutes();
      showToast(t('toast.traceroutes_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging traceroutes:', error);
      showToast(t('toast.traceroutes_purge_failed'), 'error');
    }
  };

  const handleRestartContainer = async () => {
    const action = isDocker ? t('settings.restart_action') : t('settings.shutdown_action');
    const confirmed = window.confirm(
      t('settings.confirm_restart_title', { action }) + '\n\n' +
      (isDocker
        ? t('settings.confirm_restart_docker')
        : t('settings.confirm_restart_manual'))
    );

    if (!confirmed) return;

    setIsRestarting(true);
    try {
      const result = await apiService.restartContainer();
      showToast(result.message, 'success');

      if (isDocker) {
        // Wait a few seconds, then reload the page
        setTimeout(() => {
          window.location.reload();
        }, 5000);
      }
    } catch (error) {
      logger.error(`Error ${action}ing:`, error);
      showToast(t('settings.restart_failed', { action }), 'error');
      setIsRestarting(false);
    }
  };

  const renderThemeOptions = () => (
    <>
      <optgroup label={t('settings.theme_catppuccin')}>
        <option value="mocha">{t('settings.theme_mocha')}</option>
        <option value="macchiato">{t('settings.theme_macchiato')}</option>
        <option value="frappe">{t('settings.theme_frappe')}</option>
        <option value="latte">{t('settings.theme_latte')}</option>
      </optgroup>
      <optgroup label={t('settings.theme_popular')}>
        <option value="nord">{t('settings.theme_nord')}</option>
        <option value="dracula">{t('settings.theme_dracula')}</option>
        <option value="solarized-dark">{t('settings.theme_solarized_dark')}</option>
        <option value="solarized-light">{t('settings.theme_solarized_light')}</option>
        <option value="gruvbox-dark">{t('settings.theme_gruvbox_dark')}</option>
        <option value="gruvbox-light">{t('settings.theme_gruvbox_light')}</option>
      </optgroup>
      <optgroup label={t('settings.theme_high_contrast')}>
        <option value="high-contrast-dark">{t('settings.theme_hc_dark')}</option>
        <option value="high-contrast-light">{t('settings.theme_hc_light')}</option>
      </optgroup>
      <optgroup label={t('settings.theme_colorblind')}>
        <option value="protanopia">{t('settings.theme_protanopia')}</option>
        <option value="deuteranopia">{t('settings.theme_deuteranopia')}</option>
        <option value="tritanopia">{t('settings.theme_tritanopia')}</option>
      </optgroup>
      {customThemes.length > 0 && (
        <optgroup label={t('settings.theme_custom')}>
          {customThemes.map((customTheme) => (
            <option key={customTheme.id} value={customTheme.slug}>
              {customTheme.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <div className="tab-content">
      <div className="settings-header-card">
        <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="settings-logo" />
        <div className="settings-title-section">
          <h1 className="settings-app-name">MeshMonitor</h1>
          <p className="settings-version">Version {version}</p>
        </div>
        <a
          href="https://meshmonitor.org/features/settings"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginLeft: 'auto',
            padding: '0.5rem',
            fontSize: '1.5rem',
            color: '#89b4fa',
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
          title={t('settings.view_docs')}
        >
          <UiIcon name="help" />
        </a>
        <a
          href="https://ko-fi.com/yeraze"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginLeft: '0.5rem',
            padding: '0.5rem 1rem',
            fontSize: '1rem',
            color: '#ffffff',
            backgroundColor: '#89b4fa',
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            borderRadius: '6px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
            border: 'none',
            cursor: 'pointer'
          }}
          title={t('settings.support')}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#74a0e0'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#89b4fa'}
        >
          <UiIcon name="heart" /> {t('settings.support')}</a>
      </div>
      <SectionNav items={[
        { id: 'settings-language', label: t('settings.language') },
        { id: 'settings-units', label: t('settings.units_and_formats') },
        { id: 'settings-sorting', label: t('settings.sorting') },
        { id: 'settings-appearance', label: t('settings.appearance') },
        { id: 'settings-link-previews', label: t('settings.link_previews', 'Link Previews') },
        { id: 'settings-privacy', label: t('settings.privacy', 'Privacy') },
        { id: 'settings-meshcore-messaging', label: t('settings.meshcore_messaging', 'MeshCore Messaging') },
        { id: 'settings-map', label: t('settings.map') },
        { id: 'settings-node-display', label: t('settings.node_display') },
        { id: 'settings-telemetry', label: t('settings.telemetry') },
        { id: 'settings-notifications', label: t('settings.notifications_and_security') },
        { id: 'settings-security', label: t('settings.security', 'Security') },
        { id: 'settings-packet-monitor', label: t('settings.packet_monitor') },
        { id: 'settings-solar', label: t('settings.solar_monitoring') },
        ...(isAdmin ? [{ id: 'settings-apprise-server', label: t('settings.apprise_server_section', 'Apprise API Server') }] : []),
        ...(isAdmin ? [{ id: 'settings-elevation', label: t('settings.elevation_section', 'Elevation / Terrain') }] : []),
        { id: 'settings-backup', label: t('settings.system_backup', 'System Backup') },
        ...(isAdmin ? [{ id: 'settings-channel-database', label: t('channel_database.title', 'Channel Database') }] : []),
        // Only show Database Maintenance for SQLite - it uses SQLite-specific features like VACUUM
        ...(databaseType === 'sqlite' ? [{ id: 'settings-maintenance', label: t('maintenance.title', 'Database Maintenance') }] : []),
        ...(isAdmin && firmwareOtaEnabled ? [{ id: 'settings-firmware', label: t('firmware.title', 'Firmware Updates') }] : []),
        { id: 'settings-reset-ui', label: t('settings.reset_ui_positions') },
        ...(isAdmin ? [{ id: 'settings-analytics', label: t('settings.analytics') }] : []),
        ...(canWriteSettings ? [{ id: 'settings-position-estimation', label: t('automation.position_estimation.title', 'Position Estimation') }] : []),
        { id: 'settings-management', label: t('settings.settings_management') },
        { id: 'settings-danger', label: t('settings.danger_zone') },
      ].filter(item => show(item.id))} />
      <div className="settings-content settings-multi-column">
        {show('settings-language') && <div id="settings-language" className="settings-section">
          <h3>{t('settings.language')}</h3>
          <div className="setting-item">
            <label htmlFor="language">
              {t('settings.languageDescription')}
            </label>
            <LanguageSelector
              value={language}
              onChange={onLanguageChange}
            />
          </div>
          <p className="setting-description" style={{ marginTop: '0.5rem' }}>
            {t('settings.language_contribute')}{' '}
            <a
              href="https://hosted.weblate.org/projects/meshmonitor/meshmonitor/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent-color)' }}
            >
              Weblate
            </a>
          </p>
        </div>}

        {show('settings-units') && <div id="settings-units" className="settings-section">
          <h3>{t('settings.units_and_formats')}</h3>
          <div className="setting-item">
            <label htmlFor="timeFormat">
              {t('settings.time_format_label')}
              <span className="setting-description">{t('settings.time_format_description')}</span>
            </label>
            <select
              id="timeFormat"
              value={draft.timeFormat}
              onChange={(e) => updateField('timeFormat', e.target.value as TimeFormat)}
              className="setting-input"
            >
              <option value="12">{t('settings.time_12_hour')}</option>
              <option value="24">{t('settings.time_24_hour')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="dateFormat">
              {t('settings.date_format_label')}
              <span className="setting-description">{t('settings.date_format_description')}</span>
            </label>
            <select
              id="dateFormat"
              value={draft.dateFormat}
              onChange={(e) => updateField('dateFormat', e.target.value as DateFormat)}
              className="setting-input"
            >
              <option value="MM/DD/YYYY">{t('settings.date_mdy')}</option>
              <option value="DD/MM/YYYY">{t('settings.date_dmy')}</option>
              <option value="YYYY-MM-DD">{t('settings.date_iso')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="temperatureUnit">
              {t('settings.temp_unit_label')}
              <span className="setting-description">{t('settings.temp_unit_description')}</span>
            </label>
            <select
              id="temperatureUnit"
              value={draft.temperatureUnit}
              onChange={(e) => updateField('temperatureUnit', e.target.value as TemperatureUnit)}
              className="setting-input"
            >
              <option value="C">{t('settings.temp_celsius')}</option>
              <option value="F">{t('settings.temp_fahrenheit')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="distanceUnit">
              {t('settings.dist_unit_label')}
              <span className="setting-description">{t('settings.dist_unit_description')}</span>
            </label>
            <select
              id="distanceUnit"
              value={draft.distanceUnit}
              onChange={(e) => updateField('distanceUnit', e.target.value as DistanceUnit)}
              className="setting-input"
            >
              <option value="km">{t('settings.dist_km')}</option>
              <option value="mi">{t('settings.dist_mi')}</option>
            </select>
          </div>
        </div>}

        {show('settings-sorting') && <div id="settings-sorting" className="settings-section">
          <h3>{t('settings.sorting')}</h3>
          <div className="setting-item">
            <label htmlFor="preferredSortField">
              {t('settings.sort_field_label')}
              <span className="setting-description">{t('settings.sort_field_description')}</span>
            </label>
            <select
              id="preferredSortField"
              value={draft.preferredSortField}
              onChange={(e) => updateField('preferredSortField', e.target.value as SortField)}
              className="setting-input"
            >
              <option value="longName">{t('settings.sort_long_name')}</option>
              <option value="shortName">{t('settings.sort_short_name')}</option>
              <option value="id">{t('settings.sort_id')}</option>
              <option value="lastHeard">{t('settings.sort_last_heard')}</option>
              <option value="snr">{t('settings.sort_snr')}</option>
              <option value="battery">{t('settings.sort_battery')}</option>
              <option value="hwModel">{t('settings.sort_hw_model')}</option>
              <option value="hops">{t('settings.sort_hops')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="preferredSortDirection">
              {t('settings.sort_direction_label')}
              <span className="setting-description">{t('settings.sort_direction_description')}</span>
            </label>
            <select
              id="preferredSortDirection"
              value={draft.preferredSortDirection}
              onChange={(e) => updateField('preferredSortDirection', e.target.value as SortDirection)}
              className="setting-input"
            >
              <option value="asc">{t('settings.sort_ascending')}</option>
              <option value="desc">{t('settings.sort_descending')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="dashboardSortOption">
              {t('settings.dashboard_sort_label')}
              <span className="setting-description">{t('settings.dashboard_sort_description')}</span>
            </label>
            <select
              id="dashboardSortOption"
              value={draft.preferredDashboardSortOption}
              onChange={(e) => updateField('preferredDashboardSortOption', e.target.value as DashboardSortOption)}
              className="setting-input"
            >
              <option value="custom">{t('settings.dashboard_sort_custom')}</option>
              <option value="node-asc">{t('settings.dashboard_sort_node_asc')}</option>
              <option value="node-desc">{t('settings.dashboard_sort_node_desc')}</option>
              <option value="type-asc">{t('settings.dashboard_sort_type_asc')}</option>
              <option value="type-desc">{t('settings.dashboard_sort_type_desc')}</option>
            </select>
          </div>
        </div>}

        {show('settings-appearance') && <div id="settings-appearance" className="settings-section">
          <h3>{t('settings.appearance')}</h3>
          <div className="setting-item">
            <label htmlFor="appearanceMode">
              {t('settings.appearance_mode_label')}
              <span className="setting-description">{t('settings.appearance_mode_description')}</span>
            </label>
            <select
              id="appearanceMode"
              value={draft.appearanceMode}
              onChange={(e) => updateField('appearanceMode', e.target.value as AppearanceMode)}
              className="setting-input"
            >
              <option value="system">{t('settings.appearance_mode_system')}</option>
              <option value="dark">{t('settings.appearance_mode_dark')}</option>
              <option value="light">{t('settings.appearance_mode_light')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="darkTheme">
              {t('settings.dark_theme_label')}
              <span className="setting-description">{t('settings.dark_theme_description')}</span>
            </label>
            <select
              id="darkTheme"
              value={draft.darkTheme}
              onChange={(e) => updateField('darkTheme', e.target.value as Theme)}
              className="setting-input"
            >
              {renderThemeOptions()}
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="lightTheme">
              {t('settings.light_theme_label')}
              <span className="setting-description">{t('settings.light_theme_description')}</span>
            </label>
            <select
              id="lightTheme"
              value={draft.lightTheme}
              onChange={(e) => updateField('lightTheme', e.target.value as Theme)}
              className="setting-input"
            >
              {renderThemeOptions()}
            </select>
          </div>
          <CustomThemeManagement />
          <div className="setting-item">
            <label htmlFor="mapPinStyle">
              {t('settings.map_pin_label')}
              <span className="setting-description">{t('settings.map_pin_description')}</span>
            </label>
            <select
              id="mapPinStyle"
              value={draft.mapPinStyle}
              onChange={(e) => updateField('mapPinStyle', e.target.value as MapPinStyle)}
              className="setting-input"
            >
              <option value="meshmonitor">{t('settings.map_pin_meshmonitor')}</option>
              <option value="official">{t('settings.map_pin_official')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="iconStyle">
              {t('settings.icon_style_label', 'Icon Style')}
              <span className="setting-description">{t('settings.icon_style_description', 'Choose between modern Lucide icons or classic emoji icons throughout the interface.')}</span>
            </label>
            <select
              id="iconStyle"
              value={draft.iconStyle}
              onChange={(e) => updateField('iconStyle', e.target.value as IconStyle)}
              className="setting-input"
            >
              <option value="lucide">{t('settings.icon_style_lucide', 'Lucide (Modern)')}</option>
              <option value="emoji">{t('settings.icon_style_emoji', 'Emoji (Classic)')}</option>
            </select>
          </div>
          <TapbackEmojiSettings />
          {isAdmin && (
            <div className="setting-item">
              <label htmlFor="defaultLandingPage">
                {t('settings.default_landing_page_label', 'Default Landing Page')}
                <span className="setting-description">
                  {t('settings.default_landing_page_description', 'Page shown to users at the root URL. The Sources button always returns to the Unified view.')}
                </span>
              </label>
              <select
                id="defaultLandingPage"
                value={draft.defaultLandingPage}
                onChange={(e) => updateField('defaultLandingPage', e.target.value)}
                className="setting-input"
              >
                <option value="unified">
                  {t('settings.default_landing_page_unified', 'Unified View (default)')}
                </option>
                <option value="unified-messages">
                  {t('settings.default_landing_page_unified_messages', 'Unified Messages')}
                </option>
                <option value="unified-telemetry">
                  {t('settings.default_landing_page_unified_telemetry', 'Unified Telemetry')}
                </option>
                <option value="map-analysis">
                  {t('settings.default_landing_page_map_analysis', 'Map Analysis')}
                </option>
                <option value="reports">
                  {t('settings.default_landing_page_reports', 'Reports')}
                </option>
                {availableSources.map((src) => (
                  <option key={src.id} value={src.id}>
                    {src.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>}

        {show('settings-link-previews') && <div id="settings-link-previews" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.linkPreviewsEnabled}
                onChange={(e) => updateField('linkPreviewsEnabled', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.link_previews_enabled', 'Show link previews')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.link_previews_description', 'When enabled, MeshMonitor fetches and displays a preview card (title, description, image) for the first URL in a message. The fetch is performed server-side. Disable this to stop all outbound requests to link targets — URLs still render as clickable text.')}
          </p>
        </div>}

        {show('settings-privacy') && <div id="settings-privacy" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.noIndexEnabled}
                onChange={(e) => updateField('noIndexEnabled', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.no_index_enabled', 'Discourage search engine & LLM indexing')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.no_index_description', 'When enabled, MeshMonitor adds an "X-Robots-Tag: noindex, nofollow" header to every response and serves a disallow-all /robots.txt, asking search engines and LLM crawlers not to index this dashboard. Both are advisory — a crawler must choose to honor them. The robots.txt body is served in addition to the header because some reverse proxies (e.g. Cloudflare tunnels) strip custom headers at the edge.')}
          </p>
        </div>}

        {show('settings-meshcore-messaging') && <div id="settings-meshcore-messaging" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.meshcoreChannelRetryEnabled}
                onChange={(e) => updateField('meshcoreChannelRetryEnabled', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.meshcore_channel_retry_enabled', 'Auto-retry automated MeshCore channel sends')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.meshcore_channel_retry_description', 'When enabled, an AUTOMATED MeshCore channel/broadcast message (Automation Engine, Auto-Acknowledge, auto-responder, auto-announce and timer triggers) that hears no repeaters within 30 seconds is resent exactly once. User-initiated sends are never retried. This is opt-in, channel-only, and one-shot — distinct from the always-on retry for direct messages. You may occasionally see a duplicate on the mesh.')}
          </p>
          <div className="setting-item">
            <label htmlFor="meshcoreCliTimeoutSeconds">
              {t('settings.meshcore_cli_timeout_label', 'Remote CLI reply timeout (seconds)')}
              <span className="setting-description">
                {t('settings.meshcore_cli_timeout_description', 'How long the MeshCore CLI console (repeater/room-server remote admin and the local device console) waits for a reply before giving up, so you can re-fire a command. Lower it when your repeater is in direct range to avoid waiting the full default. Range 1–60s; default 15s.')}
              </span>
            </label>
            <input
              id="meshcoreCliTimeoutSeconds"
              type="number"
              min="1"
              max="60"
              value={draft.meshcoreCliTimeoutSeconds}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                updateField('meshcoreCliTimeoutSeconds', Number.isNaN(n) ? 15 : Math.min(60, Math.max(1, n)));
              }}
              className="setting-input"
            />
          </div>
        </div>}

        {show('settings-map') && <div id="settings-map" className="settings-section">
          <h3>{t('settings.map')}</h3>
          <div className="setting-item">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.discardInvalidPositions}
                onChange={(e) => updateField('discardInvalidPositions', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.discard_invalid_positions', 'Discard invalid positions')}</span>
            </label>
            <span className="setting-description">
              {t('settings.discard_invalid_positions_description', 'When enabled (default), GPS fixes at Null Island (0,0) — including precision-obscured ones — are discarded on ingest across all sources. Disable to store (0,0) reports as received so you can see which nodes transmit them. Out-of-range / garbage coordinates are always discarded.')}
            </span>
          </div>
          <div className="setting-item">
            <label htmlFor="mapTilesetLight">
              {t('settings.map_tileset_light_label', 'Light Mode Tileset')}
              <span className="setting-description">{t('settings.map_tileset_light_description', 'Map style used when the light appearance is active')}</span>
            </label>
            <select
              id="mapTilesetLight"
              value={draft.mapTilesetLight}
              onChange={(e) => updateField('mapTilesetLight', e.target.value as TilesetId)}
              className="setting-input"
            >
              {getAllTilesets(customTilesets).map((tileset) => (
                <option key={tileset.id} value={tileset.id}>
                  {tileset.name} {tileset.description && `- ${tileset.description}`}
                  {tileset.isCustom && ' [Custom]'}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="mapTilesetDark">
              {t('settings.map_tileset_dark_label', 'Dark Mode Tileset')}
              <span className="setting-description">{t('settings.map_tileset_dark_description', 'Map style used when the dark appearance is active')}</span>
            </label>
            <select
              id="mapTilesetDark"
              value={draft.mapTilesetDark}
              onChange={(e) => updateField('mapTilesetDark', e.target.value as TilesetId)}
              className="setting-input"
            >
              {getAllTilesets(customTilesets).map((tileset) => (
                <option key={tileset.id} value={tileset.id}>
                  {tileset.name} {tileset.description && `- ${tileset.description}`}
                  {tileset.isCustom && ' [Custom]'}
                </option>
              ))}
            </select>
          </div>
          <CustomTilesetManager />
          <div className="setting-item">
            <label htmlFor="positionHistoryLineStyle">
              {t('settings.position_history_line_style_label')}
              <span className="setting-description">{t('settings.position_history_line_style_description')}</span>
            </label>
            <select
              id="positionHistoryLineStyle"
              value={draft.positionHistoryLineStyle}
              onChange={(e) => updateField('positionHistoryLineStyle', e.target.value as PositionHistoryLineStyle)}
              className="setting-input"
            >
              <option value="linear">{t('settings.position_history_line_style_linear')}</option>
              <option value="spline">{t('settings.position_history_line_style_spline')}</option>
            </select>
          </div>
          <div className="setting-item">
            <label htmlFor="neighborInfoMinZoom">
              {t('settings.neighbor_info_min_zoom_label')}
              <span className="setting-description">{t('settings.neighbor_info_min_zoom_description')}</span>
            </label>
            <input
              id="neighborInfoMinZoom"
              type="number"
              min="1"
              max="18"
              value={draft.neighborInfoMinZoom}
              onChange={(e) => {
                const value = parseInt(e.target.value);
                if (value >= 1 && value <= 18) {
                  updateField('neighborInfoMinZoom', value);
                }
              }}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mapCenterTargetZoom">
              {t('settings.map_center_target_zoom_label')}
              <span className="setting-description">{t('settings.map_center_target_zoom_description')}</span>
            </label>
            <input
              id="mapCenterTargetZoom"
              type="number"
              min="1"
              max="18"
              value={draft.mapCenterTargetZoom}
              onChange={(e) => {
                const value = parseInt(e.target.value);
                if (value >= 1 && value <= 18) {
                  updateField('mapCenterTargetZoom', value);
                }
              }}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>
          <GeoJsonLayerManager />
          <MapStyleManager />
          {isAdmin && (
            <div className="setting-item">
              <label>
                Default Map Center
                <span className="setting-description">Set the default map position for new visitors and shared links.</span>
              </label>
              <DefaultMapCenterPicker
                lat={draft.defaultMapCenterLat}
                lon={draft.defaultMapCenterLon}
                zoom={draft.defaultMapCenterZoom}
                onSave={(lat, lon, zoom) => {
                  updateField('defaultMapCenterLat', lat);
                  updateField('defaultMapCenterLon', lon);
                  updateField('defaultMapCenterZoom', zoom);
                }}
                onClear={() => {
                  updateField('defaultMapCenterLat', null);
                  updateField('defaultMapCenterLon', null);
                  updateField('defaultMapCenterZoom', null);
                }}
              />
            </div>
          )}
          {isAdmin && (
            <div id="settings-embed">
              <h4>{t('settings.embed_maps', 'Embed Maps')}</h4>
              <EmbedSettings />
            </div>
          )}
        </div>}

        {show('settings-node-display') && <div id="settings-node-display" className="settings-section">
          <h3>{t('settings.node_display')}</h3>
          <div className="setting-item">
            <label htmlFor="maxNodeAge">
              {t('settings.max_node_age_label')}
              <span className="setting-description">{t('settings.max_node_age_description')}</span>
            </label>
            <input
              id="maxNodeAge"
              type="number"
              min="1"
              max="168"
              value={draft.maxNodeAgeHours}
              onChange={(e) => updateField('maxNodeAgeHours', parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="inactiveNodeThresholdHours">
              {t('settings.inactive_node_threshold_label')}
              <span className="setting-description">{t('settings.inactive_node_threshold_description')}</span>
            </label>
            <input
              id="inactiveNodeThresholdHours"
              type="number"
              min="1"
              max="720"
              value={draft.inactiveNodeThresholdHours}
              onChange={(e) => updateField('inactiveNodeThresholdHours', parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="inactiveNodeCheckIntervalMinutes">
              {t('settings.inactive_node_check_interval_label')}
              <span className="setting-description">{t('settings.inactive_node_check_interval_description')}</span>
            </label>
            <input
              id="inactiveNodeCheckIntervalMinutes"
              type="number"
              min="1"
              max="1440"
              value={draft.inactiveNodeCheckIntervalMinutes}
              onChange={(e) => updateField('inactiveNodeCheckIntervalMinutes', parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="inactiveNodeCooldownHours">
              {t('settings.inactive_node_cooldown_label')}
              <span className="setting-description">{t('settings.inactive_node_cooldown_description')}</span>
            </label>
            <input
              id="inactiveNodeCooldownHours"
              type="number"
              min="1"
              max="720"
              value={draft.inactiveNodeCooldownHours}
              onChange={(e) => updateField('inactiveNodeCooldownHours', parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="localStatsIntervalMinutes">
              {t('settings.local_stats_interval_label')}
              <span className="setting-description">{t('settings.local_stats_interval_description')}</span>
            </label>
            <input
              id="localStatsIntervalMinutes"
              type="number"
              min="0"
              max="60"
              value={draft.localStatsIntervalMinutes}
              onChange={(e) => updateField('localStatsIntervalMinutes', parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="nodeHopsCalculation">
              {t('settings.node_hops_calculation')}
              <span className="setting-description">{t('settings.node_hops_calculation_description')}</span>
            </label>
            <select
              id="nodeHopsCalculation"
              value={draft.nodeHopsCalculation}
              onChange={(e) => updateField('nodeHopsCalculation', e.target.value as NodeHopsCalculation)}
              className="setting-input"
            >
              <option value="nodeinfo">{t('settings.node_hops_nodeinfo')}</option>
              <option value="traceroute">{t('settings.node_hops_traceroute')}</option>
              <option value="messages">{t('settings.node_hops_messages')}</option>
            </select>
          </div>
          <div className="setting-item" style={{ marginTop: '1rem' }}>
            <label>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draft.hideIncompleteNodes}
                  onChange={(e) => updateField('hideIncompleteNodes', e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {t('settings.hide_incomplete_nodes')}
              </span>
              <span className="setting-description">{t('settings.hide_incomplete_description')}</span>
            </label>
          </div>
          <div className="setting-item" style={{ marginTop: '1rem' }}>
            <label>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={nodeDimmingEnabled}
                  onChange={(e) => setNodeDimmingEnabled(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {t('settings.node_dimming_enabled')}
              </span>
              <span className="setting-description">{t('settings.node_dimming_description')}</span>
            </label>
          </div>
          {nodeDimmingEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="nodeDimmingStartHours">
                  {t('settings.node_dimming_start_hours')}
                  <span className="setting-description">{t('settings.node_dimming_start_hours_description')}</span>
                </label>
                <input
                  id="nodeDimmingStartHours"
                  type="number"
                  min="0.5"
                  max="24"
                  step="0.5"
                  value={nodeDimmingStartHours}
                  onChange={(e) => setNodeDimmingStartHours(Math.min(24, Math.max(0.5, parseFloat(e.target.value) || 1)))}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="nodeDimmingMinOpacity">
                  {t('settings.node_dimming_min_opacity')}
                  <span className="setting-description">{t('settings.node_dimming_min_opacity_description')}</span>
                </label>
                <input
                  id="nodeDimmingMinOpacity"
                  type="number"
                  min="0.1"
                  max="0.9"
                  step="0.1"
                  value={nodeDimmingMinOpacity}
                  onChange={(e) => setNodeDimmingMinOpacity(Math.min(0.9, Math.max(0.1, parseFloat(e.target.value) || 0.3)))}
                  className="setting-input"
                />
              </div>
            </>
          )}
        </div>}

        {show('settings-telemetry') && <div id="settings-telemetry" className="settings-section">
          <h3>{t('settings.telemetry')}</h3>
          <div className="setting-item">
            <label htmlFor="telemetryVisualizationHours">
              {t('settings.telemetry_hours_label')}
              <span className="setting-description">{t('settings.telemetry_hours_description')}</span>
            </label>
            <input
              type="number"
              id="telemetryVisualizationHours"
              min="1"
              max="168"
              value={draft.telemetryVisualizationHours}
              onChange={(e) => updateField('telemetryVisualizationHours', Math.min(168, Math.max(1, parseInt(e.target.value) || 24)))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="favoriteTelemetryStorageDays">
              {t('settings.fav_telemetry_label')}
              <span className="setting-description">{t('settings.fav_telemetry_description')}</span>
            </label>
            <input
              type="number"
              id="favoriteTelemetryStorageDays"
              min="7"
              max="90"
              value={draft.favoriteTelemetryStorageDays}
              onChange={(e) => updateField('favoriteTelemetryStorageDays', Math.min(90, Math.max(7, parseInt(e.target.value) || 7)))}
              className="setting-input"
            />
          </div>
        </div>}

        {show('settings-security') && <div id="settings-security" className="settings-section">
          <h3>{t('settings.security', 'Security')}</h3>
          <div className="setting-item">
            <PkiDmGlobalToggle />
          </div>
        </div>}

        {show('settings-notifications') && <div id="settings-notifications" className="settings-section">
          <h3>{t('settings.notifications_and_security')}</h3>
          <div className="setting-item">
            <label>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={enableAudioNotifications}
                  onChange={(e) => setEnableAudioNotifications(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {t('settings.enable_audio_notifications')}
              </span>
              <span className="setting-description">{t('settings.enable_audio_notifications_description')}</span>
            </label>
          </div>
          {enableAudioNotifications && (
            <div className="setting-item">
              <label>
                {t('settings.channel_sounds_label', 'Per-channel notification sound')}
                <span className="setting-description">
                  {t('settings.channel_sounds_description', 'Choose which sound plays for new messages on each channel, or silence a channel. Preview each sound before selecting.')}
                </span>
              </label>
              <ChannelSoundPicker />
            </div>
          )}
          <div className="setting-item">
            <label>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={draft.homoglyphEnabled}
                  onChange={(e) => updateField('homoglyphEnabled', e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {t('settings.homoglyph_enabled')}
              </span>
              <span className="setting-description">{t('settings.homoglyph_description')}</span>
            </label>
          </div>
        </div>}

        {show('settings-packet-monitor') && <div id="settings-packet-monitor" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.packetLogEnabled}
                onChange={(e) => updateField('packetLogEnabled', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.packet_monitor')}</span>
            </label>

          </h3>
          <p className="setting-description">{t('settings.packet_monitor_description')}</p>
          <div className="packet-monitor-settings">
            <PacketMonitorSettings
              enabled={draft.packetLogEnabled}
              maxCount={draft.packetLogMaxCount}
              maxAgeHours={draft.packetLogMaxAgeHours}
              onMaxCountChange={(count) => updateField('packetLogMaxCount', count)}
              onMaxAgeHoursChange={(hours) => updateField('packetLogMaxAgeHours', hours)}
            />
          </div>
        </div>}

        {show('settings-solar') && <div id="settings-solar" className="settings-section">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.solarMonitoringEnabled}
                onChange={(e) => updateField('solarMonitoringEnabled', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.solar_monitoring')}</span>
            </label>
          </h3>
          <p className="setting-description">
            {t('settings.solar_monitoring_description', { link: '' })}
            <a href="https://forecast.solar/" target="_blank" rel="noopener noreferrer" style={{ color: '#89b4fa' }}>
              Forecast.Solar
            </a>
          </p>
          {draft.solarMonitoringEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="solarLatitude">
                  {t('settings.solar_latitude')}
                  <span className="setting-description">
                    {t('settings.solar_latitude_description')} • <a href="https://www.latlong.net/" target="_blank" rel="noopener noreferrer" style={{ color: '#4a9eff', textDecoration: 'underline' }}>{t('settings.solar_find_coords')}</a>
                  </span>
                </label>
                <input
                  id="solarLatitude"
                  type="number"
                  min="-90"
                  max="90"
                  step="0.0001"
                  value={draft.solarMonitoringLatitude}
                  onChange={(e) => updateField('solarMonitoringLatitude', parseFloat(e.target.value) || 0)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="solarLongitude">
                  {t('settings.solar_longitude')}
                  <span className="setting-description">{t('settings.solar_longitude_description')}</span>
                </label>
                <input
                  id="solarLongitude"
                  type="number"
                  min="-180"
                  max="180"
                  step="0.0001"
                  value={draft.solarMonitoringLongitude}
                  onChange={(e) => updateField('solarMonitoringLongitude', parseFloat(e.target.value) || 0)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="solarAzimuth">
                  {t('settings.solar_azimuth')}
                  <span className="setting-description">{t('settings.solar_azimuth_description')}</span>
                </label>
                <input
                  id="solarAzimuth"
                  type="number"
                  min="-180"
                  max="180"
                  step="1"
                  value={draft.solarMonitoringAzimuth}
                  onChange={(e) => updateField('solarMonitoringAzimuth', parseInt(e.target.value) || 0)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="solarDeclination">
                  {t('settings.solar_declination')}
                  <span className="setting-description">{t('settings.solar_declination_description')}</span>
                </label>
                <input
                  id="solarDeclination"
                  type="number"
                  min="0"
                  max="90"
                  step="1"
                  value={draft.solarMonitoringDeclination}
                  onChange={(e) => updateField('solarMonitoringDeclination', parseInt(e.target.value) || 30)}
                  className="setting-input"
                />
              </div>
              <div className="setting-item" style={{ marginTop: '1rem' }}>
                <button
                  onClick={handleFetchSolarEstimates}
                  disabled={isFetchingSolarEstimates}
                  className="save-button"
                  style={{ width: 'auto', padding: '0.5rem 1rem' }}
                >
                  {isFetchingSolarEstimates ? t('settings.solar_fetching') : t('settings.solar_fetch_now')}
                </button>
                <p className="setting-description" style={{ marginTop: '0.5rem' }}>
                  {t('settings.solar_fetch_description')}
                </p>
              </div>
            </>
          )}
        </div>}

        {show('settings-apprise-server') && isAdmin && <div id="settings-apprise-server" className="settings-section">
          <h3>{t('settings.apprise_server_section', 'Apprise API Server')}</h3>
          <p className="setting-description">
            {t('settings.apprise_server_description', 'MeshMonitor delivers Apprise notifications through an Apprise API server, which fans out to the per-user notification service URLs (Discord, email, etc.) configured elsewhere. Override the server location below if you are running it outside the bundled container.')}
          </p>
          <div className="setting-item">
            <label htmlFor="appriseApiServerUrl">
              {t('settings.apprise_server_url_label', 'Apprise API Server URL')}
              <span className="setting-description">
                {t('settings.apprise_server_url_description', 'Leave empty if MeshMonitor\'s bundled Apprise API server is running (default for Docker installs).')}
              </span>
            </label>
            <input
              id="appriseApiServerUrl"
              type="url"
              value={draft.appriseApiServerUrl}
              onChange={(e) => updateField('appriseApiServerUrl', e.target.value)}
              placeholder="http://localhost:8000"
              className="setting-input"
              autoComplete="off"
              spellCheck={false}
            />
            <div style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                onClick={handleTestAppriseConnection}
                disabled={isTestingApprise}
                className="save-button"
                style={{ width: 'auto', padding: '0.5rem 1rem' }}
              >
                {isTestingApprise
                  ? t('settings.apprise_server_testing', 'Testing…')
                  : t('settings.apprise_server_test', 'Test Connection')}
              </button>
              {appriseTestResult && (
                <p
                  className="setting-description"
                  style={{
                    marginTop: '0.5rem',
                    color: appriseTestResult.ok ? 'var(--color-success, #10b981)' : 'var(--color-error, #ef4444)',
                  }}
                >
                  {appriseTestResult.message}
                </p>
              )}
            </div>
          </div>
        </div>}

        {show('settings-elevation') && isAdmin && <div id="settings-elevation" className="settings-section">
          <h3>{t('settings.elevation_section', 'Elevation / Terrain')}</h3>
          <p className="setting-description">
            {t(
              'settings.elevation_section_description',
              'Powers the Map Analysis Link Profile tool\'s terrain chart. Elevation samples are fetched server-side from a public AWS Terrarium DEM tile source by default; you can point it at a different source below.'
            )}
          </p>
          <div className="setting-item">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                id="elevationEnabled"
                type="checkbox"
                checked={draft.elevationEnabled}
                onChange={(e) => updateField('elevationEnabled', e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>{t('settings.elevation_enabled_label', 'Enable terrain elevation')}</span>
            </label>
            <span className="setting-description">
              {t('settings.elevation_enabled_description', 'Turns off the Link Profile tool\'s terrain chart when disabled.')}
            </span>
          </div>
          <div className="setting-item">
            <label htmlFor="elevationSourceUrl">
              {t('settings.elevation_source_url_label', 'Elevation Source URL')}
              <span className="setting-description">
                {t('settings.elevation_source_url_description', 'Leave empty to use the default public AWS Terrarium source.')}
              </span>
            </label>
            <input
              id="elevationSourceUrl"
              type="text"
              value={draft.elevationSourceUrl}
              onChange={(e) => updateField('elevationSourceUrl', e.target.value)}
              placeholder={DEFAULT_TERRARIUM_URL}
              className="setting-input"
              autoComplete="off"
              spellCheck={false}
            />
            <div style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                onClick={handleTestElevation}
                disabled={elevationTesting}
                className="save-button"
                style={{ width: 'auto', padding: '0.5rem 1rem' }}
              >
                {elevationTesting
                  ? t('settings.elevation_testing', 'Testing…')
                  : t('settings.elevation_test', 'Test')}
              </button>
              {elevationTestResult && (
                <p
                  className="setting-description"
                  style={{
                    marginTop: '0.5rem',
                    color: elevationTestResult.ok ? 'var(--color-success, #10b981)' : 'var(--color-error, #ef4444)',
                  }}
                >
                  {elevationTestResult.message}
                </p>
              )}
            </div>
          </div>
        </div>}

        {show('settings-backup') && <div id="settings-backup">
          <SystemBackupSection />
        </div>}

        {show('settings-channel-database') && isAdmin && <div id="settings-channel-database">
          <ChannelDatabaseSection isAdmin={isAdmin} />
        </div>}

        {show('settings-maintenance') && <DatabaseMaintenanceSection />}

        {show('settings-firmware') && isAdmin && firmwareOtaEnabled && <FirmwareUpdateSection baseUrl={baseUrl} />}

        {show('settings-reset-ui') && <div id="settings-reset-ui" className="settings-section">
          <h3>{t('settings.reset_ui_positions')}</h3>
          <p className="setting-description">{t('settings.reset_ui_positions_description')}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              // Clear all draggable UI element positions from localStorage
              localStorage.removeItem('nodesSidebarPosition');
              localStorage.removeItem('nodesSidebarSize');
              localStorage.removeItem('mapControlsPosition');
              localStorage.removeItem('draggable_position_map-legend');
              localStorage.removeItem('draggable_position_tileset-selector');
              showToast(t('settings.reset_ui_positions_success'), 'success');
            }}
          >
            {t('settings.reset_ui_positions_button')}
          </button>
        </div>}

        {show('settings-position-estimation') && canWriteSettings && (
        <div id="settings-position-estimation" className="settings-section">
          <PositionEstimationSection baseUrl={baseUrl} />
        </div>
        )}

        {show('settings-analytics') && isAdmin && (
        <div id="settings-analytics" className="settings-section">
          <h3>{t('settings.analytics')}</h3>

          <div className="setting-item">
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 1rem 0', padding: '0.75rem', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', borderLeft: '3px solid var(--warning-border, #ffeaa7)' }}>
              {t('settings.analytics_warning')}
            </p>
          </div>

          <div className="setting-item">
            <label htmlFor="analyticsProvider">
              {t('settings.analytics_provider_label')}
              <span className="setting-description">{t('settings.analytics_provider_description')}</span>
            </label>
            <select
              id="analyticsProvider"
              value={draft.analyticsProvider}
              onChange={(e) => {
                updateField('analyticsProvider', e.target.value);
                updateField('analyticsConfig', {});
              }}
              className="setting-input"
            >
              <option value="none">{t('settings.analytics_provider_none')}</option>
              <option value="ga4">{t('settings.analytics_provider_ga4')}</option>
              <option value="cloudflare">{t('settings.analytics_provider_cloudflare')}</option>
              <option value="posthog">{t('settings.analytics_provider_posthog')}</option>
              <option value="plausible">{t('settings.analytics_provider_plausible')}</option>
              <option value="umami">{t('settings.analytics_provider_umami')}</option>
              <option value="matomo">{t('settings.analytics_provider_matomo')}</option>
              <option value="custom">{t('settings.analytics_provider_custom')}</option>
            </select>
          </div>

          {draft.analyticsProvider === 'ga4' && (
            <div className="setting-item">
              <label htmlFor="analyticsMeasurementId">
                {t('settings.analytics_measurement_id_label')}
                <span className="setting-description">{t('settings.analytics_measurement_id_description')}</span>
              </label>
              <input id="analyticsMeasurementId" type="text" value={draft.analyticsConfig.measurementId || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, measurementId: e.target.value })} className="setting-input" placeholder="G-XXXXXXXXXX" />
            </div>
          )}

          {draft.analyticsProvider === 'cloudflare' && (
            <div className="setting-item">
              <label htmlFor="analyticsBeaconToken">
                {t('settings.analytics_beacon_token_label')}
                <span className="setting-description">{t('settings.analytics_beacon_token_description')}</span>
              </label>
              <input id="analyticsBeaconToken" type="text" value={draft.analyticsConfig.beaconToken || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, beaconToken: e.target.value })} className="setting-input" />
            </div>
          )}

          {draft.analyticsProvider === 'posthog' && (
            <>
              <div className="setting-item">
                <label htmlFor="analyticsApiKey">
                  {t('settings.analytics_api_key_label')}
                  <span className="setting-description">{t('settings.analytics_api_key_description')}</span>
                </label>
                <input id="analyticsApiKey" type="text" value={draft.analyticsConfig.apiKey || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, apiKey: e.target.value })} className="setting-input" placeholder="phc_..." />
              </div>
              <div className="setting-item">
                <label htmlFor="analyticsApiHost">
                  {t('settings.analytics_api_host_label')}
                  <span className="setting-description">{t('settings.analytics_api_host_description')}</span>
                </label>
                <input id="analyticsApiHost" type="text" value={draft.analyticsConfig.apiHost || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, apiHost: e.target.value })} className="setting-input" placeholder="https://app.posthog.com" />
              </div>
            </>
          )}

          {draft.analyticsProvider === 'plausible' && (
            <div className="setting-item">
              <label htmlFor="analyticsDomain">
                {t('settings.analytics_domain_label')}
                <span className="setting-description">{t('settings.analytics_domain_description')}</span>
              </label>
              <input id="analyticsDomain" type="text" value={draft.analyticsConfig.domain || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, domain: e.target.value })} className="setting-input" placeholder="example.com" />
            </div>
          )}

          {draft.analyticsProvider === 'umami' && (
            <>
              <div className="setting-item">
                <label htmlFor="analyticsWebsiteId">
                  {t('settings.analytics_website_id_label')}
                  <span className="setting-description">{t('settings.analytics_website_id_description')}</span>
                </label>
                <input id="analyticsWebsiteId" type="text" value={draft.analyticsConfig.websiteId || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, websiteId: e.target.value })} className="setting-input" />
              </div>
              <div className="setting-item">
                <label htmlFor="analyticsScriptUrl">
                  {t('settings.analytics_script_url_label')}
                  <span className="setting-description">{t('settings.analytics_script_url_description')}</span>
                </label>
                <input id="analyticsScriptUrl" type="text" value={draft.analyticsConfig.scriptUrl || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, scriptUrl: e.target.value })} className="setting-input" placeholder="https://analytics.example.com/script.js" />
              </div>
            </>
          )}

          {draft.analyticsProvider === 'matomo' && (
            <>
              <div className="setting-item">
                <label htmlFor="analyticsSiteUrl">
                  {t('settings.analytics_site_url_label')}
                  <span className="setting-description">{t('settings.analytics_site_url_description')}</span>
                </label>
                <input id="analyticsSiteUrl" type="text" value={draft.analyticsConfig.siteUrl || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, siteUrl: e.target.value })} className="setting-input" placeholder="https://matomo.example.com" />
              </div>
              <div className="setting-item">
                <label htmlFor="analyticsSiteId">
                  {t('settings.analytics_site_id_label')}
                  <span className="setting-description">{t('settings.analytics_site_id_description')}</span>
                </label>
                <input id="analyticsSiteId" type="text" value={draft.analyticsConfig.siteId || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, siteId: e.target.value })} className="setting-input" placeholder="1" />
              </div>
            </>
          )}

          {draft.analyticsProvider === 'custom' && (
            <div className="setting-item">
              <label htmlFor="analyticsCustomScript">
                {t('settings.analytics_custom_script_label')}
                <span className="setting-description">{t('settings.analytics_custom_script_description')}</span>
              </label>
              <textarea id="analyticsCustomScript" value={draft.analyticsConfig.script || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, script: e.target.value })} className="setting-input" rows={6} style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} placeholder='<script src="https://..."></script>' />
            </div>
          )}

          {draft.analyticsProvider === 'custom' && (
            <div className="setting-item">
              <label htmlFor="analyticsCustomCspDomains">
                {t('settings.analytics_custom_csp_label')}
                <span className="setting-description">{t('settings.analytics_custom_csp_description')}</span>
              </label>
              <input type="text" id="analyticsCustomCspDomains" value={draft.analyticsConfig.cspDomains || ''} onChange={(e) => updateField('analyticsConfig', { ...draft.analyticsConfig, cspDomains: e.target.value })} className="setting-input" placeholder="https://analytics.example.com https://cdn.example.com" />
            </div>
          )}
        </div>
        )}

        {show('settings-management') && <div id="settings-management" className="settings-section">
          <h3>{t('settings.settings_management')}</h3>
          <p className="setting-description">{t('settings.settings_management_description')}</p>
          <div className="settings-buttons">
            <button
              className="reset-button"
              onClick={handleReset}
              disabled={isSaving}
            >
              {t('settings.reset_defaults')}
            </button>
          </div>
        </div>}

        {show('settings-danger') && <div id="settings-danger" className="settings-section danger-zone">
          <h3><UiIcon name="alert" /> {t('settings.danger_zone')}</h3>
          <p className="danger-zone-description">{t('settings.danger_zone_description')}</p>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.erase_nodes_title')}</h4>
              <p>{t('settings.erase_nodes_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeNodes}
            >
              {t('settings.erase_nodes_button')}
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.purge_telemetry_title')}</h4>
              <p>{t('settings.purge_telemetry_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTelemetry}
            >
              {t('settings.purge_telemetry_button')}
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.purge_messages_title')}</h4>
              <p>{t('settings.purge_messages_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeMessages}
            >
              {t('settings.purge_messages_button')}
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>{t('settings.reset_traceroutes_title')}</h4>
              <p>{t('settings.reset_traceroutes_description')}</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTraceroutes}
            >
              {t('settings.reset_traceroutes_button')}
            </button>
          </div>

          {isDocker !== null && (
            <div className="danger-action">
              <div className="danger-action-info">
                <h4>{isDocker ? t('settings.restart_container_title') : t('settings.shutdown_title')}</h4>
                <p>
                  {isDocker
                    ? t('settings.restart_container_description')
                    : t('settings.shutdown_description')}
                </p>
              </div>
              <button
                className="danger-button"
                onClick={handleRestartContainer}
                disabled={isRestarting}
              >
                {isRestarting
                  ? (isDocker ? t('settings.restarting') : t('settings.shutting_down'))
                  : <><UiIcon name={isDocker ? 'refresh' : 'power'} /> {isDocker ? t('settings.restart_button') : t('settings.shutdown_button')}</>}
              </button>
            </div>
          )}
        </div>}
      </div>
    </div>
  );
};

export default SettingsTab;
