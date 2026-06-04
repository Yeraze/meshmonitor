import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './TelemetryGraphs.css';
import { type TemperatureUnit, formatTemperature, getTemperatureUnit, isTemperatureType } from '../utils/temperature';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useTelemetry, useSolarEstimates, type TelemetryData } from '../hooks/useTelemetry';
import { useFavorites, useToggleFavorite } from '../hooks/useFavorites';
import { formatChartAxisTimestamp, formatTime } from '../utils/datetime';
import { useSettings, type TimeFormat } from '../contexts/SettingsContext';
import { useAuth } from '../contexts/AuthContext';
import { ChartData } from '../types/ui';
import { useWidgetMode } from '../hooks/useWidgetMode';
import { useWidgetRange } from '../hooks/useWidgetRange';
import { useSource } from '../contexts/SourceContext';
import { getLatestValue } from '../utils/telemetry';
import TelemetryGauge from './TelemetryGauge';
import TelemetryNumericLabel from './TelemetryNumericLabel';
import { getTelemetryLabel } from './TelemetryChart';

/** Telemetry types that represent discrete integer values where fractional display is meaningless */
const INTEGER_TELEMETRY_TYPES = new Set([
  'sats_in_view',
  'messageHops',
  'batteryLevel',
  'numOnlineNodes', 'numTotalNodes',
  'numPacketsTx', 'numPacketsRx', 'numPacketsRxBad',
  'numRxDupe', 'numTxRelay', 'numTxRelayCanceled', 'numTxDropped',
  'systemNodeCount', 'systemDirectNodeCount',
  'paxcounterWifi', 'paxcounterBle',
  'particles03um', 'particles05um', 'particles10um',
  'particles25um', 'particles50um', 'particles100um',
  'co2', 'iaq',
]);

interface TelemetryGraphsProps {
  nodeId: string;
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  baseUrl?: string;
  /**
   * When true, render a row of time-range buttons (15m … 7d) above the graphs
   * that let the user choose how much history to load. The chosen range is
   * remembered in localStorage. Used on the Device Info page for the locally
   * connected node, where telemetry volume is high enough that a fixed window
   * either truncates the history or floods the chart. Other usages (remote
   * nodes in the Messages/MeshCore views) leave this off and keep the fixed
   * `telemetryHours` window.
   */
  showTimeRangeSelector?: boolean;
}

/** localStorage key for the Device Info telemetry time-range selection. */
const TELEMETRY_RANGE_STORAGE_KEY = 'deviceInfoTelemetryHours';

/** Server-side telemetry retention window (see TELEMETRY_RETENTION_HOURS). */
const TELEMETRY_RETENTION_HOURS = 168;

/**
 * Selectable telemetry windows, shortest to longest. Capped at the retention
 * window so no button can request data that has already been purged. Hours are
 * fractional where needed (0.25h = 15 minutes); the backend parses with
 * parseFloat and averages each window down to a manageable point count.
 */
