import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './Dashboard.css';
import { type TemperatureUnit, formatTemperature, getTemperatureUnit } from '../utils/temperature';
import { logger } from '../utils/logger';
import api from '../services/api';

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

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

interface NodeInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName?: string;
    shortName?: string;
    hwModel?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number | null;
    voltage?: number | null;
    channelUtilization?: number | null;
    airUtilTx?: number | null;
  };
  lastHeard?: number;
  snr?: number;
  rssi?: number;
}

interface ChartData {
  timestamp: number;
  value: number;
  time: string;
}

interface DashboardProps {
  temperatureUnit?: TemperatureUnit;
  telemetryHours?: number;
  baseUrl: string;
}

const Dashboard: React.FC<DashboardProps> = React.memo(({ temperatureUnit = 'C', telemetryHours = 24, baseUrl }) => {
  const [favorites, setFavorites] = useState<FavoriteChart[]>([]);
  const [telemetryData, setTelemetryData] = useState<Map<string, TelemetryData[]>>(new Map());
  const [nodes, setNodes] = useState<Map<string, NodeInfo>>(new Map());
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch favorites and node information
  useEffect(() => {
    const fetchFavoritesAndNodes = async () => {
      try {
        setLoading(true);

        // Fetch favorites from settings
        const settings = await api.get<{ telemetryFavorites?: string }>('/api/settings');
        const favoritesArray: FavoriteChart[] = settings.telemetryFavorites
          ? JSON.parse(settings.telemetryFavorites)
          : [];

        setFavorites(favoritesArray);

        // Fetch node information
        const nodesData = await api.get<NodeInfo[]>('/api/nodes');
        const nodesMap = new Map<string, NodeInfo>();
        nodesData.forEach((node: NodeInfo) => {
          if (node.user?.id) {
            nodesMap.set(node.user.id, node);
          }
        });
        setNodes(nodesMap);

        // Fetch telemetry data for each favorite
        const telemetryMap = new Map<string, TelemetryData[]>();

        await Promise.all(
          favoritesArray.map(async (favorite) => {
            try {
              const data: TelemetryData[] = await api.get(`/api/telemetry/${favorite.nodeId}?hours=${telemetryHours}`);
              // Filter to only get the specific telemetry type
              const filteredData = data.filter(d => d.telemetryType === favorite.telemetryType);
              const key = `${favorite.nodeId}-${favorite.telemetryType}`;
              telemetryMap.set(key, filteredData);
            } catch (err) {
              logger.error(`Error fetching telemetry for ${favorite.nodeId}:`, err);
            }
          })
        );

        setTelemetryData(telemetryMap);
        setError(null);
      } catch (err) {
        logger.error('Error in Dashboard:', err);
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    };

    fetchFavoritesAndNodes();
    const interval = setInterval(fetchFavoritesAndNodes, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [telemetryHours, baseUrl]);

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
      ch1Current: 'Channel 1 Current'
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
      ch1Current: '#ff6b9d'
    };
    return colors[type] || '#8884d8';
  };

  // Calculate global time range across all telemetry data
  const getGlobalTimeRange = (): [number, number] | null => {
    let minTime = Infinity;
    let maxTime = -Infinity;

    telemetryData.forEach((data) => {
      data.forEach((item) => {
        if (item.timestamp < minTime) minTime = item.timestamp;
        if (item.timestamp > maxTime) maxTime = item.timestamp;
      });
    });

    if (minTime === Infinity || maxTime === -Infinity) {
      return null;
    }

    return [minTime, maxTime];
  };

  const removeFavorite = async (nodeId: string, telemetryType: string) => {
    try {
      const newFavorites = favorites.filter(
        f => !(f.nodeId === nodeId && f.telemetryType === telemetryType)
      );

      // Update local state
      setFavorites(newFavorites);

      // Remove from telemetry data
      const key = `${nodeId}-${telemetryType}`;
      const newTelemetryData = new Map(telemetryData);
      newTelemetryData.delete(key);
      setTelemetryData(newTelemetryData);

      // Save to server
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryFavorites: JSON.stringify(newFavorites) })
      });
    } catch (error) {
      logger.error('Error removing favorite:', error);
      // Revert on error
      window.location.reload();
    }
  };

  if (loading) {
    return <div className="dashboard-loading">Loading dashboard...</div>;
  }

  if (error) {
    return <div className="dashboard-error">Error: {error}</div>;
  }

  if (favorites.length === 0) {
    return (
      <div className="dashboard-empty">
        <h2>No Favorites Yet</h2>
        <p>Star telemetry charts in the Nodes tab to see them here</p>
      </div>
    );
  }

  // Get global time range for all charts
  const globalTimeRange = getGlobalTimeRange();

  return (
    <div className="dashboard">
      <h2 className="dashboard-title">Telemetry Dashboard</h2>
      <p className="dashboard-subtitle">Showing last {telemetryHours} hours of favorited telemetry</p>

      <div className="dashboard-grid">
        {favorites.map((favorite) => {
          const key = `${favorite.nodeId}-${favorite.telemetryType}`;
          const data = telemetryData.get(key) || [];
          const node = nodes.get(favorite.nodeId);

          // Format node name with both longName and shortName
          let nodeName = '';
          if (node?.user) {
            if (node.user.longName && node.user.shortName) {
              nodeName = `${node.user.longName} (${node.user.shortName})`;
            } else if (node.user.longName) {
              nodeName = node.user.longName;
            } else if (node.user.shortName) {
              nodeName = node.user.shortName;
            } else {
              nodeName = favorite.nodeId;
            }
          } else {
            nodeName = favorite.nodeId;
          }

          if (data.length === 0) {
            return (
              <div key={key} className="dashboard-chart-container">
                <div className="dashboard-chart-header">
                  <h3 className="dashboard-chart-title">
                    {nodeName} - {getTelemetryLabel(favorite.telemetryType)}
                  </h3>
                  <button
                    className="dashboard-remove-btn"
                    onClick={() => removeFavorite(favorite.nodeId, favorite.telemetryType)}
                    aria-label="Remove from dashboard"
                  >
                    ✕
                  </button>
                </div>
                <div className="dashboard-no-data">No data available</div>
              </div>
            );
          }

          const isTemperature = favorite.telemetryType === 'temperature';
          const chartData = prepareChartData(data, isTemperature);
          const unit = isTemperature ? getTemperatureUnit(temperatureUnit) : (data[0]?.unit || '');
          const color = getColor(favorite.telemetryType);

          return (
            <div key={key} className="dashboard-chart-container">
              <div className="dashboard-chart-header">
                <h3 className="dashboard-chart-title">
                  {nodeName} - {getTelemetryLabel(favorite.telemetryType)} {unit && `(${unit})`}
                </h3>
                <button
                  className="dashboard-remove-btn"
                  onClick={() => removeFavorite(favorite.nodeId, favorite.telemetryType)}
                  aria-label="Remove from dashboard"
                >
                  ✕
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

Dashboard.displayName = 'Dashboard';

export default Dashboard;