import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import api from '../services/api';
import { type TemperatureUnit } from '../utils/temperature';
import { type SortField, type SortDirection } from '../types/ui';
import { type SortOption as DashboardSortOption } from '../components/Dashboard/types';
import { logger } from '../utils/logger';
import { OPTIONAL_THEME_COLORS } from '../utils/themeValidation';
import { useCsrf } from './CsrfContext';
import { DEFAULT_TILESET_ID, type TilesetId, type CustomTileset } from '../config/tilesets';
import { type OverlayScheme, getSchemeForTileset, getOverlayColors, type OverlayColors } from '../config/overlayColors';
import i18n from '../config/i18n';
import { type TapbackEmoji, DEFAULT_TAPBACK_EMOJIS } from '../components/EmojiPickerModal/EmojiPickerModal';
import { DEFAULT_TARGET_ZOOM } from '../utils/mapZoomAnimation';
import { setDiscardInvalidPositionsDisplay } from '../utils/positionDisplayConfig';
import { setActiveWindowHours } from '../utils/activeWindowConfig';
import { IconStyleProvider, type IconStyle } from './IconStyleContext';

export type { IconStyle } from './IconStyleContext';

/** A per-channel mute rule. muteUntil = null means indefinite. */
export interface MutedChannel {
  channelId: number;
  muteUntil: number | null;
}

/** A per-DM mute rule keyed by remote node UUID. muteUntil = null means indefinite. */
export interface MutedDM {
  nodeUuid: string;
  muteUntil: number | null;
}

export type DistanceUnit = 'km' | 'mi';
export type PositionHistoryLineStyle = 'linear' | 'spline';
export type TimeFormat = '12' | '24';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
export type MapPinStyle = 'meshmonitor' | 'official';
export type NodeHopsCalculation = 'nodeinfo' | 'traceroute' | 'messages';
export type AppearanceMode = 'system' | 'dark' | 'light';
export type ActiveAppearanceMode = 'dark' | 'light';

// Built-in theme types
export type BuiltInTheme =
  | 'mocha' | 'macchiato' | 'frappe' | 'latte'
  | 'nord' | 'dracula'
  | 'solarized-dark' | 'solarized-light'
  | 'gruvbox-dark' | 'gruvbox-light'
  | 'high-contrast-dark' | 'high-contrast-light'
  | 'protanopia' | 'deuteranopia' | 'tritanopia';

// Theme can be a built-in theme or a custom theme slug
export type Theme = BuiltInTheme | string;

interface ThemePreferences {
  appearanceMode: AppearanceMode;
  darkTheme: Theme;
  lightTheme: Theme;
  effectiveTheme: Theme;
}

interface MapTilesetPreferences {
  light: TilesetId;
  dark: TilesetId;
}

export const DEFAULT_DARK_TILESET_ID: TilesetId = 'cartoDark';

// Custom theme definition from the API
export interface CustomTheme {
  id: number;
  name: string;
  slug: string;
  definition: string; // JSON string of color variables
  is_builtin: number;
  created_by?: number;
  created_at: number;
  updated_at: number;
}

interface SettingsContextType {
  maxNodeAgeHours: number;
  inactiveNodeThresholdHours: number;
  inactiveNodeCheckIntervalMinutes: number;
  inactiveNodeCooldownHours: number;
  tracerouteIntervalMinutes: number;
  remoteLocalStatsIntervalMinutes: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  positionHistoryLineStyle: PositionHistoryLineStyle;
  telemetryVisualizationHours: number;
  favoriteTelemetryStorageDays: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  preferredDashboardSortOption: DashboardSortOption;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  mapTileset: TilesetId;
  mapTilesetLight: TilesetId;
  mapTilesetDark: TilesetId;
  activeMapTilesetMode: ActiveAppearanceMode;
  overlayScheme: OverlayScheme;
  overlayColors: OverlayColors;
  mapPinStyle: MapPinStyle;
  iconStyle: IconStyle;
  neighborInfoMinZoom: number;
  defaultMapCenterLat: number | null;
  defaultMapCenterLon: number | null;
  defaultMapCenterZoom: number | null;
  /** Target zoom when centering on a single node — MapCenterController
   *  clamps to `Math.max(currentZoom, mapCenterTargetZoom)`, so this only
   *  ever zooms IN, never forces a zoom-out (issue #4046 item 2). Also feeds
   *  the zoom-gated spiderfier's below-threshold click flow (item 4). */
  mapCenterTargetZoom: number;
  defaultLandingPage: string;
  theme: Theme;
  appearanceMode: AppearanceMode;
  darkTheme: Theme;
  lightTheme: Theme;
  language: string;
  customThemes: CustomTheme[];
  customTilesets: CustomTileset[];
  isLoadingThemes: boolean;
  solarMonitoringEnabled: boolean;
  solarMonitoringLatitude: number;
  solarMonitoringLongitude: number;
  solarMonitoringAzimuth: number;
  solarMonitoringDeclination: number;
  enableAudioNotifications: boolean;
  /** Global toggle: fetch & render OpenGraph link preview cards for URLs in messages. */
  linkPreviewsEnabled: boolean;
  /** Global Map toggle (default true): discard Null Island (0,0) fixes on ingest. */
  discardInvalidPositions: boolean;
  /** Global privacy toggle (issue #4202, default false): emit X-Robots-Tag: noindex, nofollow + disallow-all /robots.txt. */
  noIndexEnabled: boolean;
  /**
   * Global opt-in (issue #3979, default false): auto-retry an AUTOMATED MeshCore
   * channel send once, 30s later, when zero repeaters were heard. Automated
   * senders only; never user-initiated sends. Distinct from the DM ack-retry.
   */
  meshcoreChannelRetryEnabled: boolean;
  nodeDimmingEnabled: boolean;
  nodeDimmingStartHours: number;
  nodeDimmingMinOpacity: number;
  nodeHopsCalculation: NodeHopsCalculation;
  tapbackEmojis: TapbackEmoji[];
  temporaryTileset: TilesetId | null;
  setTemporaryTileset: (tilesetId: TilesetId | null) => void;
  isLoading: boolean;
  setMaxNodeAgeHours: (hours: number) => void;
  setInactiveNodeThresholdHours: (hours: number) => void;
  setInactiveNodeCheckIntervalMinutes: (minutes: number) => void;
  setInactiveNodeCooldownHours: (hours: number) => void;
  setTracerouteIntervalMinutes: (minutes: number) => void;
  setRemoteLocalStatsIntervalMinutes: (minutes: number) => void;
  setTemperatureUnit: (unit: TemperatureUnit) => void;
  setDistanceUnit: (unit: DistanceUnit) => void;
  setPositionHistoryLineStyle: (style: PositionHistoryLineStyle) => void;
  setTelemetryVisualizationHours: (hours: number) => void;
  setFavoriteTelemetryStorageDays: (days: number) => void;
  setPreferredSortField: (field: SortField) => void;
  setPreferredSortDirection: (direction: SortDirection) => void;
  setPreferredDashboardSortOption: (option: DashboardSortOption) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setDateFormat: (format: DateFormat) => void;
  setMapTileset: (tilesetId: TilesetId) => void;
  setMapTilesets: (light: TilesetId, dark: TilesetId) => void;
  setMapPinStyle: (style: MapPinStyle) => void;
  setIconStyle: (style: IconStyle) => void;
  setNeighborInfoMinZoom: (zoom: number) => void;
  setDefaultMapCenterLat: (lat: number | null) => void;
  setDefaultMapCenterLon: (lon: number | null) => void;
  setDefaultMapCenterZoom: (zoom: number | null) => void;
  setMapCenterTargetZoom: (zoom: number) => void;
  setDefaultLandingPage: (value: string) => void;
  setTheme: (theme: Theme) => void;
  setAppearanceMode: (mode: AppearanceMode) => void;
  setDarkTheme: (theme: Theme) => void;
  setLightTheme: (theme: Theme) => void;
  setLanguage: (language: string) => void;
  loadCustomThemes: () => Promise<void>;
  addCustomTileset: (tileset: Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateCustomTileset: (id: string, updates: Partial<Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  deleteCustomTileset: (id: string) => Promise<void>;
  setSolarMonitoringEnabled: (enabled: boolean) => void;
  setSolarMonitoringLatitude: (latitude: number) => void;
  setSolarMonitoringLongitude: (longitude: number) => void;
  setSolarMonitoringAzimuth: (azimuth: number) => void;
  setSolarMonitoringDeclination: (declination: number) => void;
  setEnableAudioNotifications: (enabled: boolean) => void;
  setLinkPreviewsEnabled: (enabled: boolean) => void;
  setDiscardInvalidPositions: (enabled: boolean) => void;
  setNoIndexEnabled: (enabled: boolean) => void;
  setMeshcoreChannelRetryEnabled: (enabled: boolean) => void;
  mutedChannels: MutedChannel[];
  mutedDMs: MutedDM[];
  muteChannel: (channelId: number, muteUntil: number | null) => Promise<void>;
  unmuteChannel: (channelId: number) => Promise<void>;
  muteDM: (nodeUuid: string, muteUntil: number | null) => Promise<void>;
  unmuteDM: (nodeUuid: string) => Promise<void>;
  isChannelMuted: (channelId: number) => boolean;
  isDMMuted: (nodeUuid: string) => boolean;
  setNodeDimmingEnabled: (enabled: boolean) => void;
  setNodeDimmingStartHours: (hours: number) => void;
  setNodeDimmingMinOpacity: (opacity: number) => void;
  setNodeHopsCalculation: (calculation: NodeHopsCalculation) => void;
  setTapbackEmojis: (emojis: TapbackEmoji[]) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

interface SettingsProviderProps {
  children: ReactNode;
  baseUrl?: string;
}

// Detect BASE_URL from window.location when caller doesn't supply one.
// Mirrors detectBaseUrl() in App.tsx / DashboardPage so providers mounted by
// pages that don't thread baseUrl through (GlobalSettingsPage, ReportsPage,
// MapAnalysisPage, PacketMonitorPage, DashboardPage) still POST to the
// correct /<base>/api/... path.
const detectBaseUrlFromLocation = (): string => {
  if (typeof window === 'undefined') return '';
  const pathname = window.location.pathname;
  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts.length === 0) return '';
  const appRoutes = ['nodes', 'channels', 'messages', 'settings', 'info', 'dashboard', 'source', 'unified', 'analysis', 'reports', 'users', 'packet-monitor'];
  const baseSegments: string[] = [];
  for (const segment of pathParts) {
    if (appRoutes.includes(segment.toLowerCase())) break;
    baseSegments.push(segment);
  }
  return baseSegments.length > 0 ? '/' + baseSegments.join('/') : '';
};

const DEFAULT_DARK_THEME: Theme = 'mocha';
const DEFAULT_LIGHT_THEME: Theme = 'latte';
const BUILT_IN_THEMES: BuiltInTheme[] = [
  'mocha', 'macchiato', 'frappe', 'latte',
  'nord', 'dracula',
  'solarized-dark', 'solarized-light',
  'gruvbox-dark', 'gruvbox-light',
  'high-contrast-dark', 'high-contrast-light',
  'protanopia', 'deuteranopia', 'tritanopia'
];

const isAppearanceMode = (value: string | null): value is AppearanceMode => (
  value === 'system' || value === 'dark' || value === 'light'
);

const prefersDarkMode = (): boolean => {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const getEffectiveTheme = (mode: AppearanceMode, darkTheme: Theme, lightTheme: Theme, systemIsDark: boolean): Theme => {
  if (mode === 'dark') return darkTheme;
  if (mode === 'light') return lightTheme;
  return systemIsDark ? darkTheme : lightTheme;
};

// eslint-disable-next-line react-refresh/only-export-components -- #4096 pure helper exported for focused tests
export const getEffectiveTileset = (
  mode: AppearanceMode,
  darkTileset: TilesetId,
  lightTileset: TilesetId,
  systemIsDark: boolean,
): TilesetId => {
  if (mode === 'dark') return darkTileset;
  if (mode === 'light') return lightTileset;
  return systemIsDark ? darkTileset : lightTileset;
};

// eslint-disable-next-line react-refresh/only-export-components -- #4096 pure helper exported for focused tests
export const getActiveAppearanceMode = (
  mode: AppearanceMode,
  systemIsDark: boolean,
): ActiveAppearanceMode => (
  mode === 'dark' || (mode === 'system' && systemIsDark) ? 'dark' : 'light'
);

// eslint-disable-next-line react-refresh/only-export-components -- #4096 pure helper exported for focused tests
export const resolveLegacyMapTilesets = (legacyTileset: string | null | undefined): MapTilesetPreferences => {
  if (!legacyTileset || legacyTileset === DEFAULT_TILESET_ID) {
    return { light: DEFAULT_TILESET_ID, dark: DEFAULT_DARK_TILESET_ID };
  }
  return { light: legacyTileset, dark: legacyTileset };
};

const getInitialMapTilesets = (): MapTilesetPreferences => {
  const legacy = resolveLegacyMapTilesets(localStorage.getItem('mapTileset'));
  const light = localStorage.getItem('mapTilesetLight') || legacy.light;
  const dark = localStorage.getItem('mapTilesetDark') || legacy.dark;
  localStorage.setItem('mapTilesetLight', light);
  localStorage.setItem('mapTilesetDark', dark);
  return { light, dark };
};

const getInitialThemePreferences = (): ThemePreferences => {
  const storedMode = localStorage.getItem('appearanceMode');
  const storedDarkTheme = localStorage.getItem('darkTheme');
  const storedLightTheme = localStorage.getItem('lightTheme');
  const legacyTheme = localStorage.getItem('theme');

  const hasNewPreferences = isAppearanceMode(storedMode) || storedDarkTheme || storedLightTheme;
  const darkTheme = storedDarkTheme || (hasNewPreferences ? DEFAULT_DARK_THEME : legacyTheme || DEFAULT_DARK_THEME);
  const lightTheme = storedLightTheme || (hasNewPreferences ? DEFAULT_LIGHT_THEME : legacyTheme && legacyTheme !== DEFAULT_DARK_THEME ? legacyTheme : DEFAULT_LIGHT_THEME);
  const appearanceMode = isAppearanceMode(storedMode)
    ? storedMode
    : legacyTheme && legacyTheme !== DEFAULT_DARK_THEME
      ? 'dark'
      : 'system';
  const effectiveTheme = getEffectiveTheme(appearanceMode, darkTheme, lightTheme, prefersDarkMode());

  localStorage.setItem('appearanceMode', appearanceMode);
  localStorage.setItem('darkTheme', darkTheme);
  localStorage.setItem('lightTheme', lightTheme);
  localStorage.setItem('theme', effectiveTheme);

  return { appearanceMode, darkTheme, lightTheme, effectiveTheme };
};

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children, baseUrl: baseUrlProp }) => {
  const baseUrl = baseUrlProp ?? detectBaseUrlFromLocation();
  const { getToken: getCsrfToken } = useCsrf();
  const [isLoading, setIsLoading] = useState(true);
  const [initialThemePreferences] = useState<ThemePreferences>(() => getInitialThemePreferences());
  const [initialMapTilesets] = useState<MapTilesetPreferences>(() => getInitialMapTilesets());
  const [systemIsDark, setSystemIsDark] = useState<boolean>(() => prefersDarkMode());

  const [maxNodeAgeHours, setMaxNodeAgeHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('maxNodeAgeHours');
    const initial = saved ? parseInt(saved) : 24;
    // #4240: seed the non-context mirror at boot so transport decay uses the
    // user's window from the first render, not the module default.
    setActiveWindowHours(initial);
    return initial;
  });

