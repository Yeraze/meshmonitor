import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './TelemetryGraphs.css';
import { type TemperatureUnit, formatTemperature, getTemperatureUnit } from '../utils/temperature';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useTelemetry, useSolarEstimates, type TelemetryData } from '../hooks/useTelemetry';
import { useFavorites, useToggleFavorite } from '../hooks/useFavorites';
import { formatChartAxisTimestamp, formatTime } from '../utils/datetime';
import { useSettings } from '../contexts/SettingsContext';
import { ChartData } from '../types/ui';

interface TelemetryGraphsProps {
  nodeId: string;
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  baseUrl?: string;
}

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

const TelemetryGraphs: React.FC<TelemetryGraphsProps> = React.memo(
  ({ nodeId, temperatureUnit = 'C', telemetryHours = 24, baseUrl = '' }) => {
    const { t } = useTranslation();
    const csrfFetch = useCsrfFetch();
    const { showToast } = useToast();
    const { solarMonitoringEnabled, timeFormat } = useSettings();
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const [menuPosition, setMenuPosition] = useState<{
      x: number;
      y: number;
    } | null>(null);
    // Track solar visibility per telemetry type
    const [solarVisibility, setSolarVisibility] = useState<Map<string, boolean>>(new Map());

    // Fetch telemetry data using TanStack Query
    const {
      data: telemetryData = [],
      isLoading: loading,
      error: telemetryError,
      refetch: refetchTelemetry,
    } = useTelemetry({
      nodeId,
      hours: telemetryHours,
      baseUrl,
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

    const getTelemetryLabel = (type: string): string => {
      const labels: { [key: string]: string } = {
        batteryLevel: 'Battery Level',
        voltage: 'Voltage',
        channelUtilization: 'Channel Utilization',
        airUtilTx: 'Air Utilization (TX)',
        temperature: 'Temperature',
        humidity: 'Humidity',
        pressure: 'Barometric Pressure',
        snr: 'Signal-to-Noise Ratio (SNR)',
        snr_local: 'SNR - Local (Our Measurements)',
        snr_remote: 'SNR - Remote (Node Reports)',
        rssi: 'Signal Strength (RSSI)',
        ch1Voltage: 'Channel 1 Voltage',
        ch1Current: 'Channel 1 Current',
        ch2Voltage: 'Channel 2 Voltage',
        ch2Current: 'Channel 2 Current',
        ch3Voltage: 'Channel 3 Voltage',
        ch3Current: 'Channel 3 Current',
        ch4Voltage: 'Channel 4 Voltage',
        ch4Current: 'Channel 4 Current',
        ch5Voltage: 'Channel 5 Voltage',
        ch5Current: 'Channel 5 Current',
        ch6Voltage: 'Channel 6 Voltage',
        ch6Current: 'Channel 6 Current',
        ch7Voltage: 'Channel 7 Voltage',
        ch7Current: 'Channel 7 Current',
        ch8Voltage: 'Channel 8 Voltage',
        ch8Current: 'Channel 8 Current',
        altitude: 'Altitude',
        sats_in_view: 'GPS Satellites',
        // Air Quality metrics
        pm10Standard: 'PM1.0 (Standard)',
        pm25Standard: 'PM2.5 (Standard)',
        pm100Standard: 'PM10 (Standard)',
        pm10Environmental: 'PM1.0 (Environmental)',
        pm25Environmental: 'PM2.5 (Environmental)',
        pm100Environmental: 'PM10 (Environmental)',
        particles03um: 'Particles 0.3µm',
        particles05um: 'Particles 0.5µm',
        particles10um: 'Particles 1.0µm',
        particles25um: 'Particles 2.5µm',
        particles50um: 'Particles 5.0µm',
        particles100um: 'Particles 10µm',
        co2: 'CO₂',
        co2Temperature: 'CO₂ Sensor Temperature',
        co2Humidity: 'CO₂ Sensor Humidity',
        // Paxcounter metrics
        paxcounterWifi: 'Paxcounter WiFi',
        paxcounterBle: 'Paxcounter BLE',
        paxcounterUptime: 'Paxcounter Uptime',
        // LocalStats metrics (from connected Meshtastic device)
        uptimeSeconds: 'Device Uptime',
        numOnlineNodes: 'Online Nodes (Device)',
        numTotalNodes: 'Total Nodes (Device)',
        numPacketsTx: 'Packets TX (Device)',
        numPacketsRx: 'Packets RX (Device)',
        numPacketsRxBad: 'Bad Packets RX (Device)',
        numRxDupe: 'Duplicate Packets (Device)',
        numTxRelay: 'Relayed TX (Device)',
        numTxRelayCanceled: 'Canceled Relay TX (Device)',
        numTxDropped: 'Dropped TX (Device)',
        heapTotalBytes: 'Heap Total (Device)',
        heapFreeBytes: 'Heap Free (Device)',
        // MeshMonitor system metrics (calculated by MeshMonitor)
        systemNodeCount: 'Active Nodes (MeshMonitor)',
        systemDirectNodeCount: 'Direct Nodes (MeshMonitor)',
        timeOffset: 'Clock Offset (Server \u2212 Node)',
        // HostMetrics (for Linux devices)
        hostUptimeSeconds: 'Host Uptime',
        hostFreememBytes: 'Host Free Memory',
        hostLoad1: 'Host Load (1 min)',
        hostLoad5: 'Host Load (5 min)',
        hostLoad15: 'Host Load (15 min)',
        // Extended Environment metrics
        gasResistance: 'Gas Resistance',
        iaq: 'Indoor Air Quality (IAQ)',
        lux: 'Ambient Light',
        whiteLux: 'White Light',
        irLux: 'Infrared Light',
        uvLux: 'UV Light',
        windDirection: 'Wind Direction',
        windSpeed: 'Wind Speed',
        windGust: 'Wind Gust',
        windLull: 'Wind Lull',
        rainfall1h: 'Rainfall (1 hour)',
        rainfall24h: 'Rainfall (24 hours)',
        soilMoisture: 'Soil Moisture',
        soilTemperature: 'Soil Temperature',
        radiation: 'Radiation',
        distance: 'Distance (Water Level)',
        weight: 'Weight',
        envVoltage: 'Environment Voltage',
        envCurrent: 'Environment Current',
      };
      return labels[type] || type;
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

    return (
      <div className="telemetry-graphs">
        <h3 className="telemetry-title">{t('telemetry.title', { count: telemetryHours })}</h3>
        <div className="graphs-grid">
          {filteredData.map(([type, data]) => {
            const isPaxcounterCombined = type === 'paxcounterWifi';
            const isTemperature = type === 'temperature';
            const chartData = prepareChartData(data, isTemperature, globalMinTime);
            const unit = isTemperature ? getTemperatureUnit(temperatureUnit) : data[0]?.unit || '';
            const label = isPaxcounterCombined ? 'Paxcounter' : getTelemetryLabel(type);
            const color = getColor(type);

            // For paxcounter combined chart, merge BLE data into the same chart data
            if (isPaxcounterCombined) {
              const bleData = groupedData.get('paxcounterBle');
              // Re-key: rename 'value' to 'paxWifi', add 'paxBle' from BLE data
              const bleByTimestamp = new Map<number, number>();
              if (bleData) {
                bleData.forEach(item => bleByTimestamp.set(item.timestamp, item.value));
              }
              chartData.forEach(point => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const p = point as any;
                p.paxWifi = point.value;
                p.paxBle = bleByTimestamp.get(point.timestamp) ?? null;
                bleByTimestamp.delete(point.timestamp);
              });
              // Add BLE-only timestamps
              bleByTimestamp.forEach((value, timestamp) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const point: any = {
                  timestamp,
                  value: null,
                  time: formatTime(new Date(timestamp), timeFormat),
                  paxWifi: null,
                  paxBle: value,
                };
                chartData.push(point);
              });
              chartData.sort((a, b) => a.timestamp - b.timestamp);
            }

            return (
              <div key={type} className="graph-container">
                <div className="graph-header">
                  <h4 className="graph-title" title={`${label} ${unit ? `(${unit})` : ''}`}>
                    {label} {unit && `(${unit})`}
                  </h4>
                  <div className="graph-actions">
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
                      allowDecimals={type !== 'sats_in_view'}
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
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

TelemetryGraphs.displayName = 'TelemetryGraphs';

export default TelemetryGraphs;
