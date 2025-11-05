import React, { createContext, useContext, useState, ReactNode } from 'react';
import { type TemperatureUnit } from '../utils/temperature';
import { type SortField, type SortDirection } from '../types/ui';
import { logger } from '../utils/logger';
import { useCsrf } from './CsrfContext';
import { DEFAULT_TILESET_ID, type TilesetId, isTilesetId } from '../config/tilesets';

export type DistanceUnit = 'km' | 'mi';
export type TimeFormat = '12' | '24';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY';
export type MapPinStyle = 'meshmonitor' | 'official';

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
    return (saved === 'DD/MM/YYYY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY') as DateFormat;
  });

  const [mapTileset, setMapTilesetState] = useState<TilesetId>(() => {
    const saved = localStorage.getItem('mapTileset');
    if (saved && isTilesetId(saved)) {
      return saved;
    }
    return DEFAULT_TILESET_ID;
  });

  const [mapPinStyle, setMapPinStyleState] = useState<MapPinStyle>(() => {
    const saved = localStorage.getItem('mapPinStyle');
    return (saved === 'official' ? 'official' : 'meshmonitor') as MapPinStyle;
  });

  const [temporaryTileset, setTemporaryTileset] = useState<TilesetId | null>(null);

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

          if (settings.mapTileset && isTilesetId(settings.mapTileset)) {
            setMapTilesetState(settings.mapTileset);
            localStorage.setItem('mapTileset', settings.mapTileset);
          }

          if (settings.mapPinStyle) {
            setMapPinStyleState(settings.mapPinStyle as MapPinStyle);
            localStorage.setItem('mapPinStyle', settings.mapPinStyle);
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