  const [inactiveNodeThresholdHours, setInactiveNodeThresholdHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('inactiveNodeThresholdHours');
    return saved ? parseInt(saved) : 24;
  });

  const [inactiveNodeCheckIntervalMinutes, setInactiveNodeCheckIntervalMinutesState] = useState<number>(() => {
    const saved = localStorage.getItem('inactiveNodeCheckIntervalMinutes');
    return saved ? parseInt(saved) : 60;
  });

  const [inactiveNodeCooldownHours, setInactiveNodeCooldownHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('inactiveNodeCooldownHours');
    return saved ? parseInt(saved) : 24;
  });

  const [tracerouteIntervalMinutes, setTracerouteIntervalMinutesState] = useState<number>(() => {
    const saved = localStorage.getItem('tracerouteIntervalMinutes');
    return saved ? parseInt(saved) : 0;
  });

  const [remoteLocalStatsIntervalMinutes, setRemoteLocalStatsIntervalMinutesState] = useState<number>(() => {
    const saved = localStorage.getItem('remoteLocalStatsIntervalMinutes');
    return saved ? parseInt(saved) : 0;
  });

  const [temperatureUnit, setTemperatureUnitState] = useState<TemperatureUnit>(() => {
    const saved = localStorage.getItem('temperatureUnit');
    return (saved === 'F' ? 'F' : 'C') as TemperatureUnit;
  });

  const [distanceUnit, setDistanceUnitState] = useState<DistanceUnit>(() => {
    const saved = localStorage.getItem('distanceUnit');
    return (saved === 'mi' ? 'mi' : 'km') as DistanceUnit;
  });

  const [positionHistoryLineStyle, setPositionHistoryLineStyleState] = useState<PositionHistoryLineStyle>(() => {
    const saved = localStorage.getItem('positionHistoryLineStyle');
    return (saved === 'linear' ? 'linear' : 'spline') as PositionHistoryLineStyle;
  });

  const [telemetryVisualizationHours, setTelemetryVisualizationHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('telemetryVisualizationHours');
    return saved ? parseInt(saved) : 24;
  });

  const [favoriteTelemetryStorageDays, setFavoriteTelemetryStorageDaysState] = useState<number>(() => {
    const saved = localStorage.getItem('favoriteTelemetryStorageDays');
    return saved ? parseInt(saved) : 7;
  });

  const [preferredSortField, setPreferredSortFieldState] = useState<SortField>(() => {
    const saved = localStorage.getItem('preferredSortField');
    return (saved as SortField) || 'longName';
  });

  const [preferredSortDirection, setPreferredSortDirectionState] = useState<SortDirection>(() => {
    const saved = localStorage.getItem('preferredSortDirection');
    return (saved === 'desc' ? 'desc' : 'asc') as SortDirection;
  });

  const [preferredDashboardSortOption, setPreferredDashboardSortOptionState] = useState<DashboardSortOption>(() => {
    const saved = localStorage.getItem('preferredDashboardSortOption');
    const validOptions: DashboardSortOption[] = ['custom', 'node-asc', 'node-desc', 'type-asc', 'type-desc'];
    return (saved && validOptions.includes(saved as DashboardSortOption) ? saved : 'custom') as DashboardSortOption;
  });

  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(() => {
    const saved = localStorage.getItem('timeFormat');
    return (saved === '12' || saved === '24' ? saved : '24') as TimeFormat;
  });

  const [dateFormat, setDateFormatState] = useState<DateFormat>(() => {
    const saved = localStorage.getItem('dateFormat');
    if (saved === 'DD/MM/YYYY' || saved === 'YYYY-MM-DD') {
      return saved as DateFormat;
    }
    return 'MM/DD/YYYY';
  });

  const [mapTilesetLight, setMapTilesetLightState] = useState<TilesetId>(initialMapTilesets.light);
  const [mapTilesetDark, setMapTilesetDarkState] = useState<TilesetId>(initialMapTilesets.dark);

  const [mapPinStyle, setMapPinStyleState] = useState<MapPinStyle>(() => {
    const saved = localStorage.getItem('mapPinStyle');
    return (saved === 'official' ? 'official' : 'meshmonitor') as MapPinStyle;
  });

  const [iconStyle, setIconStyleState] = useState<IconStyle>(() => {
    const saved = localStorage.getItem('iconStyle');
    return (saved === 'emoji' ? 'emoji' : 'lucide') as IconStyle;
  });

  const [neighborInfoMinZoom, setNeighborInfoMinZoomState] = useState<number>(() => {
    const saved = localStorage.getItem('neighborInfoMinZoom');
    return saved ? parseInt(saved, 10) : 12;
  });

  const [defaultMapCenterLat, setDefaultMapCenterLatState] = useState<number | null>(() => {
    const saved = localStorage.getItem('defaultMapCenterLat');
    return saved ? parseFloat(saved) : null;
  });
  const [defaultMapCenterLon, setDefaultMapCenterLonState] = useState<number | null>(() => {
    const saved = localStorage.getItem('defaultMapCenterLon');
    return saved ? parseFloat(saved) : null;
  });
  const [defaultMapCenterZoom, setDefaultMapCenterZoomState] = useState<number | null>(() => {
    const saved = localStorage.getItem('defaultMapCenterZoom');
    return saved ? parseInt(saved, 10) : null;
  });

  const [mapCenterTargetZoom, setMapCenterTargetZoomState] = useState<number>(() => {
    const saved = localStorage.getItem('mapCenterTargetZoom');
    return saved ? parseInt(saved, 10) : DEFAULT_TARGET_ZOOM;
  });

  // Default landing page when visiting root URL: 'unified' or a sourceId UUID.
  const [defaultLandingPage, setDefaultLandingPageState] = useState<string>(() => {
    return localStorage.getItem('defaultLandingPage') || 'unified';
  });

  const [theme, setThemeState] = useState<Theme>(() => {
    return initialThemePreferences.effectiveTheme;
  });

  const [appearanceMode, setAppearanceModeState] = useState<AppearanceMode>(() => {
    return initialThemePreferences.appearanceMode;
  });

  const [darkTheme, setDarkThemeState] = useState<Theme>(() => {
    return initialThemePreferences.darkTheme;
  });

  const [lightTheme, setLightThemeState] = useState<Theme>(() => {
    return initialThemePreferences.lightTheme;
  });

  const activeMapTilesetMode = React.useMemo(
    () => getActiveAppearanceMode(appearanceMode, systemIsDark),
    [appearanceMode, systemIsDark],
  );

  const mapTileset = activeMapTilesetMode === 'dark' ? mapTilesetDark : mapTilesetLight;

  const [language, setLanguageState] = useState<string>(() => {
    const saved = localStorage.getItem('language');
    return saved || 'en';
  });

  // Solar monitoring settings are database-only, not persisted in localStorage
  const [solarMonitoringEnabled, setSolarMonitoringEnabledState] = useState<boolean>(false);
  const [solarMonitoringLatitude, setSolarMonitoringLatitudeState] = useState<number>(0);
  const [solarMonitoringLongitude, setSolarMonitoringLongitudeState] = useState<number>(0);
  const [solarMonitoringAzimuth, setSolarMonitoringAzimuthState] = useState<number>(0);
  const [solarMonitoringDeclination, setSolarMonitoringDeclinationState] = useState<number>(30);

  // Audio notification setting - localStorage only
  const [enableAudioNotifications, setEnableAudioNotificationsState] = useState<boolean>(() => {
    const saved = localStorage.getItem('enableAudioNotifications');
    // Default to true for backward compatibility
    return saved === null ? true : saved === 'true';
  });

  // Link preview setting - server-backed (global). Defaults to true to preserve
  // the previous always-on behavior; loaded from the server in loadServerSettings.
  const [linkPreviewsEnabled, setLinkPreviewsEnabledState] = useState<boolean>(true);

  // Discard invalid GPS positions on ingest — default true (discard = historical
  // behavior); loaded from the server in loadServerSettings.
  const [discardInvalidPositions, setDiscardInvalidPositionsState] = useState<boolean>(true);

  // Discourage search-engine / LLM indexing (issue #4202) — server-backed
  // (global). Defaults to false (opt-in); loaded from the server in
  // loadServerSettings.
  const [noIndexEnabled, setNoIndexEnabledState] = useState<boolean>(false);

  // MeshCore automated-channel-send auto-retry (issue #3979) - server-backed
  // (global). Defaults to false (opt-in); loaded from the server in
  // loadServerSettings.
  const [meshcoreChannelRetryEnabled, setMeshcoreChannelRetryEnabledState] = useState<boolean>(false);

  // Node dimming settings - localStorage only
  const [nodeDimmingEnabled, setNodeDimmingEnabledState] = useState<boolean>(() => {
    const saved = localStorage.getItem('nodeDimmingEnabled');
    return saved === 'true';
  });

  const [nodeDimmingStartHours, setNodeDimmingStartHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('nodeDimmingStartHours');
    return saved ? parseFloat(saved) : 1;
  });

  const [nodeDimmingMinOpacity, setNodeDimmingMinOpacityState] = useState<number>(() => {
    const saved = localStorage.getItem('nodeDimmingMinOpacity');
    return saved ? parseFloat(saved) : 0.3;
  });

  const [nodeHopsCalculation, setNodeHopsCalculationState] = useState<NodeHopsCalculation>(() => {
    const saved = localStorage.getItem('nodeHopsCalculation');
    return (saved === 'traceroute' || saved === 'messages') ? saved : 'nodeinfo';
  });

  const [temporaryTileset, setTemporaryTileset] = useState<TilesetId | null>(null);

  // Tapback emojis state (database-only, defaults to built-in emojis)
  const [tapbackEmojis, setTapbackEmojisState] = useState<TapbackEmoji[]>(DEFAULT_TAPBACK_EMOJIS);

  // Per-channel and per-DM mute state (server-side, fetched from /api/push/preferences)
  const [mutedChannels, setMutedChannels] = useState<MutedChannel[]>([]);
  const [mutedDMs, setMutedDMs] = useState<MutedDM[]>([]);

  // Custom themes state
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const [isLoadingThemes, setIsLoadingThemes] = useState(false);

  // Custom tilesets state (database-only, not persisted in localStorage)
  const [customTilesets, setCustomTilesets] = useState<CustomTileset[]>([]);

  const overlayScheme = React.useMemo<OverlayScheme>(() => {
    const customTileset = customTilesets.find(ct => `custom-${ct.id}` === mapTileset);
    return getSchemeForTileset(mapTileset, customTileset?.overlayScheme);
  }, [mapTileset, customTilesets]);

  const overlayColors = React.useMemo(() => getOverlayColors(overlayScheme), [overlayScheme]);

  const setMaxNodeAgeHours = React.useCallback((value: number) => {
    setMaxNodeAgeHoursState(value);
    localStorage.setItem('maxNodeAgeHours', value.toString());
    setActiveWindowHours(value); // #4240: keep the transport-decay mirror in sync
  }, []);

  const setInactiveNodeThresholdHours = React.useCallback((value: number) => {
    setInactiveNodeThresholdHoursState(value);
    localStorage.setItem('inactiveNodeThresholdHours', value.toString());
  }, []);

  const setInactiveNodeCheckIntervalMinutes = React.useCallback((value: number) => {
    setInactiveNodeCheckIntervalMinutesState(value);
    localStorage.setItem('inactiveNodeCheckIntervalMinutes', value.toString());
  }, []);

  const setInactiveNodeCooldownHours = React.useCallback((value: number) => {
    setInactiveNodeCooldownHoursState(value);
    localStorage.setItem('inactiveNodeCooldownHours', value.toString());
  }, []);

  const setTracerouteIntervalMinutes = React.useCallback(async (value: number) => {
    setTracerouteIntervalMinutesState(value);
    localStorage.setItem('tracerouteIntervalMinutes', value.toString());

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
        console.log('[Settings] ✓ CSRF token added to traceroute interval request');
      } else {
        console.error('[Settings] ✗ NO CSRF TOKEN - Request may fail!');
      }

      await fetch(`${baseUrl}/api/settings/traceroute-interval`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ intervalMinutes: value })
      });
    } catch (error) {
      logger.error('Error updating traceroute interval:', error);
    }
  }, [baseUrl, getCsrfToken]);

  const setRemoteLocalStatsIntervalMinutes = React.useCallback(async (value: number) => {
    setRemoteLocalStatsIntervalMinutesState(value);
    localStorage.setItem('remoteLocalStatsIntervalMinutes', value.toString());

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      await fetch(`${baseUrl}/api/settings/remote-localstats-interval`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ intervalMinutes: value })
      });
    } catch (error) {
      logger.error('Error updating remote LocalStats interval:', error);
    }
  }, [baseUrl, getCsrfToken]);

  const setTemperatureUnit = React.useCallback((unit: TemperatureUnit) => {
    setTemperatureUnitState(unit);
    localStorage.setItem('temperatureUnit', unit);
  }, []);

  const setDistanceUnit = React.useCallback((unit: DistanceUnit) => {
    setDistanceUnitState(unit);
    localStorage.setItem('distanceUnit', unit);
  }, []);

  const setPositionHistoryLineStyle = React.useCallback((style: PositionHistoryLineStyle) => {
    setPositionHistoryLineStyleState(style);
    localStorage.setItem('positionHistoryLineStyle', style);
  }, []);

  const setTelemetryVisualizationHours = React.useCallback((hours: number) => {
    setTelemetryVisualizationHoursState(hours);
    localStorage.setItem('telemetryVisualizationHours', hours.toString());
  }, []);

  const setFavoriteTelemetryStorageDays = React.useCallback((days: number) => {
    setFavoriteTelemetryStorageDaysState(days);
    localStorage.setItem('favoriteTelemetryStorageDays', days.toString());
  }, []);

  const setPreferredSortField = React.useCallback((field: SortField) => {
    setPreferredSortFieldState(field);
    localStorage.setItem('preferredSortField', field);
  }, []);

  const setPreferredSortDirection = React.useCallback((direction: SortDirection) => {
    setPreferredSortDirectionState(direction);
    localStorage.setItem('preferredSortDirection', direction);
  }, []);

  const setPreferredDashboardSortOption = React.useCallback((option: DashboardSortOption) => {
    setPreferredDashboardSortOptionState(option);
    localStorage.setItem('preferredDashboardSortOption', option);
  }, []);

  const setTimeFormat = React.useCallback((format: TimeFormat) => {
    setTimeFormatState(format);
    localStorage.setItem('timeFormat', format);
  }, []);

  const setDateFormat = React.useCallback((format: DateFormat) => {
    setDateFormatState(format);
    localStorage.setItem('dateFormat', format);
  }, []);

  const setMapTilesets = React.useCallback(async (light: TilesetId, dark: TilesetId) => {
    setMapTilesetLightState(light);
    setMapTilesetDarkState(dark);
    localStorage.setItem('mapTilesetLight', light);
    localStorage.setItem('mapTilesetDark', dark);

    const effective = getEffectiveTileset(appearanceMode, dark, light, systemIsDark);
    localStorage.setItem('mapTileset', effective);

    try {
      const csrfToken = getCsrfToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/user/map-preferences`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          mapTileset: effective,
          mapTilesetLight: light,
          mapTilesetDark: dark,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.debug('Failed to save per-theme map tilesets:', errorText);
      }
    } catch (error) {
      logger.debug('Failed to save per-theme map tilesets:', error);
    }
  }, [appearanceMode, systemIsDark, baseUrl, getCsrfToken]);

  const setMapTileset = React.useCallback((tilesetId: TilesetId) => {
    if (activeMapTilesetMode === 'dark') {
      void setMapTilesets(mapTilesetLight, tilesetId);
    } else {
      void setMapTilesets(tilesetId, mapTilesetDark);
    }
  }, [activeMapTilesetMode, mapTilesetLight, mapTilesetDark, setMapTilesets]);

  const setMapPinStyle = React.useCallback((style: MapPinStyle) => {
    setMapPinStyleState(style);
    localStorage.setItem('mapPinStyle', style);
  }, []);

  const setIconStyle = React.useCallback((style: IconStyle) => {
    setIconStyleState(style);
    localStorage.setItem('iconStyle', style);
  }, []);

  const setNeighborInfoMinZoom = React.useCallback((zoom: number) => {
    setNeighborInfoMinZoomState(zoom);
    localStorage.setItem('neighborInfoMinZoom', String(zoom));
  }, []);

  const setDefaultMapCenterLat = React.useCallback((lat: number | null) => {
    setDefaultMapCenterLatState(lat);
    if (lat !== null) {
      localStorage.setItem('defaultMapCenterLat', String(lat));
    } else {
      localStorage.removeItem('defaultMapCenterLat');
    }
  }, []);
  const setDefaultMapCenterLon = React.useCallback((lon: number | null) => {
    setDefaultMapCenterLonState(lon);
    if (lon !== null) {
      localStorage.setItem('defaultMapCenterLon', String(lon));
    } else {
      localStorage.removeItem('defaultMapCenterLon');
    }
  }, []);
  const setDefaultMapCenterZoom = React.useCallback((zoom: number | null) => {
    setDefaultMapCenterZoomState(zoom);
    if (zoom !== null) {
      localStorage.setItem('defaultMapCenterZoom', String(zoom));
    } else {
      localStorage.removeItem('defaultMapCenterZoom');
    }
  }, []);

  const setMapCenterTargetZoom = React.useCallback((zoom: number) => {
    setMapCenterTargetZoomState(zoom);
    localStorage.setItem('mapCenterTargetZoom', String(zoom));
  }, []);

  const setDefaultLandingPage = React.useCallback((value: string) => {
    const normalized = value || 'unified';
    setDefaultLandingPageState(normalized);
    localStorage.setItem('defaultLandingPage', normalized);
  }, []);

  /**
   * Load custom themes from the API
   */
  const loadCustomThemes = React.useCallback(async () => {
    setIsLoadingThemes(true);
    try {
      logger.debug('🎨 Loading custom themes from API...');
      const response = await fetch(`${baseUrl}/api/themes`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        setCustomThemes(data.themes || []);
        logger.debug(`✅ Loaded ${data.themes?.length || 0} custom themes`);
      } else {
        logger.error(`❌ Failed to load custom themes: ${response.status}`);
      }
    } catch (error) {
      logger.error('Failed to load custom themes:', error);
    } finally {
      setIsLoadingThemes(false);
    }
  }, [baseUrl]);

  /**
   * Apply CSS variables for a custom theme
   */
  const applyCustomThemeCSS = React.useCallback((themeSlug: string) => {
    logger.debug(`🎨 applyCustomThemeCSS called with: ${themeSlug}`);
    logger.debug(`📋 Available custom themes (${customThemes.length}):`, customThemes.map(t => t.slug));

    const customTheme = customThemes.find(t => t.slug === themeSlug);

    if (!customTheme) {
      logger.warn(`⚠️  Custom theme not found: ${themeSlug}`);
      logger.warn(`📋 Available slugs:`, customThemes.map(t => t.slug));
      return;
    }

    logger.debug(`✅ Found custom theme:`, {
      name: customTheme.name,
      slug: customTheme.slug,
      definitionLength: customTheme.definition.length
    });

    try {
      const definition = JSON.parse(customTheme.definition);
      logger.debug(`📦 Parsed definition:`, definition);

      const root = document.documentElement;
      logger.debug(`🎯 Applying ${Object.keys(definition).length} CSS variables to root element`);

      // Clear optional chat bubble vars so stale values from a previous custom theme don't persist
      for (const optColor of OPTIONAL_THEME_COLORS) {
        root.style.removeProperty(`--ctp-${optColor}`);
      }

      // Apply each color variable to the root element with ctp- prefix
      Object.entries(definition).forEach(([key, value]) => {
        const cssVarName = `--ctp-${key}`;
        logger.debug(`  Setting ${cssVarName} = ${value}`);
        root.style.setProperty(cssVarName, value as string);
      });

      logger.debug(`✅ Applied custom theme: ${customTheme.name} (${themeSlug})`);
      logger.debug(`🔍 Verification - checking a few variables:`);
      logger.debug(`  --base: ${root.style.getPropertyValue('--base')}`);
      logger.debug(`  --text: ${root.style.getPropertyValue('--text')}`);
      logger.debug(`  --blue: ${root.style.getPropertyValue('--blue')}`);
    } catch (error) {
      logger.error(`Failed to apply custom theme ${themeSlug}:`, error);
    }
  }, [customThemes]);

  const applyTheme = React.useCallback((newTheme: Theme) => {
    logger.debug(`🔄 applyTheme called with: ${newTheme}`);
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);

    // Check if this is a built-in or custom theme
    const isBuiltIn = BUILT_IN_THEMES.includes(newTheme as BuiltInTheme);
    logger.debug(`📝 Is built-in theme: ${isBuiltIn}`);

    if (isBuiltIn) {
      // Built-in theme: use data-theme attribute
      document.documentElement.setAttribute('data-theme', newTheme);
      // Remove optional chat bubble vars from any previous custom theme
      for (const optColor of OPTIONAL_THEME_COLORS) {
        document.documentElement.style.removeProperty(`--ctp-${optColor}`);
      }
      logger.debug(`✅ Applied built-in theme: ${newTheme}`);
    } else {
      // Custom theme: apply CSS variables dynamically
      // Set a generic data-theme attribute for base styles
      logger.debug(`🎨 Setting data-theme="custom" and applying custom CSS`);
      document.documentElement.setAttribute('data-theme', 'custom');
      logger.debug(`📋 Current customThemes array length: ${customThemes.length}`);
      // Apply the custom theme CSS
      applyCustomThemeCSS(newTheme);
    }
  }, [applyCustomThemeCSS]);

  const applyAppearancePreferences = React.useCallback((
    mode: AppearanceMode,
    nextDarkTheme: Theme,
    nextLightTheme: Theme,
    nextSystemIsDark = systemIsDark
  ) => {
    applyTheme(getEffectiveTheme(mode, nextDarkTheme, nextLightTheme, nextSystemIsDark));
  }, [applyTheme, systemIsDark]);

  const setAppearanceMode = React.useCallback((mode: AppearanceMode) => {
    setAppearanceModeState(mode);
    localStorage.setItem('appearanceMode', mode);
  }, []);

  const setDarkTheme = React.useCallback((newTheme: Theme) => {
    setDarkThemeState(newTheme);
    localStorage.setItem('darkTheme', newTheme);
  }, []);

  const setLightTheme = React.useCallback((newTheme: Theme) => {
    setLightThemeState(newTheme);
    localStorage.setItem('lightTheme', newTheme);
  }, []);

  const setTheme = React.useCallback((newTheme: Theme) => {
    setAppearanceModeState('dark');
    setDarkThemeState(newTheme);
    setLightThemeState(newTheme);
    localStorage.setItem('appearanceMode', 'dark');
    localStorage.setItem('darkTheme', newTheme);
    localStorage.setItem('lightTheme', newTheme);
    applyTheme(newTheme);
  }, [applyTheme]);

  const setLanguage = React.useCallback(async (lang: string) => {
    setLanguageState(lang);
    localStorage.setItem('language', lang);
    void i18n.changeLanguage(lang);

    // Persist to database for logged-in users (fire and forget)
    try {
      const csrfToken = getCsrfToken();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ language: lang })
      });
      logger.debug(`✅ Language preference saved to server: ${lang}`);
    } catch (error) {
      logger.debug('Failed to save language preference to server:', error);
    }
  }, [baseUrl, getCsrfToken]);

  // Link preview setter updates state only - value is persisted server-side
  const setLinkPreviewsEnabled = React.useCallback((enabled: boolean) => {
    setLinkPreviewsEnabledState(enabled);
  }, []);

  // Discard-invalid-positions setter updates state only - persisted server-side.
  // Also sync the module mirror SYNCHRONOUSLY (#4157) so the map display filters
  // (pure utils that can't read context) honor the toggle on the very next render
  // — an effect would lag a frame, leaving (0,0) hidden until the next data poll.
  const setDiscardInvalidPositions = React.useCallback((enabled: boolean) => {
    setDiscardInvalidPositionsDisplay(enabled);
    setDiscardInvalidPositionsState(enabled);
  }, []);

  // No-index setter updates state only - value is persisted server-side
  const setNoIndexEnabled = React.useCallback((enabled: boolean) => {
    setNoIndexEnabledState(enabled);
  }, []);

  // MeshCore channel-retry setter updates state only - persisted server-side
  const setMeshcoreChannelRetryEnabled = React.useCallback((enabled: boolean) => {
    setMeshcoreChannelRetryEnabledState(enabled);
  }, []);

  // Solar monitoring setters update state only - values are persisted server-side
  const setSolarMonitoringEnabled = React.useCallback((enabled: boolean) => {
    setSolarMonitoringEnabledState(enabled);
  }, []);

  const setSolarMonitoringLatitude = React.useCallback((latitude: number) => {
    setSolarMonitoringLatitudeState(latitude);
  }, []);

  const setSolarMonitoringLongitude = React.useCallback((longitude: number) => {
    setSolarMonitoringLongitudeState(longitude);
  }, []);

  const setSolarMonitoringAzimuth = React.useCallback((azimuth: number) => {
    setSolarMonitoringAzimuthState(azimuth);
  }, []);

  const setSolarMonitoringDeclination = React.useCallback((declination: number) => {
    setSolarMonitoringDeclinationState(declination);
  }, []);

  const setEnableAudioNotifications = React.useCallback((enabled: boolean) => {
    setEnableAudioNotificationsState(enabled);
    localStorage.setItem('enableAudioNotifications', enabled.toString());
  }, []);

  const setNodeDimmingEnabled = React.useCallback((enabled: boolean) => {
    setNodeDimmingEnabledState(enabled);
    localStorage.setItem('nodeDimmingEnabled', enabled.toString());
  }, []);

  const setNodeDimmingStartHours = React.useCallback((hours: number) => {
    setNodeDimmingStartHoursState(hours);
    localStorage.setItem('nodeDimmingStartHours', hours.toString());
  }, []);

  const setNodeDimmingMinOpacity = React.useCallback((opacity: number) => {
    setNodeDimmingMinOpacityState(opacity);
    localStorage.setItem('nodeDimmingMinOpacity', opacity.toString());
  }, []);

  const setNodeHopsCalculation = React.useCallback((calculation: NodeHopsCalculation) => {
    setNodeHopsCalculationState(calculation);
    localStorage.setItem('nodeHopsCalculation', calculation);
  }, []);

  /**
   * Set tapback emojis and save to database
   */
  // Internal cache of the full notification preferences object, needed so mute
  // updates can POST the complete preferences without losing other fields.
  const [notificationPrefsCache, setNotificationPrefsCache] = React.useState<Record<string, unknown> | null>(null);

  // Load mute preferences from /api/push/preferences on mount.
  // Runs after authentication is established (same lifecycle as map preferences).
  const loadMutePreferences = useCallback(async () => {
    try {
      const prefs = await api.get<Record<string, unknown>>('/api/push/preferences');
      setNotificationPrefsCache(prefs);
      if (Array.isArray(prefs.mutedChannels)) {
        setMutedChannels(prefs.mutedChannels as MutedChannel[]);
      }
      if (Array.isArray(prefs.mutedDMs)) {
        setMutedDMs(prefs.mutedDMs as MutedDM[]);
      }
    } catch (error) {
      logger.debug('Could not load notification preferences (mute state):', error);
    }
  }, []);

  /** Save mutedChannels/mutedDMs back to the server, merging with cached prefs. */
  const saveMutePreferences = useCallback(async (
    newMutedChannels: MutedChannel[],
    newMutedDMs: MutedDM[]
  ) => {
    const base = notificationPrefsCache ?? {};
    await api.post('/api/push/preferences', {
      enableWebPush: true,
      enableApprise: false,
      enabledChannels: [],
      enableDirectMessages: true,
      notifyOnEmoji: true,
      notifyOnMqtt: true,
      notifyOnNewNode: true,
      notifyOnTraceroute: true,
      notifyOnInactiveNode: false,
      notifyOnServerEvents: false,
      prefixWithNodeName: false,
      monitoredNodes: [],
      whitelist: [],
      blacklist: [],
      appriseUrls: [],
      ...base,
      mutedChannels: newMutedChannels,
      mutedDMs: newMutedDMs,
    });
    setNotificationPrefsCache(prev => ({
      ...(prev ?? base),
      mutedChannels: newMutedChannels,
      mutedDMs: newMutedDMs,
    }));
  }, [notificationPrefsCache]);

  const muteChannel = useCallback(async (channelId: number, muteUntil: number | null) => {
    const next = [
      ...mutedChannels.filter(r => r.channelId !== channelId),
      { channelId, muteUntil },
    ];
    setMutedChannels(next);
    await saveMutePreferences(next, mutedDMs);
  }, [mutedChannels, mutedDMs, saveMutePreferences]);

  const unmuteChannel = useCallback(async (channelId: number) => {
    const next = mutedChannels.filter(r => r.channelId !== channelId);
    setMutedChannels(next);
    await saveMutePreferences(next, mutedDMs);
  }, [mutedChannels, mutedDMs, saveMutePreferences]);

  const muteDM = useCallback(async (nodeUuid: string, muteUntil: number | null) => {
    const next = [
      ...mutedDMs.filter(r => r.nodeUuid !== nodeUuid),
      { nodeUuid, muteUntil },
    ];
    setMutedDMs(next);
    await saveMutePreferences(mutedChannels, next);
  }, [mutedChannels, mutedDMs, saveMutePreferences]);

  const unmuteDM = useCallback(async (nodeUuid: string) => {
    const next = mutedDMs.filter(r => r.nodeUuid !== nodeUuid);
    setMutedDMs(next);
    await saveMutePreferences(mutedChannels, next);
  }, [mutedChannels, mutedDMs, saveMutePreferences]);

  const isChannelMuted = useCallback((channelId: number): boolean => {
    const rule = mutedChannels.find(r => r.channelId === channelId);
    return !!rule && (rule.muteUntil === null || rule.muteUntil > Date.now());
  }, [mutedChannels]);

  const isDMMuted = useCallback((nodeUuid: string): boolean => {
    const rule = mutedDMs.find(r => r.nodeUuid === nodeUuid);
    return !!rule && (rule.muteUntil === null || rule.muteUntil > Date.now());
  }, [mutedDMs]);

  const setTapbackEmojis = React.useCallback(async (emojis: TapbackEmoji[]) => {
    setTapbackEmojisState(emojis);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          customTapbackEmojis: JSON.stringify(emojis)
        })
      });

      logger.debug(`✅ Tapback emojis saved (${emojis.length} emojis)`);
    } catch (error) {
      logger.error('Failed to save tapback emojis:', error);
      throw error;
    }
  }, [baseUrl, getCsrfToken]);

  /**
   * Add a new custom tileset
   */
  const addCustomTileset = React.useCallback(async (tileset: Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const newTileset: CustomTileset = {
      ...tileset,
      id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: now,
      updatedAt: now
    };

    const updated = [...customTilesets, newTileset];
    setCustomTilesets(updated);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          customTilesets: JSON.stringify(updated)
        })
      });

      logger.debug('✅ Custom tileset added:', newTileset.name);
    } catch (error) {
      logger.error('Failed to save custom tileset:', error);
      // Revert on error
      setCustomTilesets(customTilesets);
      throw error;
    }
  }, [customTilesets, baseUrl, getCsrfToken]);

  /**
   * Update an existing custom tileset
   */
  const updateCustomTileset = React.useCallback(async (id: string, updates: Partial<Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>>) => {
    const updated = customTilesets.map(ct =>
      ct.id === id ? { ...ct, ...updates, updatedAt: Date.now() } : ct
    );
    setCustomTilesets(updated);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          customTilesets: JSON.stringify(updated)
        })
      });

      logger.debug('✅ Custom tileset updated:', id);
    } catch (error) {
      logger.error('Failed to update custom tileset:', error);
      // Revert on error
      setCustomTilesets(customTilesets);
      throw error;
    }
  }, [customTilesets, baseUrl, getCsrfToken]);

  /**
   * Delete a custom tileset
   */
  const deleteCustomTileset = React.useCallback(async (id: string) => {
    const updated = customTilesets.filter(ct => ct.id !== id);
    setCustomTilesets(updated);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          customTilesets: JSON.stringify(updated)
        })
      });

      logger.debug('✅ Custom tileset deleted:', id);
    } catch (error) {
      logger.error('Failed to delete custom tileset:', error);
      // Revert on error
      setCustomTilesets(customTilesets);
      throw error;
    }
  }, [customTilesets, baseUrl, getCsrfToken]);

  // Load settings from server on mount
  React.useEffect(() => {
    const loadServerSettings = async () => {
      try {
        logger.debug('🔄 Loading settings from server...');
        const response = await fetch(`${baseUrl}/api/settings`, {
          credentials: 'include'
        });

        if (response.ok) {
          const settings = await response.json();
          logger.debug('📥 Received settings from server:', settings);

          // Update state with server settings (server takes precedence over localStorage)
          if (settings.maxNodeAgeHours) {
            const value = parseInt(settings.maxNodeAgeHours);
            if (!isNaN(value)) {
              setMaxNodeAgeHoursState(value);
              localStorage.setItem('maxNodeAgeHours', value.toString());
              setActiveWindowHours(value); // #4240: server value wins for decay too
            }
          }

          if (settings.inactiveNodeThresholdHours) {
            const value = parseInt(settings.inactiveNodeThresholdHours);
            if (!isNaN(value) && value > 0) {
              setInactiveNodeThresholdHoursState(value);
              localStorage.setItem('inactiveNodeThresholdHours', value.toString());
            }
          }

          if (settings.inactiveNodeCheckIntervalMinutes) {
            const value = parseInt(settings.inactiveNodeCheckIntervalMinutes);
            if (!isNaN(value) && value > 0) {
              setInactiveNodeCheckIntervalMinutesState(value);
              localStorage.setItem('inactiveNodeCheckIntervalMinutes', value.toString());
            }
          }

          if (settings.inactiveNodeCooldownHours) {
            const value = parseInt(settings.inactiveNodeCooldownHours);
            if (!isNaN(value) && value > 0) {
              setInactiveNodeCooldownHoursState(value);
              localStorage.setItem('inactiveNodeCooldownHours', value.toString());
            }
          }

          if (settings.temperatureUnit) {
            setTemperatureUnitState(settings.temperatureUnit as TemperatureUnit);
            localStorage.setItem('temperatureUnit', settings.temperatureUnit);
          }

          if (settings.distanceUnit) {
            setDistanceUnitState(settings.distanceUnit as DistanceUnit);
            localStorage.setItem('distanceUnit', settings.distanceUnit);
          }

          if (settings.positionHistoryLineStyle) {
            setPositionHistoryLineStyleState(settings.positionHistoryLineStyle as PositionHistoryLineStyle);
            localStorage.setItem('positionHistoryLineStyle', settings.positionHistoryLineStyle);
          }

          if (settings.telemetryVisualizationHours) {
            const value = parseInt(settings.telemetryVisualizationHours);
            if (!isNaN(value)) {
              setTelemetryVisualizationHoursState(value);
              localStorage.setItem('telemetryVisualizationHours', value.toString());
            }
          }

          if (settings.favoriteTelemetryStorageDays) {
            const value = parseInt(settings.favoriteTelemetryStorageDays);
            if (!isNaN(value)) {
              setFavoriteTelemetryStorageDaysState(value);
              localStorage.setItem('favoriteTelemetryStorageDays', value.toString());
            }
          }

          if (settings.tracerouteIntervalMinutes !== undefined) {
            const value = parseInt(settings.tracerouteIntervalMinutes);
            if (!isNaN(value)) {
              setTracerouteIntervalMinutesState(value);
              localStorage.setItem('tracerouteIntervalMinutes', value.toString());
            }
          }

          if (settings.remoteLocalStatsIntervalMinutes !== undefined) {
            const value = parseInt(settings.remoteLocalStatsIntervalMinutes);
            if (!isNaN(value)) {
              setRemoteLocalStatsIntervalMinutesState(value);
              localStorage.setItem('remoteLocalStatsIntervalMinutes', value.toString());
            }
          }

          if (settings.preferredSortField) {
            setPreferredSortFieldState(settings.preferredSortField as SortField);
            localStorage.setItem('preferredSortField', settings.preferredSortField);
          }

          if (settings.preferredSortDirection) {
            setPreferredSortDirectionState(settings.preferredSortDirection as SortDirection);
            localStorage.setItem('preferredSortDirection', settings.preferredSortDirection);
          }

          if (settings.preferredDashboardSortOption) {
            const validOptions: DashboardSortOption[] = ['custom', 'node-asc', 'node-desc', 'type-asc', 'type-desc'];
            if (validOptions.includes(settings.preferredDashboardSortOption as DashboardSortOption)) {
              setPreferredDashboardSortOptionState(settings.preferredDashboardSortOption as DashboardSortOption);
              localStorage.setItem('preferredDashboardSortOption', settings.preferredDashboardSortOption);
            }
          }

          if (settings.timeFormat) {
            setTimeFormatState(settings.timeFormat as TimeFormat);
            localStorage.setItem('timeFormat', settings.timeFormat);
          }

          if (settings.dateFormat) {
            setDateFormatState(settings.dateFormat as DateFormat);
            localStorage.setItem('dateFormat', settings.dateFormat);
          }

          if (settings.mapTileset || settings.mapTilesetLight || settings.mapTilesetDark) {
            const legacyTilesets = resolveLegacyMapTilesets(settings.mapTileset);
            const nextLight = settings.mapTilesetLight || legacyTilesets.light;
            const nextDark = settings.mapTilesetDark || legacyTilesets.dark;
            setMapTilesetLightState(nextLight);
            setMapTilesetDarkState(nextDark);
            localStorage.setItem('mapTilesetLight', nextLight);
            localStorage.setItem('mapTilesetDark', nextDark);
          }

          if (settings.mapPinStyle) {
            setMapPinStyleState(settings.mapPinStyle as MapPinStyle);
            localStorage.setItem('mapPinStyle', settings.mapPinStyle);
          }

          if (settings.iconStyle) {
            setIconStyleState(settings.iconStyle as IconStyle);
            localStorage.setItem('iconStyle', settings.iconStyle);
          }

          if (settings.neighborInfoMinZoom !== undefined) {
            const zoom = parseInt(settings.neighborInfoMinZoom, 10);
            if (!isNaN(zoom)) {
              setNeighborInfoMinZoomState(zoom);
              localStorage.setItem('neighborInfoMinZoom', String(zoom));
            }
          }

          if (settings.defaultMapCenterLat !== undefined) {
            const lat = parseFloat(settings.defaultMapCenterLat);
            if (!isNaN(lat) && lat >= -90 && lat <= 90) {
              setDefaultMapCenterLatState(lat);
              localStorage.setItem('defaultMapCenterLat', String(lat));
            } else {
              setDefaultMapCenterLatState(null);
              localStorage.removeItem('defaultMapCenterLat');
            }
          }
          if (settings.defaultMapCenterLon !== undefined) {
            const lon = parseFloat(settings.defaultMapCenterLon);
            if (!isNaN(lon) && lon >= -180 && lon <= 180) {
              setDefaultMapCenterLonState(lon);
              localStorage.setItem('defaultMapCenterLon', String(lon));
            } else {
              setDefaultMapCenterLonState(null);
              localStorage.removeItem('defaultMapCenterLon');
            }
          }
          if (settings.defaultMapCenterZoom !== undefined) {
            const zoom = parseInt(settings.defaultMapCenterZoom, 10);
            if (!isNaN(zoom) && zoom >= 1 && zoom <= 18) {
              setDefaultMapCenterZoomState(zoom);
              localStorage.setItem('defaultMapCenterZoom', String(zoom));
            } else {
              setDefaultMapCenterZoomState(null);
              localStorage.removeItem('defaultMapCenterZoom');
            }
          }

          if (settings.mapCenterTargetZoom !== undefined) {
            const zoom = parseInt(settings.mapCenterTargetZoom, 10);
            if (!isNaN(zoom) && zoom >= 1 && zoom <= 18) {
              setMapCenterTargetZoomState(zoom);
              localStorage.setItem('mapCenterTargetZoom', String(zoom));
            }
          }

          if (typeof settings.defaultLandingPage === 'string' && settings.defaultLandingPage.length > 0) {
            setDefaultLandingPageState(settings.defaultLandingPage);
            localStorage.setItem('defaultLandingPage', settings.defaultLandingPage);
          }

          if (
            typeof settings.theme === 'string' ||
            typeof settings.appearanceMode === 'string' ||
            typeof settings.darkTheme === 'string' ||
            typeof settings.lightTheme === 'string'
          ) {
            const hasNewThemePreferences = (
              isAppearanceMode(settings.appearanceMode) ||
              typeof settings.darkTheme === 'string' ||
              typeof settings.lightTheme === 'string'
            );
            const legacyTheme = typeof settings.theme === 'string' ? settings.theme as Theme : null;
            const nextAppearanceMode: AppearanceMode = isAppearanceMode(settings.appearanceMode)
              ? settings.appearanceMode
              : legacyTheme && legacyTheme !== DEFAULT_DARK_THEME && !hasNewThemePreferences
                ? 'dark'
                : 'system';
            const nextDarkTheme: Theme = typeof settings.darkTheme === 'string'
              ? settings.darkTheme
              : legacyTheme && legacyTheme !== DEFAULT_DARK_THEME && !hasNewThemePreferences
                ? legacyTheme
                : DEFAULT_DARK_THEME;
            const nextLightTheme: Theme = typeof settings.lightTheme === 'string'
              ? settings.lightTheme
              : legacyTheme && legacyTheme !== DEFAULT_DARK_THEME && !hasNewThemePreferences
                ? legacyTheme
                : DEFAULT_LIGHT_THEME;

            setAppearanceModeState(nextAppearanceMode);
            setDarkThemeState(nextDarkTheme);
            setLightThemeState(nextLightTheme);
            localStorage.setItem('appearanceMode', nextAppearanceMode);
            localStorage.setItem('darkTheme', nextDarkTheme);
            localStorage.setItem('lightTheme', nextLightTheme);
          }

          if (settings.language) {
            setLanguageState(settings.language);
            localStorage.setItem('language', settings.language);
            void i18n.changeLanguage(settings.language);
            logger.debug(`🌐 Language loaded from server: ${settings.language}`);
          }

          // Link previews - database-only. Absent key means default (enabled);
          // only an explicit '0'/'false' turns it off.
          if (settings.linkPreviewsEnabled !== undefined) {
            const enabled = !(settings.linkPreviewsEnabled === '0' || settings.linkPreviewsEnabled === 'false');
            setLinkPreviewsEnabledState(enabled);
          }

          // Discard invalid positions - database-only. Absent key means default
          // (enabled = discard); only an explicit '0'/'false' turns it off.
          if (settings.discardInvalidPositions !== undefined) {
            const enabled = !(settings.discardInvalidPositions === '0' || settings.discardInvalidPositions === 'false');
            setDiscardInvalidPositionsDisplay(enabled); // keep the display-filter mirror in sync (#4157)
            setDiscardInvalidPositionsState(enabled);
          }

          // No-index (issue #4202) - database-only. Absent key means default
          // (disabled); only an explicit '1'/'true' turns it on.
          if (settings.noIndexEnabled !== undefined) {
            const enabled = settings.noIndexEnabled === '1' || settings.noIndexEnabled === 'true';
            setNoIndexEnabledState(enabled);
          }

          // MeshCore channel-send auto-retry (#3979) - database-only. Absent key
          // means default (disabled); only an explicit '1'/'true' turns it on.
          if (settings.meshcoreChannelRetryEnabled !== undefined) {
            const enabled = settings.meshcoreChannelRetryEnabled === '1' || settings.meshcoreChannelRetryEnabled === 'true';
            setMeshcoreChannelRetryEnabledState(enabled);
          }

          // Solar monitoring settings - database-only, no localStorage persistence
          if (settings.solarMonitoringEnabled !== undefined) {
            const enabled = settings.solarMonitoringEnabled === '1' || settings.solarMonitoringEnabled === 'true';
            setSolarMonitoringEnabledState(enabled);
          }

          if (settings.solarMonitoringLatitude !== undefined) {
            const latitude = parseFloat(settings.solarMonitoringLatitude);
            if (!isNaN(latitude)) {
              setSolarMonitoringLatitudeState(latitude);
            }
          }

          if (settings.solarMonitoringLongitude !== undefined) {
            const longitude = parseFloat(settings.solarMonitoringLongitude);
            if (!isNaN(longitude)) {
              setSolarMonitoringLongitudeState(longitude);
            }
          }

          if (settings.solarMonitoringAzimuth !== undefined) {
            const azimuth = parseInt(settings.solarMonitoringAzimuth);
            if (!isNaN(azimuth)) {
              setSolarMonitoringAzimuthState(azimuth);
            }
          }

          if (settings.solarMonitoringDeclination !== undefined) {
            const declination = parseInt(settings.solarMonitoringDeclination);
            if (!isNaN(declination)) {
              setSolarMonitoringDeclinationState(declination);
            }
          }

          // Load custom tilesets (database-only, no localStorage)
          if (settings.customTilesets) {
            try {
              const tilesets = JSON.parse(settings.customTilesets);
              if (Array.isArray(tilesets)) {
                setCustomTilesets(tilesets);
                logger.debug(`✅ Loaded ${tilesets.length} custom tilesets`);
              }
            } catch (error) {
              logger.error('Failed to parse custom tilesets:', error);
            }
          }

          // Load custom tapback emojis (database-only, no localStorage)
          if (settings.customTapbackEmojis) {
            try {
              const emojis = JSON.parse(settings.customTapbackEmojis);
              if (Array.isArray(emojis) && emojis.length > 0) {
                setTapbackEmojisState(emojis);
                logger.debug(`✅ Loaded ${emojis.length} custom tapback emojis`);
              }
            } catch (error) {
              logger.error('Failed to parse custom tapback emojis:', error);
            }
          }

          if (settings.nodeHopsCalculation) {
            const valid: NodeHopsCalculation[] = ['nodeinfo', 'traceroute', 'messages'];
            if (valid.includes(settings.nodeHopsCalculation as NodeHopsCalculation)) {
              setNodeHopsCalculationState(settings.nodeHopsCalculation as NodeHopsCalculation);
              localStorage.setItem('nodeHopsCalculation', settings.nodeHopsCalculation);
            }
          }

          if (settings.nodeDimmingEnabled !== undefined) {
            const enabled = settings.nodeDimmingEnabled === '1' || settings.nodeDimmingEnabled === 'true';
            setNodeDimmingEnabledState(enabled);
            localStorage.setItem('nodeDimmingEnabled', enabled.toString());
          }

          if (settings.nodeDimmingStartHours !== undefined) {
            const value = parseFloat(settings.nodeDimmingStartHours);
            if (!isNaN(value) && value > 0) {
              setNodeDimmingStartHoursState(value);
              localStorage.setItem('nodeDimmingStartHours', value.toString());
            }
          }

          if (settings.nodeDimmingMinOpacity !== undefined) {
            const value = parseFloat(settings.nodeDimmingMinOpacity);
            if (!isNaN(value) && value >= 0 && value <= 1) {
              setNodeDimmingMinOpacityState(value);
              localStorage.setItem('nodeDimmingMinOpacity', value.toString());
            }
          }

          logger.debug('✅ Settings loaded from server and applied to state');

          // Load user-specific map preferences (overrides global settings)
          try {
            const prefsResponse = await fetch(`${baseUrl}/api/user/map-preferences`, {
              credentials: 'include'
            });

            if (prefsResponse.ok) {
              const { preferences } = await prefsResponse.json();

              // User preferences override the global per-theme defaults.
              if (preferences && (preferences.mapTileset || preferences.mapTilesetLight || preferences.mapTilesetDark)) {
                const legacyTilesets = resolveLegacyMapTilesets(preferences.mapTileset);
                const nextLight = preferences.mapTilesetLight || legacyTilesets.light;
                const nextDark = preferences.mapTilesetDark || legacyTilesets.dark;
                setMapTilesetLightState(nextLight);
                setMapTilesetDarkState(nextDark);
                localStorage.setItem('mapTilesetLight', nextLight);
                localStorage.setItem('mapTilesetDark', nextDark);
                logger.debug(`✅ Loaded user map tileset preferences: light=${nextLight}, dark=${nextDark}`);
              }
              // If preferences is null (anonymous user), global setting is already loaded
            }
          } catch (error) {
            logger.debug('Failed to load user map preferences:', error);
            // Fall back to global setting (already loaded above)
          }
        } else {
          logger.error(`❌ Failed to fetch settings: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        logger.error('Failed to load settings from server:', error);
        // Fall back to localStorage values (already set in initial state)
      } finally {
        setIsLoading(false);
      }
    };

    void loadServerSettings();
  }, [baseUrl]);

  // Load custom themes on mount
  React.useEffect(() => {
    void loadCustomThemes();
  }, [loadCustomThemes]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemIsDark(event.matches);
    };

    setSystemIsDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  React.useEffect(() => {
    applyAppearancePreferences(appearanceMode, darkTheme, lightTheme, systemIsDark);
  }, [appearanceMode, applyAppearancePreferences, darkTheme, lightTheme, systemIsDark]);

  React.useEffect(() => {
    localStorage.setItem('mapTileset', mapTileset);
  }, [mapTileset]);

  // Load mute preferences on mount (server-side, requires auth)
  React.useEffect(() => {
    void loadMutePreferences();
  }, [loadMutePreferences]);

  // Apply custom theme CSS when themes are loaded or theme changes
  React.useEffect(() => {
    logger.debug(`🔄 useEffect triggered - customThemes: ${customThemes.length}, theme: ${theme}`);
    if (customThemes.length > 0 && theme) {
      const isBuiltIn = BUILT_IN_THEMES.includes(theme as BuiltInTheme);
      logger.debug(`📝 useEffect - Is built-in: ${isBuiltIn}`);

      if (!isBuiltIn) {
        // Apply custom theme
        logger.debug(`🎨 useEffect - Applying custom theme: ${theme}`);
        applyCustomThemeCSS(theme);
      }
    }
  }, [customThemes, theme, applyCustomThemeCSS]);

  const value: SettingsContextType = React.useMemo(() => ({
    maxNodeAgeHours,
    inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours,
    tracerouteIntervalMinutes,
    remoteLocalStatsIntervalMinutes,
    temperatureUnit,
    distanceUnit,
    positionHistoryLineStyle,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    preferredDashboardSortOption,
    timeFormat,
    dateFormat,
    mapTileset,
    mapTilesetLight,
    mapTilesetDark,
    activeMapTilesetMode,
    overlayScheme,
    overlayColors,
    mapPinStyle,
    iconStyle,
    neighborInfoMinZoom,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapCenterTargetZoom,
    defaultLandingPage,
    theme,
    appearanceMode,
    darkTheme,
    lightTheme,
    language,
    customThemes,
    customTilesets,
    isLoadingThemes,
    linkPreviewsEnabled,
    discardInvalidPositions,
    noIndexEnabled,
    meshcoreChannelRetryEnabled,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    enableAudioNotifications,
    nodeDimmingEnabled,
    nodeDimmingStartHours,
    nodeDimmingMinOpacity,
    nodeHopsCalculation,
    tapbackEmojis,
    temporaryTileset,
    setTemporaryTileset,
    isLoading,
    setMaxNodeAgeHours,
    setInactiveNodeThresholdHours,
    setInactiveNodeCheckIntervalMinutes,
    setInactiveNodeCooldownHours,
    setTracerouteIntervalMinutes,
    setRemoteLocalStatsIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    setPositionHistoryLineStyle,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
    setPreferredSortField,
    setPreferredSortDirection,
    setPreferredDashboardSortOption,
    setTimeFormat,
    setDateFormat,
    setMapTileset,
    setMapTilesets,
    setMapPinStyle,
    setIconStyle,
    setNeighborInfoMinZoom,
    setDefaultMapCenterLat,
    setDefaultMapCenterLon,
    setDefaultMapCenterZoom,
    setMapCenterTargetZoom,
    setDefaultLandingPage,
    setTheme,
    setAppearanceMode,
    setDarkTheme,
    setLightTheme,
    setLanguage,
    loadCustomThemes,
    addCustomTileset,
    updateCustomTileset,
    deleteCustomTileset,
    setLinkPreviewsEnabled,
    setDiscardInvalidPositions,
    setNoIndexEnabled,
    setMeshcoreChannelRetryEnabled,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination,
    setEnableAudioNotifications,
    mutedChannels,
    mutedDMs,
    muteChannel,
    unmuteChannel,
    muteDM,
    unmuteDM,
    isChannelMuted,
    isDMMuted,
    setNodeDimmingEnabled,
    setNodeDimmingStartHours,
    setNodeDimmingMinOpacity,
    setNodeHopsCalculation,
    setTapbackEmojis,
  }), [
    maxNodeAgeHours,
    inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours,
    tracerouteIntervalMinutes,
    remoteLocalStatsIntervalMinutes,
    temperatureUnit,
    distanceUnit,
    positionHistoryLineStyle,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    preferredDashboardSortOption,
    timeFormat,
    dateFormat,
    mapTileset,
    mapTilesetLight,
    mapTilesetDark,
    activeMapTilesetMode,
    overlayScheme,
    overlayColors,
    mapPinStyle,
    iconStyle,
    neighborInfoMinZoom,
    defaultMapCenterLat,
    defaultMapCenterLon,
    defaultMapCenterZoom,
    mapCenterTargetZoom,
    defaultLandingPage,
    theme,
    appearanceMode,
    darkTheme,
    lightTheme,
    language,
    customThemes,
    customTilesets,
    isLoadingThemes,
    linkPreviewsEnabled,
    discardInvalidPositions,
    noIndexEnabled,
    meshcoreChannelRetryEnabled,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    enableAudioNotifications,
    nodeDimmingEnabled,
    nodeDimmingStartHours,
    nodeDimmingMinOpacity,
    nodeHopsCalculation,
    tapbackEmojis,
    temporaryTileset,
    setTemporaryTileset,
    isLoading,
    setMaxNodeAgeHours,
    setInactiveNodeThresholdHours,
    setInactiveNodeCheckIntervalMinutes,
    setInactiveNodeCooldownHours,
    setTracerouteIntervalMinutes,
    setRemoteLocalStatsIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    setPositionHistoryLineStyle,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
    setPreferredSortField,
    setPreferredSortDirection,
    setPreferredDashboardSortOption,
    setTimeFormat,
    setDateFormat,
    setMapTileset,
    setMapTilesets,
    setMapPinStyle,
    setIconStyle,
    setNeighborInfoMinZoom,
    setDefaultMapCenterLat,
    setDefaultMapCenterLon,
    setDefaultMapCenterZoom,
    setMapCenterTargetZoom,
    setDefaultLandingPage,
    setTheme,
    setAppearanceMode,
    setDarkTheme,
    setLightTheme,
    setLanguage,
    loadCustomThemes,
    addCustomTileset,
    updateCustomTileset,
    deleteCustomTileset,
    setLinkPreviewsEnabled,
    setDiscardInvalidPositions,
    setNoIndexEnabled,
    setMeshcoreChannelRetryEnabled,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination,
    setEnableAudioNotifications,
    mutedChannels,
    mutedDMs,
    muteChannel,
    unmuteChannel,
    muteDM,
    unmuteDM,
    isChannelMuted,
    isDMMuted,
    setNodeDimmingEnabled,
    setNodeDimmingStartHours,
    setNodeDimmingMinOpacity,
    setNodeHopsCalculation,
    setTapbackEmojis,
  ]);

  return (
    <IconStyleProvider value={iconStyle}>
      <SettingsContext.Provider value={value}>
        {children}
      </SettingsContext.Provider>
    </IconStyleProvider>
  );
};

