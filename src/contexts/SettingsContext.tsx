import React, { createContext, useContext, useState, ReactNode } from 'react';
import { type TemperatureUnit } from '../utils/temperature';
import { type SortField, type SortDirection } from '../types/ui';
import { logger } from '../utils/logger';
import { useCsrf } from './CsrfContext';
import { DEFAULT_TILESET_ID, type TilesetId, type CustomTileset } from '../config/tilesets';

export type DistanceUnit = 'km' | 'mi';
export type TimeFormat = '12' | '24';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
export type MapPinStyle = 'meshmonitor' | 'official';

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
  tracerouteIntervalMinutes: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  telemetryVisualizationHours: number;
  favoriteTelemetryStorageDays: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  mapTileset: TilesetId;
  mapPinStyle: MapPinStyle;
  theme: Theme;
  customThemes: CustomTheme[];
  customTilesets: CustomTileset[];
  isLoadingThemes: boolean;
  solarMonitoringEnabled: boolean;
  solarMonitoringLatitude: number;
  solarMonitoringLongitude: number;
  solarMonitoringAzimuth: number;
  solarMonitoringDeclination: number;
  temporaryTileset: TilesetId | null;
  setTemporaryTileset: (tilesetId: TilesetId | null) => void;
  isLoading: boolean;
  setMaxNodeAgeHours: (hours: number) => void;
  setTracerouteIntervalMinutes: (minutes: number) => void;
  setTemperatureUnit: (unit: TemperatureUnit) => void;
  setDistanceUnit: (unit: DistanceUnit) => void;
  setTelemetryVisualizationHours: (hours: number) => void;
  setFavoriteTelemetryStorageDays: (days: number) => void;
  setPreferredSortField: (field: SortField) => void;
  setPreferredSortDirection: (direction: SortDirection) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setDateFormat: (format: DateFormat) => void;
  setMapTileset: (tilesetId: TilesetId) => void;
  setMapPinStyle: (style: MapPinStyle) => void;
  setTheme: (theme: Theme) => void;
  loadCustomThemes: () => Promise<void>;
  addCustomTileset: (tileset: Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateCustomTileset: (id: string, updates: Partial<Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  deleteCustomTileset: (id: string) => Promise<void>;
  setSolarMonitoringEnabled: (enabled: boolean) => void;
  setSolarMonitoringLatitude: (latitude: number) => void;
  setSolarMonitoringLongitude: (longitude: number) => void;
  setSolarMonitoringAzimuth: (azimuth: number) => void;
  setSolarMonitoringDeclination: (declination: number) => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

interface SettingsProviderProps {
  children: ReactNode;
  baseUrl?: string;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children, baseUrl = '' }) => {
  const { getToken: getCsrfToken } = useCsrf();
  const [isLoading, setIsLoading] = useState(true);

  const [maxNodeAgeHours, setMaxNodeAgeHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('maxNodeAgeHours');
    return saved ? parseInt(saved) : 24;
  });

  const [tracerouteIntervalMinutes, setTracerouteIntervalMinutesState] = useState<number>(() => {
    const saved = localStorage.getItem('tracerouteIntervalMinutes');
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

  const [mapTileset, setMapTilesetState] = useState<TilesetId>(() => {
    const saved = localStorage.getItem('mapTileset');
    // Return saved value if exists (could be predefined or custom tileset ID)
    // Validation happens later when customTilesets are loaded
    if (saved) {
      return saved;
    }
    return DEFAULT_TILESET_ID;
  });

  const [mapPinStyle, setMapPinStyleState] = useState<MapPinStyle>(() => {
    const saved = localStorage.getItem('mapPinStyle');
    return (saved === 'official' ? 'official' : 'meshmonitor') as MapPinStyle;
  });

  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem('theme');
    const validThemes: Theme[] = [
      'mocha', 'macchiato', 'frappe', 'latte',
      'nord', 'dracula',
      'solarized-dark', 'solarized-light',
      'gruvbox-dark', 'gruvbox-light',
      'high-contrast-dark', 'high-contrast-light',
      'protanopia', 'deuteranopia', 'tritanopia'
    ];
    return (saved && validThemes.includes(saved as Theme) ? saved : 'mocha') as Theme;
  });

  // Solar monitoring settings are database-only, not persisted in localStorage
  const [solarMonitoringEnabled, setSolarMonitoringEnabledState] = useState<boolean>(false);
  const [solarMonitoringLatitude, setSolarMonitoringLatitudeState] = useState<number>(0);
  const [solarMonitoringLongitude, setSolarMonitoringLongitudeState] = useState<number>(0);
  const [solarMonitoringAzimuth, setSolarMonitoringAzimuthState] = useState<number>(0);
  const [solarMonitoringDeclination, setSolarMonitoringDeclinationState] = useState<number>(30);

  const [temporaryTileset, setTemporaryTileset] = useState<TilesetId | null>(null);

  // Custom themes state
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const [isLoadingThemes, setIsLoadingThemes] = useState(false);

  // Custom tilesets state (database-only, not persisted in localStorage)
  const [customTilesets, setCustomTilesets] = useState<CustomTileset[]>([]);

  const setMaxNodeAgeHours = (value: number) => {
    setMaxNodeAgeHoursState(value);
    localStorage.setItem('maxNodeAgeHours', value.toString());
  };

  const setTracerouteIntervalMinutes = async (value: number) => {
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
  };

  const setTemperatureUnit = (unit: TemperatureUnit) => {
    setTemperatureUnitState(unit);
    localStorage.setItem('temperatureUnit', unit);
  };

  const setDistanceUnit = (unit: DistanceUnit) => {
    setDistanceUnitState(unit);
    localStorage.setItem('distanceUnit', unit);
  };

  const setTelemetryVisualizationHours = (hours: number) => {
    setTelemetryVisualizationHoursState(hours);
    localStorage.setItem('telemetryVisualizationHours', hours.toString());
  };

  const setFavoriteTelemetryStorageDays = (days: number) => {
    setFavoriteTelemetryStorageDaysState(days);
    localStorage.setItem('favoriteTelemetryStorageDays', days.toString());
  };

  const setPreferredSortField = (field: SortField) => {
    setPreferredSortFieldState(field);
    localStorage.setItem('preferredSortField', field);
  };

  const setPreferredSortDirection = (direction: SortDirection) => {
    setPreferredSortDirectionState(direction);
    localStorage.setItem('preferredSortDirection', direction);
  };

  const setTimeFormat = (format: TimeFormat) => {
    setTimeFormatState(format);
    localStorage.setItem('timeFormat', format);
  };

  const setDateFormat = (format: DateFormat) => {
    setDateFormatState(format);
    localStorage.setItem('dateFormat', format);
  };

  const setMapTileset = (tilesetId: TilesetId) => {
    setMapTilesetState(tilesetId);
    localStorage.setItem('mapTileset', tilesetId);
  };

  const setMapPinStyle = (style: MapPinStyle) => {
    setMapPinStyleState(style);
    localStorage.setItem('mapPinStyle', style);
  };

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

  /**
   * Built-in theme names for validation
   */
  const builtInThemes: BuiltInTheme[] = [
    'mocha', 'macchiato', 'frappe', 'latte',
    'nord', 'dracula',
    'solarized-dark', 'solarized-light',
    'gruvbox-dark', 'gruvbox-light',
    'high-contrast-dark', 'high-contrast-light',
    'protanopia', 'deuteranopia', 'tritanopia'
  ];

  const setTheme = (newTheme: Theme) => {
    logger.debug(`🔄 setTheme called with: ${newTheme}`);
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);

    // Check if this is a built-in or custom theme
    const isBuiltIn = builtInThemes.includes(newTheme as BuiltInTheme);
    logger.debug(`📝 Is built-in theme: ${isBuiltIn}`);

    if (isBuiltIn) {
      // Built-in theme: use data-theme attribute
      document.documentElement.setAttribute('data-theme', newTheme);
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
  };

  // Solar monitoring setters update state only - values are persisted server-side
  const setSolarMonitoringEnabled = (enabled: boolean) => {
    setSolarMonitoringEnabledState(enabled);
  };

  const setSolarMonitoringLatitude = (latitude: number) => {
    setSolarMonitoringLatitudeState(latitude);
  };

  const setSolarMonitoringLongitude = (longitude: number) => {
    setSolarMonitoringLongitudeState(longitude);
  };

  const setSolarMonitoringAzimuth = (azimuth: number) => {
    setSolarMonitoringAzimuthState(azimuth);
  };

  const setSolarMonitoringDeclination = (declination: number) => {
    setSolarMonitoringDeclinationState(declination);
  };

  /**
   * Add a new custom tileset
   */
  const addCustomTileset = React.useCallback(async (tileset: Omit<CustomTileset, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now();
    const newTileset: CustomTileset = {
      ...tileset,
      id: `custom-${crypto.randomUUID()}`,
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

          if (settings.preferredSortField) {
            setPreferredSortFieldState(settings.preferredSortField as SortField);
            localStorage.setItem('preferredSortField', settings.preferredSortField);
          }

          if (settings.preferredSortDirection) {
            setPreferredSortDirectionState(settings.preferredSortDirection as SortDirection);
            localStorage.setItem('preferredSortDirection', settings.preferredSortDirection);
          }

          if (settings.timeFormat) {
            setTimeFormatState(settings.timeFormat as TimeFormat);
            localStorage.setItem('timeFormat', settings.timeFormat);
          }

          if (settings.dateFormat) {
            setDateFormatState(settings.dateFormat as DateFormat);
            localStorage.setItem('dateFormat', settings.dateFormat);
          }

          if (settings.mapTileset) {
            // Accept both predefined and custom tileset IDs
            setMapTilesetState(settings.mapTileset);
            localStorage.setItem('mapTileset', settings.mapTileset);
          }

          if (settings.mapPinStyle) {
            setMapPinStyleState(settings.mapPinStyle as MapPinStyle);
            localStorage.setItem('mapPinStyle', settings.mapPinStyle);
          }

          if (settings.theme) {
            // Accept any theme (built-in or custom)
            setThemeState(settings.theme as Theme);
            localStorage.setItem('theme', settings.theme);

            // Check if it's a built-in or custom theme
            const isBuiltIn = builtInThemes.includes(settings.theme as BuiltInTheme);

            if (isBuiltIn) {
              document.documentElement.setAttribute('data-theme', settings.theme);
            } else {
              // Custom theme will be applied after custom themes are loaded
              document.documentElement.setAttribute('data-theme', 'custom');
              logger.debug(`🎨 Custom theme '${settings.theme}' will be applied after themes load`);
            }
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

          logger.debug('✅ Settings loaded from server and applied to state');
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

    loadServerSettings();
  }, [baseUrl]);

  // Load custom themes on mount
  React.useEffect(() => {
    loadCustomThemes();
  }, [loadCustomThemes]);

  // Apply custom theme CSS when themes are loaded or theme changes
  React.useEffect(() => {
    logger.debug(`🔄 useEffect triggered - customThemes: ${customThemes.length}, theme: ${theme}`);
    if (customThemes.length > 0 && theme) {
      const isBuiltIn = builtInThemes.includes(theme as BuiltInTheme);
      logger.debug(`📝 useEffect - Is built-in: ${isBuiltIn}`);

      if (!isBuiltIn) {
        // Apply custom theme
        logger.debug(`🎨 useEffect - Applying custom theme: ${theme}`);
        applyCustomThemeCSS(theme);
      }
    }
  }, [customThemes, theme, applyCustomThemeCSS]);

  const value: SettingsContextType = {
    maxNodeAgeHours,
    tracerouteIntervalMinutes,
    temperatureUnit,
    distanceUnit,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    mapTileset,
    mapPinStyle,
    theme,
    customThemes,
    customTilesets,
    isLoadingThemes,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    temporaryTileset,
    setTemporaryTileset,
    isLoading,
    setMaxNodeAgeHours,
    setTracerouteIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
    setPreferredSortField,
    setPreferredSortDirection,
    setTimeFormat,
    setDateFormat,
    setMapTileset,
    setMapPinStyle,
    setTheme,
    loadCustomThemes,
    addCustomTileset,
    updateCustomTileset,
    deleteCustomTileset,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination,
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = (): SettingsContextType => {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};
