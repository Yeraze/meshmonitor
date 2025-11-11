import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './TelemetryGraphs.css';
import { type TemperatureUnit, formatTemperature, getTemperatureUnit } from '../utils/temperature';
import { logger } from '../utils/logger';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface TelemetryData {
  id?: number;
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
  unit?: string;
  createdAt: number;
}

interface TelemetryGraphsProps {
  nodeId: string;
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  baseUrl?: string;
}

interface ChartData {
  timestamp: number;
  value: number | null; // null for solar-only data points
  time: string;
  solarEstimate?: number; // Solar power estimate in watt-hours
}

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

/**
 * Helper function to calculate minimum timestamp from telemetry data
 * Returns Infinity if no valid timestamp found
 */
const getMinTimestamp = (data: TelemetryData[]): number => {
  let minTime = Infinity;
  data.forEach((item) => {
    if (item.timestamp < minTime) minTime = item.timestamp;
  });
  return minTime;
};

const TelemetryGraphs: React.FC<TelemetryGraphsProps> = React.memo(({ nodeId, temperatureUnit = 'C', telemetryHours = 24, baseUrl = '' }) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [telemetryData, setTelemetryData] = useState<TelemetryData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [solarEstimates, setSolarEstimates] = useState<Map<number, number>>(new Map());

  // Get computed CSS color values for chart styling (Recharts doesn't support CSS variables in inline styles)
  const [chartColors, setChartColors] = useState({
    base: '#1e1e2e',
    surface0: '#45475a',
    text: '#cdd6f4'
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
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          updateColors();
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });

    return () => observer.disconnect();
  }, []);

  // Fetch favorites on component mount
  useEffect(() => {
    const fetchFavorites = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/settings`);
        if (response.ok) {
          const settings = await response.json();
          if (settings.telemetryFavorites) {
            const favoritesArray: FavoriteChart[] = JSON.parse(settings.telemetryFavorites);
            const favoritesSet = new Set(
              favoritesArray
                .filter(f => f.nodeId === nodeId)
                .map(f => f.telemetryType)
            );
            setFavorites(favoritesSet);
          }
        }
      } catch (error) {
        logger.error('Error fetching favorites:', error);
      }
    };
    fetchFavorites();
  }, [nodeId]);

  // Memoize telemetry time bounds to prevent unnecessary solar fetches
  // Only recalculates when the actual time range changes, not on every telemetry update
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
      end: Math.floor(Date.now() / 1000)
    };
  }, [telemetryData.length, telemetryData[0]?.timestamp, telemetryData[telemetryData.length - 1]?.timestamp]);

  // Fetch solar estimates only when telemetry time bounds change
  // Using memoized bounds prevents unnecessary fetches on every telemetry update
  useEffect(() => {
    // Don't fetch if no telemetry time bounds available
    if (!telemetryTimeBounds) {
      return;
    }

    let isMounted = true;
    let interval: NodeJS.Timeout | null = null;

    const fetchSolarEstimates = async () => {
      try {
        // Use the range endpoint to fetch only solar data within telemetry bounds
        const response = await fetch(
          `${baseUrl}/api/solar/estimates/range?start=${telemetryTimeBounds.start}&end=${telemetryTimeBounds.end}`
        );
        if (!response.ok) {
          return; // Silently fail if solar monitoring not configured
        }

        const data = await response.json();
        if (isMounted && data.estimates && data.estimates.length > 0) {
          const estimatesMap = new Map<number, number>();
          data.estimates.forEach((est: { timestamp: number; wattHours: number }) => {
            estimatesMap.set(est.timestamp * 1000, est.wattHours); // Convert to milliseconds
          });
          setSolarEstimates(estimatesMap);
        }
      } catch (error) {
        // Silently fail - solar monitoring is optional
        logger.debug('Solar estimates not available:', error);
      }
    };

    fetchSolarEstimates();
    interval = setInterval(fetchSolarEstimates, 60000); // Refresh every minute

    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [baseUrl, telemetryTimeBounds]); // Only depend on time bounds, not entire telemetry array

  useEffect(() => {
    let isMounted = true;

    const fetchTelemetry = async () => {
      try {
        if (isMounted) setLoading(true);
        const response = await fetch(`${baseUrl}/api/telemetry/${nodeId}?hours=${telemetryHours}`);

        if (!response.ok) {
          throw new Error(`Failed to fetch telemetry: ${response.status} ${response.statusText}`);
        }

        const data: TelemetryData[] = await response.json();

        if (isMounted) {
          setTelemetryData(data);
          setError(null);
        }
      } catch (error) {
        logger.error('Error fetching telemetry:', error);
        if (isMounted) {
          setError(error instanceof Error ? error.message : 'Failed to load telemetry data');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 30000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [nodeId, telemetryHours]);

  const toggleFavorite = async (telemetryType: string) => {
    const newFavorites = new Set(favorites);

    if (newFavorites.has(telemetryType)) {
      newFavorites.delete(telemetryType);
    } else {
      newFavorites.add(telemetryType);
    }

    setFavorites(newFavorites);

    // Save to server
    try {
      // First fetch existing favorites for all nodes
      const settingsResponse = await fetch(`${baseUrl}/api/settings`);
      let allFavorites: FavoriteChart[] = [];

      if (settingsResponse.ok) {
        const settings = await settingsResponse.json();
        if (settings.telemetryFavorites) {
          allFavorites = JSON.parse(settings.telemetryFavorites);
          // Remove favorites for current node
          allFavorites = allFavorites.filter(f => f.nodeId !== nodeId);
        }
      }

      // Add new favorites for current node
      newFavorites.forEach(type => {
        allFavorites.push({ nodeId, telemetryType: type });
      });

      // Save updated favorites
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryFavorites: JSON.stringify(allFavorites) })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast('Insufficient permissions to save favorites', 'error');
          setFavorites(favorites);
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (error) {
      logger.error('Error saving favorite:', error);
      showToast('Failed to save favorite. Please try again.', 'error');
      // Revert on error
      setFavorites(favorites);
    }
  };

  // Create stable callback factory for favorite toggles
  const createToggleFavorite = useCallback((type: string) => {
    return () => toggleFavorite(type);
  }, [toggleFavorite]);

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

  const prepareChartData = (data: TelemetryData[], isTemperature: boolean = false, globalMinTime?: number): ChartData[] => {
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
        time: new Date(item.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      });
    });

    // Add solar data points (at their own timestamps)
    // Only include solar data within the GLOBAL telemetry time range
    // This prevents solar data from extending the time axis beyond actual telemetry data
    if (solarEstimates.size > 0 && minTelemetryTime !== Infinity) {
      // Use current time with a 5-minute buffer to account for minor clock differences
      const now = maxTelemetryTime + (5 * 60 * 1000);

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
            time: new Date(timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            solarEstimate: wattHours
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
            solarEstimate: undefined
          });
        }
      }
    }

    return dataWithGaps;
  };

  const getTelemetryLabel = (type: string): string => {
    const labels: { [key: string]: string} = {
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
      altitude: 'Altitude'
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
      snr: '#94e2d5',       // Catppuccin teal - for signal quality (legacy)
      snr_local: '#89dceb', // Catppuccin sky - for local SNR measurements
      snr_remote: '#a6e3a1', // Catppuccin green - for remote SNR reports
      rssi: '#f9e2af',      // Catppuccin yellow - for signal strength
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
      altitude: '#74c0fc'
    };
    return colors[type] || '#8884d8';
  };

  if (loading) {
    return <div className="telemetry-loading">Loading telemetry data...</div>;
  }

  if (error) {
    return <div className="telemetry-empty" style={{ color: '#f38ba8' }}>Error: {error}</div>;
  }

  if (telemetryData.length === 0) {
    return <div className="telemetry-empty">No telemetry data available for this node</div>;
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

    telemetryData.forEach((item) => {
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
      <h3 className="telemetry-title">Last {telemetryHours} Hour{telemetryHours !== 1 ? 's' : ''} Telemetry</h3>
      <div className="graphs-grid">
        {filteredData.map(([type, data]) => {
          const isTemperature = type === 'temperature';
          const chartData = prepareChartData(data, isTemperature, globalMinTime);
          const unit = isTemperature ? getTemperatureUnit(temperatureUnit) : (data[0]?.unit || '');
          const label = getTelemetryLabel(type);
          const color = getColor(type);

          return (
            <div key={type} className="graph-container">
              <div className="graph-header">
                <h4 className="graph-title">{label} {unit && `(${unit})`}</h4>
                <button
                  className={`favorite-btn ${favorites.has(type) ? 'favorited' : ''}`}
                  onClick={createToggleFavorite(type)}
                  aria-label={favorites.has(type) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  {favorites.has(type) ? '★' : '☆'}
                </button>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    domain={globalTimeRange || ['dataMin', 'dataMax']}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(timestamp) => new Date(timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 12 }}
                    domain={['auto', 'auto']}
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
                      color: chartColors.text
                    }}
                    labelStyle={{ color: chartColors.text }}
                    labelFormatter={(value) => {
                      const date = new Date(value);
                      return date.toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      });
                    }}
                  />
                  {solarEstimates.size > 0 && (
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
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          );
        })}
      </div>
    </div>
  );
});

TelemetryGraphs.displayName = 'TelemetryGraphs';

export default TelemetryGraphs;