export const useSettings = (): SettingsContextType => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

/**
 * Non-throwing variant: returns the settings context, or `undefined` when no
 * SettingsProvider is in scope. Use this in widely-reused leaf components (e.g.
 * LinkPreview) that may render in trees without a provider — they can fall back
 * to a sensible default rather than crashing the whole view.
 */
export const useSettingsOptional = (): SettingsContextType | undefined => {
  return useContext(SettingsContext);
};

// Domain-specific hooks for cleaner imports and focused APIs

export const useDisplaySettings = () => {
  const s = useSettings();
  return {
    temperatureUnit: s.temperatureUnit, setTemperatureUnit: s.setTemperatureUnit,
    distanceUnit: s.distanceUnit, setDistanceUnit: s.setDistanceUnit,
    timeFormat: s.timeFormat, setTimeFormat: s.setTimeFormat,
    dateFormat: s.dateFormat, setDateFormat: s.setDateFormat,
    language: s.language, setLanguage: s.setLanguage,
    theme: s.theme, setTheme: s.setTheme,
    appearanceMode: s.appearanceMode, setAppearanceMode: s.setAppearanceMode,
    darkTheme: s.darkTheme, setDarkTheme: s.setDarkTheme,
    lightTheme: s.lightTheme, setLightTheme: s.setLightTheme,
    customThemes: s.customThemes, isLoadingThemes: s.isLoadingThemes, loadCustomThemes: s.loadCustomThemes,
  };
};

