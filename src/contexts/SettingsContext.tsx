import React, { createContext, useContext, useState, ReactNode } from 'react';
import { type TemperatureUnit } from '../utils/temperature';
import { type SortField, type SortDirection } from '../types/ui';
import { logger } from '../utils/logger';

export type DistanceUnit = 'km' | 'mi';
export type TimeFormat = '12' | '24';
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY';

interface SettingsContextType {
  maxNodeAgeHours: number;
  tracerouteIntervalMinutes: number;
  temperatureUnit: TemperatureUnit;
  distanceUnit: DistanceUnit;
  telemetryVisualizationHours: number;
  preferredSortField: SortField;
  preferredSortDirection: SortDirection;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  setMaxNodeAgeHours: (hours: number) => void;
  setTracerouteIntervalMinutes: (minutes: number) => void;
  setTemperatureUnit: (unit: TemperatureUnit) => void;
  setDistanceUnit: (unit: DistanceUnit) => void;
  setTelemetryVisualizationHours: (hours: number) => void;
  setPreferredSortField: (field: SortField) => void;
  setPreferredSortDirection: (direction: SortDirection) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setDateFormat: (format: DateFormat) => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

interface SettingsProviderProps {
  children: ReactNode;
  baseUrl?: string;
}

export const SettingsProvider: React.FC<SettingsProviderProps> = ({ children, baseUrl = '' }) => {
  const [maxNodeAgeHours, setMaxNodeAgeHoursState] = useState<number>(() => {
    const saved = localStorage.getItem('maxNodeAgeHours');
    return saved ? parseInt(saved) : 24;
  });

  const [tracerouteIntervalMinutes, setTracerouteIntervalMinutesState] = useState<number>(() => {
    const saved = localStorage.getItem('tracerouteIntervalMinutes');
    return saved ? parseInt(saved) : 3;
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

  const setMaxNodeAgeHours = (value: number) => {
    setMaxNodeAgeHoursState(value);
    localStorage.setItem('maxNodeAgeHours', value.toString());
  };

  const setTracerouteIntervalMinutes = async (value: number) => {
    setTracerouteIntervalMinutesState(value);
    localStorage.setItem('tracerouteIntervalMinutes', value.toString());

    try {
      await fetch(`${baseUrl}/api/settings/traceroute-interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const value: SettingsContextType = {
    maxNodeAgeHours,
    tracerouteIntervalMinutes,
    temperatureUnit,
    distanceUnit,
    telemetryVisualizationHours,
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    setMaxNodeAgeHours,
    setTracerouteIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    setTelemetryVisualizationHours,
    setPreferredSortField,
    setPreferredSortDirection,
    setTimeFormat,
    setDateFormat,
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