const TELEMETRY_RANGE_PRESETS: { label: string; hours: number }[] = [
  { label: '15m', hours: 0.25 },
  { label: '1h', hours: 1 },
  { label: '3h', hours: 3 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
].filter(p => p.hours <= TELEMETRY_RETENTION_HOURS);

/**
 * Helper function to calculate minimum timestamp from telemetry data
 * Returns Infinity if no valid timestamp found
 */
const getMinTimestamp = (data: TelemetryData[]): number => {
  let minTime = Infinity;
  data.forEach(item => {
    if (item.timestamp < minTime) minTime = item.timestamp;
  });
  return minTime;
};

// Telemetry types that should show solar by default (power/environmental)
const SOLAR_DEFAULT_ON_TYPES = new Set([
  'batteryLevel',
  'voltage',
  'ch1Voltage',
  'ch1Current',
  'ch2Voltage',
  'ch2Current',
  'ch3Voltage',
  'ch3Current',
  'ch4Voltage',
  'ch4Current',
  'ch5Voltage',
  'ch5Current',
  'ch6Voltage',
  'ch6Current',
  'ch7Voltage',
  'ch7Current',
  'ch8Voltage',
  'ch8Current',
  'temperature',
  'humidity',
  'pressure',
  // Extended environment metrics affected by solar/weather
  'lux',
  'whiteLux',
  'irLux',
  'uvLux',
  'windSpeed',
  'windGust',
  'windLull',
  'soilTemperature',
  'soilMoisture',
]);

// Sub-component so hooks (useWidgetMode, useWidgetRange) can be called legally per widget
interface TelemetryGraphWidgetProps {
  nodeId: string;
  type: string;
  baseUrl: string;
  data: TelemetryData[];
  isPaxcounterCombined: boolean;
  bleData?: TelemetryData[];
  temperatureUnit: TemperatureUnit;
  globalTimeRange: [number, number] | null;
  globalMinTime: number | undefined;
  solarEstimates: Map<number, number>;
  solarMonitoringEnabled: boolean;
  getSolarVisibility: (type: string) => boolean;
  handleToggleSolar: (type: string) => void;
  favorites: Set<string>;
  createToggleFavorite: (type: string) => () => void;
  handleMenuClick: (e: React.MouseEvent<HTMLButtonElement>, type: string) => void;
  openMenu: string | null;
  menuPosition: { x: number; y: number } | null;
  handlePurgeData: (type: string) => void;
  chartColors: { base: string; surface0: string; text: string };
  getTelemetryLabel: (type: string) => string;
  getColor: (type: string) => string;
  prepareChartData: (data: TelemetryData[], isTemperature?: boolean, globalMinTime?: number) => ChartData[];
  timeFormat: TimeFormat;
  t: (key: string, opts?: Record<string, unknown>) => string;
  canEditSettings: boolean;
}

const TelemetryGraphWidget: React.FC<TelemetryGraphWidgetProps> = ({
  nodeId,
  type,
  baseUrl,
  data,
  isPaxcounterCombined,
  bleData = [],
  temperatureUnit,
  globalTimeRange,
  globalMinTime,
  solarEstimates,
  solarMonitoringEnabled,
  getSolarVisibility,
  handleToggleSolar,
  favorites,
  createToggleFavorite,
  handleMenuClick,
  openMenu,
  menuPosition,
  handlePurgeData,
  chartColors,
  getTelemetryLabel,
  getColor,
  prepareChartData,
  timeFormat,
  t,
  canEditSettings,
}) => {
  const [mode, setMode] = useWidgetMode(nodeId, type, baseUrl);
  const [range, setRange] = useWidgetRange(nodeId, type, baseUrl);

  const isTemperature = isTemperatureType(type);
  const chartData = prepareChartData(data, isTemperature, globalMinTime);
  const unit = isTemperature ? getTemperatureUnit(temperatureUnit) : data[0]?.unit || '';
  const label = isPaxcounterCombined ? 'Paxcounter' : getTelemetryLabel(type);
  const color = getColor(type);

  if (isPaxcounterCombined) {
    const bleByTimestamp = new Map<number, number>();
    bleData.forEach(item => bleByTimestamp.set(item.timestamp, item.value));
    chartData.forEach(point => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = point as any;
      p.paxWifi = point.value;
      p.paxBle = bleByTimestamp.get(point.timestamp) ?? null;
      bleByTimestamp.delete(point.timestamp);
    });
    bleByTimestamp.forEach((value, timestamp) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const point: any = {
        timestamp,
        value: null,
        time: '',
        paxWifi: null,
        paxBle: value,
      };
      chartData.push(point);
    });
    chartData.sort((a, b) => a.timestamp - b.timestamp);
  }

  const latest = getLatestValue(data);

  // Gauge/numeric modes display a single raw value, so convert it (and the
  // gauge range) to the selected unit. Ranges persist in Celsius, so edits
  // made while displaying Fahrenheit are converted back before saving.
  const toDisplayTemp = (v: number) =>
    isTemperature ? formatTemperature(v, 'C', temperatureUnit) : v;
  const toStoredTemp = (v: number) =>
    isTemperature ? formatTemperature(v, temperatureUnit, 'C') : v;
  const handleRangeChange = (r: { min: number; max: number }) =>
    setRange({ min: toStoredTemp(r.min), max: toStoredTemp(r.max) });

  return (
    <div key={type} className="graph-container">
      <div className="graph-header">
        <h4 className="graph-title" title={`${label} ${unit ? `(${unit})` : ''}`}>
          {label} {unit && `(${unit})`}
        </h4>
        <div className="graph-actions">
          {canEditSettings && (
            <div className="mode-toggle-group" role="group" aria-label="Display mode">
              <button
                className={`mode-toggle-btn ${mode === 'chart' ? 'active' : ''}`}
                onClick={() => setMode('chart')}
                title="Chart"
                aria-label="Chart mode"
              >
                ~
              </button>
              <button
                className={`mode-toggle-btn ${mode === 'gauge' ? 'active' : ''}`}
                onClick={() => setMode('gauge')}
                title="Gauge"
                aria-label="Gauge mode"
              >
                ⊙
              </button>
              <button
                className={`mode-toggle-btn ${mode === 'numeric' ? 'active' : ''}`}
                onClick={() => setMode('numeric')}
                title="Numeric"
                aria-label="Numeric mode"
              >
                #
              </button>
            </div>
          )}
          {solarMonitoringEnabled && (
            <button
              className={`solar-toggle-btn ${getSolarVisibility(type) ? 'active' : ''}`}
              onClick={() => handleToggleSolar(type)}
              aria-label={getSolarVisibility(type) ? t('telemetry.hide_solar') : t('telemetry.show_solar')}
              title={getSolarVisibility(type) ? t('telemetry.hide_solar') : t('telemetry.show_solar')}
            >
              {getSolarVisibility(type) ? '\u2600' : '\u263C'}
            </button>
          )}
          <button
            className={`favorite-btn ${favorites.has(type) ? 'favorited' : ''}`}
            onClick={createToggleFavorite(type)}
            aria-label={favorites.has(type) ? t('telemetry.remove_favorite') : t('telemetry.add_favorite')}
          >
            {favorites.has(type) ? '★' : '☆'}
          </button>
          <button
            className="graph-menu-btn"
            onClick={e => handleMenuClick(e, type)}
            aria-label={t('telemetry.more_options')}
          >
            ⋯
          </button>
          {openMenu === type && menuPosition && (
            <div
              className="telemetry-context-menu"
              style={{
                position: 'fixed',
                top: `${menuPosition.y}px`,
                left: `${menuPosition.x}px`,
              }}
              onClick={e => e.stopPropagation()}
            >
              <button className="context-menu-item" onClick={() => handlePurgeData(type)}>
                {t('telemetry.purge_data')}
              </button>
            </div>
          )}
        </div>
      </div>

      {mode === 'gauge' ? (
        latest ? (
          <TelemetryGauge
            value={toDisplayTemp(latest.value)}
            min={toDisplayTemp(range.min)}
            max={toDisplayTemp(range.max)}
            unit={unit}
            color={color}
            timestamp={latest.timestamp}
            nodeId={nodeId}
            onRangeChange={handleRangeChange}
            canEditRange={canEditSettings}
          />
        ) : (
          <div className="telemetry-no-data">{t('telemetry.no_data')}</div>
        )
      ) : mode === 'numeric' ? (
        latest ? (
          <TelemetryNumericLabel
            value={toDisplayTemp(latest.value)}
            unit={unit}
            color={color}
            timestamp={latest.timestamp}
          />
        ) : (
          <div className="telemetry-no-data">{t('telemetry.no_data')}</div>
        )
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={globalTimeRange || ['dataMin', 'dataMax']}
              tick={{ fontSize: 12 }}
              tickFormatter={timestamp => formatChartAxisTimestamp(timestamp, globalTimeRange, timeFormat)}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 12 }}
              domain={['auto', 'auto']}
              allowDecimals={!INTEGER_TELEMETRY_TYPES.has(type)}
              tickFormatter={INTEGER_TELEMETRY_TYPES.has(type) ? (v: number) => Math.round(v).toString() : undefined}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12 }}
              domain={['auto', 'auto']}
              hide={true}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: chartColors.base,
                border: `1px solid ${chartColors.surface0}`,
                borderRadius: '4px',
                color: chartColors.text,
              }}
              labelStyle={{ color: chartColors.text }}
              labelFormatter={value => {
                const date = new Date(value);
                return date.toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
              }}
            />
            {getSolarVisibility(type) && solarEstimates.size > 0 && (
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="solarEstimate"
                fill="#f9e2af"
                fillOpacity={0.3}
                stroke="#f9e2af"
                strokeOpacity={0.5}
                strokeWidth={1}
                connectNulls={true}
                isAnimationActive={false}
              />
            )}
            {isPaxcounterCombined ? (
              <>
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="paxWifi"
                  name="WiFi"
                  stroke={getColor('paxcounterWifi')}
                  strokeWidth={2}
                  dot={{ fill: getColor('paxcounterWifi'), r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls={true}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="paxBle"
                  name="BLE"
                  stroke={getColor('paxcounterBle')}
                  strokeWidth={2}
                  dot={{ fill: getColor('paxcounterBle'), r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls={true}
                />
              </>
            ) : (
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                dot={{ fill: color, r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls={true}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};

const TelemetryGraphs: React.FC<TelemetryGraphsProps> = React.memo(
  ({ nodeId, temperatureUnit = 'C', telemetryHours = 24, baseUrl = '', showTimeRangeSelector = false }) => {
    const { t } = useTranslation();
    const csrfFetch = useCsrfFetch();
    const { showToast } = useToast();
    const { solarMonitoringEnabled, timeFormat } = useSettings();
    const { hasPermission } = useAuth();
    const canEditSettings = hasPermission('settings', 'write');
    const { sourceId } = useSource();
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const [menuPosition, setMenuPosition] = useState<{
      x: number;
      y: number;
    } | null>(null);
    // Track solar visibility per telemetry type
    const [solarVisibility, setSolarVisibility] = useState<Map<string, boolean>>(new Map());

    // Selected telemetry window (hours). Only meaningful when the time-range
    // selector is shown; otherwise the fixed `telemetryHours` prop is used.
    // Seeds from the user's last Device Info choice (localStorage), falling
    // back to the configured default window.
    const [selectedHours, setSelectedHours] = useState<number>(() => {
      if (!showTimeRangeSelector) return telemetryHours;
      try {
        const stored = window.localStorage.getItem(TELEMETRY_RANGE_STORAGE_KEY);
        const parsed = stored !== null ? parseFloat(stored) : NaN;
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= TELEMETRY_RETENTION_HOURS) {
          return parsed;
        }
      } catch {
        // localStorage may be unavailable (e.g. private mode); fall through.
      }
      return telemetryHours;
    });

    const effectiveHours = showTimeRangeSelector ? selectedHours : telemetryHours;

    const handleSelectRange = useCallback((hours: number) => {
      setSelectedHours(hours);
      try {
        window.localStorage.setItem(TELEMETRY_RANGE_STORAGE_KEY, String(hours));
      } catch {
        // Persisting is best-effort; ignore storage failures.
      }
    }, []);

    // Fetch telemetry data using TanStack Query
    const {
      data: telemetryData = [],
      isLoading: loading,
      error: telemetryError,
      refetch: refetchTelemetry,
    } = useTelemetry({
      nodeId,
      hours: effectiveHours,
      baseUrl,
      sourceId,
    });

    // Calculate time bounds for solar estimates based on telemetry data
    const telemetryTimeBounds = useMemo(() => {
      if (telemetryData.length === 0) {
        return null;
      }

      const minTime = getMinTimestamp(telemetryData);
      if (minTime === Infinity) {
        return null;
      }

      return {
        start: Math.floor(minTime / 1000), // Convert to Unix timestamp (seconds)
        end: Math.floor(Date.now() / 1000),
      };
    }, [telemetryData]);

    // Fetch solar estimates using TanStack Query
    const { data: solarEstimates = new Map() } = useSolarEstimates({
      baseUrl,
      startTimestamp: telemetryTimeBounds?.start,
      endTimestamp: telemetryTimeBounds?.end,
      enabled: !!telemetryTimeBounds,
    });

    // Fetch favorites using TanStack Query
    const { data: favorites = new Set<string>() } = useFavorites({
      nodeId,
      baseUrl,
    });

    // Mutation for toggling favorites with optimistic updates
    const toggleFavoriteMutation = useToggleFavorite({
      baseUrl,
      onError: message => {
        logger.error('Error saving favorite:', message);
        showToast(t('telemetry.favorite_save_failed'), 'error');
      },
    });

    // Convert error to string for display
    const error = telemetryError
      ? telemetryError instanceof Error
        ? telemetryError.message
        : t('telemetry.load_failed')
      : null;

    // Get computed CSS color values for chart styling (Recharts doesn't support CSS variables in inline styles)
    const [chartColors, setChartColors] = useState({
      base: '#1e1e2e',
      surface0: '#45475a',
      text: '#cdd6f4',
    });

    // Update chart colors when theme changes
    useEffect(() => {
      const updateColors = () => {
        const rootStyle = getComputedStyle(document.documentElement);
        const base = rootStyle.getPropertyValue('--ctp-base').trim();
        const surface0 = rootStyle.getPropertyValue('--ctp-surface0').trim();
        const text = rootStyle.getPropertyValue('--ctp-text').trim();

        if (base && surface0 && text) {
          setChartColors({ base, surface0, text });
        }
      };

      updateColors();

      // Listen for theme changes
      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
            updateColors();
          }
        });
      });

      observer.observe(document.documentElement, { attributes: true });

      return () => observer.disconnect();
    }, []);

    // Create stable callback factory for favorite toggles
    const createToggleFavorite = useCallback(
      (type: string) => {
        return () =>
          toggleFavoriteMutation.mutate({
            nodeId,
            telemetryType: type,
            currentFavorites: favorites,
          });
      },
      [toggleFavoriteMutation, nodeId, favorites]
    );

    // Get solar visibility for a telemetry type (defaults based on type)
    const getSolarVisibility = useCallback(
      (type: string): boolean => {
        if (solarVisibility.has(type)) {
          return solarVisibility.get(type)!;
        }
        // Default: enabled for power/environmental, disabled for others
        return SOLAR_DEFAULT_ON_TYPES.has(type);
      },
      [solarVisibility]
    );

    // Toggle solar visibility for a telemetry type
    const handleToggleSolar = useCallback((type: string) => {
      setSolarVisibility(prev => {
        const next = new Map(prev);
        const currentValue = prev.has(type) ? prev.get(type)! : SOLAR_DEFAULT_ON_TYPES.has(type);
        next.set(type, !currentValue);
        return next;
      });
    }, []);

    // Handle menu open/close
    const handleMenuClick = (event: React.MouseEvent<HTMLButtonElement>, telemetryType: string) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenuPosition({ x: rect.left, y: rect.bottom });
      setOpenMenu(openMenu === telemetryType ? null : telemetryType);
    };

    // Close menu when clicking outside
    useEffect(() => {
      const handleClickOutside = () => {
        if (openMenu) {
          setOpenMenu(null);
          setMenuPosition(null);
        }
      };

      if (openMenu) {
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
      }
    }, [openMenu]);

    // Handle purge data
    const handlePurgeData = async (telemetryType: string) => {
      const confirmed = window.confirm(t('telemetry.purge_confirm', { type: getTelemetryLabel(telemetryType) }));

      if (!confirmed) {
        setOpenMenu(null);
        setMenuPosition(null);
        return;
      }

      try {
        const response = await csrfFetch(`${baseUrl}/api/telemetry/${nodeId}/${telemetryType}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          if (response.status === 403) {
            showToast(t('telemetry.purge_permission_denied'), 'error');
            return;
          }
          throw new Error(`Server returned ${response.status}`);
        }

        showToast(t('telemetry.purge_success', { type: getTelemetryLabel(telemetryType) }), 'success');

        // Refresh telemetry data using TanStack Query
        refetchTelemetry();
      } catch (error) {
        logger.error('Error purging telemetry data:', error);
        showToast(t('telemetry.purge_failed'), 'error');
      } finally {
        setOpenMenu(null);
        setMenuPosition(null);
      }
    };

    const groupByType = (data: TelemetryData[]): Map<string, TelemetryData[]> => {
      const grouped = new Map<string, TelemetryData[]>();
      data.forEach(item => {
        if (!grouped.has(item.telemetryType)) {
          grouped.set(item.telemetryType, []);
        }
        grouped.get(item.telemetryType)!.push(item);
      });
      return grouped;
    };

    const prepareChartData = (
      data: TelemetryData[],
      isTemperature: boolean = false,
      globalMinTime?: number
    ): ChartData[] => {
      // Create a map of all unique timestamps from both telemetry and solar data
      const allTimestamps = new Map<number, ChartData>();

      // Use global minimum time if provided (for uniform axes), otherwise use chart-specific minimum
      const minTelemetryTime = globalMinTime !== undefined ? globalMinTime : getMinTimestamp(data);
      const maxTelemetryTime = Date.now();

      // Add telemetry data points
      data.forEach(item => {
        allTimestamps.set(item.timestamp, {
          timestamp: item.timestamp,
          value: isTemperature ? formatTemperature(item.value, 'C', temperatureUnit) : item.value,
          time: formatTime(new Date(item.timestamp), timeFormat),
        });
      });

      // Add solar data points (at their own timestamps)
      // Only include solar data within the GLOBAL telemetry time range
      // This prevents solar data from extending the time axis beyond actual telemetry data
      if (solarEstimates.size > 0 && minTelemetryTime !== Infinity) {
        // Use current time with a 5-minute buffer to account for minor clock differences
        const now = maxTelemetryTime + 5 * 60 * 1000;

        solarEstimates.forEach((wattHours, timestamp) => {
          // Filter out data outside GLOBAL telemetry time bounds
          // Solar data should never extend the graph range beyond actual telemetry
          if (timestamp < minTelemetryTime || timestamp > now) return;

          if (allTimestamps.has(timestamp)) {
            // If telemetry exists at this timestamp, add solar data to it
            allTimestamps.get(timestamp)!.solarEstimate = wattHours;
          } else {
            // Create a new point for solar-only data
            // Use null (not undefined) - Line will connect over these with connectNulls={true}
            allTimestamps.set(timestamp, {
              timestamp,
              value: null, // null = solar-only (will be skipped by Line with connectNulls)
              time: formatTime(new Date(timestamp), timeFormat),
              solarEstimate: wattHours,
            });
          }
        });
      }

      // Convert to array and sort by timestamp
      const sortedData = Array.from(allTimestamps.values()).sort((a, b) => a.timestamp - b.timestamp);

      // Insert gaps when telemetry points are more than 3 hours apart
      const threeHours = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
      const dataWithGaps: ChartData[] = [];

      for (let i = 0; i < sortedData.length; i++) {
        dataWithGaps.push(sortedData[i]);

        // Check if we should insert a gap before the next point
        if (i < sortedData.length - 1) {
          const timeDiff = sortedData[i + 1].timestamp - sortedData[i].timestamp;

          if (timeDiff > threeHours) {
            // Insert a gap point to break the line
            dataWithGaps.push({
              timestamp: sortedData[i].timestamp + 1, // Just after current point
              value: null, // Use null to create a gap in the line
              time: '',
              solarEstimate: undefined,
            });
          }
        }
      }

      return dataWithGaps;
    };

    const getColor = (type: string): string => {
      const colors: { [key: string]: string } = {
        batteryLevel: '#82ca9d',
        voltage: '#8884d8',
        channelUtilization: '#ffc658',
        airUtilTx: '#ff7c7c',
        temperature: '#ff8042',
        humidity: '#00c4cc',
        pressure: '#a28dff',
        snr: '#94e2d5', // Catppuccin teal - for signal quality (legacy)
        snr_local: '#89dceb', // Catppuccin sky - for local SNR measurements
        snr_remote: '#a6e3a1', // Catppuccin green - for remote SNR reports
        rssi: '#f9e2af', // Catppuccin yellow - for signal strength
        ch1Voltage: '#d084d8',
        ch1Current: '#ff6b9d',
        ch2Voltage: '#c084ff',
        ch2Current: '#ff6bcf',
        ch3Voltage: '#84d0c0',
        ch3Current: '#6bff8f',
        ch4Voltage: '#d8d084',
        ch4Current: '#ffcf6b',
        ch5Voltage: '#d88488',
        ch5Current: '#ff8b6b',
        ch6Voltage: '#8488d8',
        ch6Current: '#6b8bff',
        ch7Voltage: '#88d8c0',
        ch7Current: '#6bffcf',
        ch8Voltage: '#d8c088',
        ch8Current: '#ffbf6b',
        altitude: '#74c0fc',
        sats_in_view: '#f9e2af', // Yellow for satellite count
        // Air Quality metrics - using earthy/green tones for PM and blue/purple for particles
        pm10Standard: '#a6da95', // Light green
        pm25Standard: '#8bd5ca', // Teal
        pm100Standard: '#7dc4e4', // Blue
        pm10Environmental: '#91d7e3', // Sky
        pm25Environmental: '#7dc4e4', // Sapphire
        pm100Environmental: '#8aadf4', // Lavender
        particles03um: '#b7bdf8', // Lavender light
        particles05um: '#c6a0f6', // Mauve
        particles10um: '#f5bde6', // Pink
        particles25um: '#ee99a0', // Maroon
        particles50um: '#f5a97f', // Peach
        particles100um: '#eed49f', // Yellow
        co2: '#ed8796', // Red for CO2 (important air quality indicator)
        co2Temperature: '#f5a97f', // Peach
        co2Humidity: '#91d7e3', // Sky blue
        // Paxcounter metrics
        paxcounterWifi: '#ff9500', // Orange
        paxcounterBle: '#17c0fa', // Cyan
        paxcounterUptime: '#9c88ff', // Purple
        // MeshMonitor system metrics
        systemNodeCount: '#89b4fa', // Blue - system active nodes
        systemDirectNodeCount: '#a6e3a1', // Green - system direct nodes
        timeOffset: '#f2cdcd', // Catppuccin flamingo - clock offset
        // Extended Environment metrics
        gasResistance: '#cba6f7', // Mauve - air quality related
        iaq: '#f38ba8', // Red - important air quality indicator
        lux: '#f9e2af', // Yellow - light
        whiteLux: '#cdd6f4', // Light - white light
        irLux: '#f5c2e7', // Pink - infrared
        uvLux: '#b4befe', // Lavender - UV
        windDirection: '#94e2d5', // Teal - wind
        windSpeed: '#89dceb', // Sky - wind
        windGust: '#74c7ec', // Sapphire - wind
        windLull: '#89b4fa', // Blue - wind
        rainfall1h: '#74c7ec', // Sapphire - rain
        rainfall24h: '#7287fd', // Blue - rain
        soilMoisture: '#a6e3a1', // Green - soil
        soilTemperature: '#fab387', // Peach - soil temp
        radiation: '#eba0ac', // Maroon - radiation (warning color)
        distance: '#94e2d5', // Teal - distance/water level
        weight: '#cdd6f4', // Text - weight
        envVoltage: '#f5c2e7', // Pink - deprecated env voltage
        envCurrent: '#cba6f7', // Mauve - deprecated env current
      };
      return colors[type] || '#8884d8';
    };

    if (loading) {
      return <div className="telemetry-loading">{t('telemetry.loading')}</div>;
    }

    if (error) {
      return (
        <div className="telemetry-empty" style={{ color: '#f38ba8' }}>
          {t('common.error')}: {error}
        </div>
      );
    }

    if (telemetryData.length === 0) {
      return <div className="telemetry-empty">{t('telemetry.no_data')}</div>;
    }

    const groupedData = groupByType(telemetryData);

    // Calculate global time range across all telemetry data (excluding solar)
    // Min time: earliest telemetry datapoint, Max time: current time
    // Solar data should not extend the time range beyond actual telemetry data
    const getGlobalTimeRange = (): [number, number] | null => {
      if (telemetryData.length === 0) {
        return null;
      }

      let minTime = Infinity;

      telemetryData.forEach(item => {
        if (item.timestamp < minTime) minTime = item.timestamp;
      });

      if (minTime === Infinity) {
        return null;
      }

      // Use current time as the maximum time
      const maxTime = Date.now();

      return [minTime, maxTime];
    };

    const globalTimeRange = getGlobalTimeRange();
    const globalMinTime = globalTimeRange ? globalTimeRange[0] : undefined;

    // Filter out position telemetry (latitude, longitude)
    // Filter out altitude if it hasn't changed
    const filteredData = Array.from(groupedData.entries()).filter(([type, data]) => {
      // Never show latitude or longitude graphs
      if (type === 'latitude' || type === 'longitude') {
        return false;
      }

      // paxcounterBle is combined into the paxcounterWifi chart
      if (type === 'paxcounterBle') {
        return false;
      }

      // For altitude, only show if values have changed
      if (type === 'altitude') {
        const values = data.map(d => d.value);
        const uniqueValues = new Set(values);
        // If all values are the same, don't show the graph
        return uniqueValues.size > 1;
      }

      return true;
    });

    // Sub-hour windows (e.g. the 15-minute preset) read awkwardly as
    // fractional hours, so render those with a minutes-based title instead.
    const titleText = effectiveHours < 1
      ? t('telemetry.title_minutes', { count: Math.round(effectiveHours * 60) })
      : t('telemetry.title', { count: effectiveHours });

    return (
      <div className="telemetry-graphs">
        <div className="telemetry-graphs-header">
          <h3 className="telemetry-title">{titleText}</h3>
          {showTimeRangeSelector && (
            <div
              className="telemetry-range-selector"
              role="group"
              aria-label={t('telemetry.time_range')}
            >
              {TELEMETRY_RANGE_PRESETS.map(preset => (
                <button
                  key={preset.label}
                  type="button"
                  className={`telemetry-range-btn ${effectiveHours === preset.hours ? 'active' : ''}`}
                  onClick={() => handleSelectRange(preset.hours)}
                  aria-pressed={effectiveHours === preset.hours}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="graphs-grid">
          {filteredData.map(([type, data]) => (
            <TelemetryGraphWidget
              key={type}
              nodeId={nodeId}
              type={type}
              baseUrl={baseUrl}
              data={data}
              isPaxcounterCombined={type === 'paxcounterWifi'}
              bleData={groupedData.get('paxcounterBle')}
              temperatureUnit={temperatureUnit}
              globalTimeRange={globalTimeRange}
              globalMinTime={globalMinTime}
              solarEstimates={solarEstimates}
              solarMonitoringEnabled={solarMonitoringEnabled}
              getSolarVisibility={getSolarVisibility}
              handleToggleSolar={handleToggleSolar}
              favorites={favorites}
              createToggleFavorite={createToggleFavorite}
              handleMenuClick={handleMenuClick}
              openMenu={openMenu}
              menuPosition={menuPosition}
              handlePurgeData={handlePurgeData}
              chartColors={chartColors}
              getTelemetryLabel={getTelemetryLabel}
              getColor={getColor}
              prepareChartData={prepareChartData}
              timeFormat={timeFormat}
              t={t as (key: string, opts?: Record<string, unknown>) => string}
              canEditSettings={canEditSettings}
            />
          ))}
        </div>
      </div>
    );
  }
);

TelemetryGraphs.displayName = 'TelemetryGraphs';

export default TelemetryGraphs;