export const useMapSettings = () => {
  const s = useSettings();
  return {
    mapTileset: s.mapTileset, setMapTileset: s.setMapTileset,
    mapTilesetLight: s.mapTilesetLight, mapTilesetDark: s.mapTilesetDark,
    setMapTilesets: s.setMapTilesets,
    activeMapTilesetMode: s.activeMapTilesetMode,
    mapPinStyle: s.mapPinStyle, setMapPinStyle: s.setMapPinStyle,
    iconStyle: s.iconStyle, setIconStyle: s.setIconStyle,
    neighborInfoMinZoom: s.neighborInfoMinZoom, setNeighborInfoMinZoom: s.setNeighborInfoMinZoom,
    overlayScheme: s.overlayScheme, overlayColors: s.overlayColors,
    customTilesets: s.customTilesets,
    addCustomTileset: s.addCustomTileset, updateCustomTileset: s.updateCustomTileset, deleteCustomTileset: s.deleteCustomTileset,
    positionHistoryLineStyle: s.positionHistoryLineStyle, setPositionHistoryLineStyle: s.setPositionHistoryLineStyle,
    temporaryTileset: s.temporaryTileset, setTemporaryTileset: s.setTemporaryTileset,
  };
};

export const useNodeSettings = () => {
  const s = useSettings();
  return {
    maxNodeAgeHours: s.maxNodeAgeHours, setMaxNodeAgeHours: s.setMaxNodeAgeHours,
    inactiveNodeThresholdHours: s.inactiveNodeThresholdHours, setInactiveNodeThresholdHours: s.setInactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes: s.inactiveNodeCheckIntervalMinutes, setInactiveNodeCheckIntervalMinutes: s.setInactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours: s.inactiveNodeCooldownHours, setInactiveNodeCooldownHours: s.setInactiveNodeCooldownHours,
    preferredSortField: s.preferredSortField, setPreferredSortField: s.setPreferredSortField,
    preferredSortDirection: s.preferredSortDirection, setPreferredSortDirection: s.setPreferredSortDirection,
    nodeDimmingEnabled: s.nodeDimmingEnabled, setNodeDimmingEnabled: s.setNodeDimmingEnabled,
    nodeDimmingStartHours: s.nodeDimmingStartHours, setNodeDimmingStartHours: s.setNodeDimmingStartHours,
    nodeDimmingMinOpacity: s.nodeDimmingMinOpacity, setNodeDimmingMinOpacity: s.setNodeDimmingMinOpacity,
    nodeHopsCalculation: s.nodeHopsCalculation, setNodeHopsCalculation: s.setNodeHopsCalculation,
  };
};

