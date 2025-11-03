import React, { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
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
  value: number;
  time: string;
}

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

const TelemetryGraphs: React.FC<TelemetryGraphsProps> = React.memo(({ nodeId, temperatureUnit = 'C', telemetryHours = 24, baseUrl = '' }) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [telemetryData, setTelemetryData] = useState<TelemetryData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

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

  const prepareChartData = (data: TelemetryData[], isTemperature: boolean = false): ChartData[] => {
    return data
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(item => ({
        timestamp: item.timestamp,
        value: isTemperature ? formatTemperature(item.value, 'C', temperatureUnit) : item.value,
        time: new Date(item.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
      }));
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

  // Calculate global time range across all telemetry data
  // Min time: earliest datapoint, Max time: current time
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
          const chartData = prepareChartData(data, isTemperature);
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
                <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
                    tick={{ fontSize: 12 }}
                    domain={['auto', 'auto']}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1e1e2e',
                      border: '1px solid #45475a',
                      borderRadius: '4px',
                      color: '#cdd6f4'
                    }}
                    labelStyle={{ color: '#cdd6f4' }}
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
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke={color}
                    strokeWidth={2}
                    dot={{ fill: color, r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
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