export const useTelemetrySettings = () => {
  const s = useSettings();
  return {
    telemetryVisualizationHours: s.telemetryVisualizationHours, setTelemetryVisualizationHours: s.setTelemetryVisualizationHours,
    favoriteTelemetryStorageDays: s.favoriteTelemetryStorageDays, setFavoriteTelemetryStorageDays: s.setFavoriteTelemetryStorageDays,
  };
};

export const useSolarSettings = () => {
  const s = useSettings();
  return {
    solarMonitoringEnabled: s.solarMonitoringEnabled, setSolarMonitoringEnabled: s.setSolarMonitoringEnabled,
    solarMonitoringLatitude: s.solarMonitoringLatitude, setSolarMonitoringLatitude: s.setSolarMonitoringLatitude,
    solarMonitoringLongitude: s.solarMonitoringLongitude, setSolarMonitoringLongitude: s.setSolarMonitoringLongitude,
    solarMonitoringAzimuth: s.solarMonitoringAzimuth, setSolarMonitoringAzimuth: s.setSolarMonitoringAzimuth,
    solarMonitoringDeclination: s.solarMonitoringDeclination, setSolarMonitoringDeclination: s.setSolarMonitoringDeclination,
  };
};

export const useNotificationMuteSettings = () => {
  const s = useSettings();
  return {
    mutedChannels: s.mutedChannels,
    mutedDMs: s.mutedDMs,
    muteChannel: s.muteChannel,
    unmuteChannel: s.unmuteChannel,
    muteDM: s.muteDM,
    unmuteDM: s.unmuteDM,
    isChannelMuted: s.isChannelMuted,
    isDMMuted: s.isDMMuted,
  };
};
