/**
 * TelemetryChart - Individual telemetry chart component with data fetching
 *
 * This component encapsulates:
 * - Telemetry data fetching via useTelemetry hook
 * - Chart rendering with Recharts
 * - Drag and drop support
 *
 * Each chart manages its own data fetching, which provides:
 * - Automatic caching via TanStack Query
 * - Request deduplication (same node won't be fetched twice)
 * - Independent loading states per chart
 * - Better separation of concerns
 */

import React, { useMemo, useCallback } from 'react';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTelemetry, type TelemetryData } from '../hooks/useTelemetry';
import { type TemperatureUnit, formatTemperature, getTemperatureUnit } from '../utils/temperature';

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
    role?: number | string;
  };
  lastHeard?: number;
  hopsAway?: number;
}

interface ChartData {
  timestamp: number;
  value: number | null;
  time: string;
  solarEstimate?: number;
}

interface TelemetryChartProps {
  id: string;
  favorite: FavoriteChart;
  node: NodeInfo | undefined;
  temperatureUnit: TemperatureUnit;
  hours: number;
  baseUrl: string;
  globalTimeRange: [number, number] | null;
  globalMinTime: number | undefined;
  solarEstimates: Map<number, number>;
  onRemove: (nodeId: string, telemetryType: string) => void;
  onDataLoaded?: (key: string, data: TelemetryData[]) => void;
}

const TELEMETRY_LABELS: Record<string, string> = {
  batteryLevel: 'Battery Level',
  voltage: 'Voltage',
  channelUtilization: 'Channel Utilization',
  airUtilTx: 'Air Utilization (TX)',
  temperature: 'Temperature',
  humidity: 'Humidity',
  pressure: 'Barometric Pressure',
  ch1Voltage: 'Channel 1 Voltage',
  ch1Current: 'Channel 1 Current',
};

const TELEMETRY_COLORS: Record<string, string> = {
  batteryLevel: '#82ca9d',
  voltage: '#8884d8',
  channelUtilization: '#ffc658',
  airUtilTx: '#ff7c7c',
  temperature: '#ff8042',
  humidity: '#00c4cc',
  pressure: '#a28dff',
  ch1Voltage: '#d084d8',
  ch1Current: '#ff6b9d',
};

const getTelemetryLabel = (type: string): string => TELEMETRY_LABELS[type] || type;
const getColor = (type: string): string => TELEMETRY_COLORS[type] || '#8884d8';

/**
 * Format node name with both longName and shortName
 */
const formatNodeName = (node: NodeInfo | undefined, fallbackId: string): string => {
  if (!node?.user) return fallbackId;

  if (node.user.longName && node.user.shortName) {
    return `${node.user.longName} (${node.user.shortName})`;
  }
  return node.user.longName || node.user.shortName || fallbackId;
};

/**
 * Prepare chart data with solar estimates overlay
 */
const prepareChartData = (
  data: TelemetryData[],
  isTemperature: boolean,
  temperatureUnit: TemperatureUnit,
  solarEstimates: Map<number, number>,
  globalMinTime?: number
): ChartData[] => {
  const allTimestamps = new Map<number, ChartData>();

  // Calculate minimum telemetry time
  let minTelemetryTime = Infinity;
  data.forEach(item => {
    if (item.timestamp < minTelemetryTime) minTelemetryTime = item.timestamp;
  });

  const effectiveMinTime = globalMinTime !== undefined ? globalMinTime : minTelemetryTime;

  // Add telemetry data points
  data.forEach(item => {
    allTimestamps.set(item.timestamp, {
      timestamp: item.timestamp,
      value: isTemperature ? formatTemperature(item.value, 'C', temperatureUnit) : item.value,
      time: new Date(item.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  });

  // Add solar data points within telemetry time range
  if (solarEstimates.size > 0 && effectiveMinTime !== Infinity) {
    const now = Date.now() + 5 * 60 * 1000; // 5-minute buffer

    solarEstimates.forEach((wattHours, timestamp) => {
      if (timestamp < effectiveMinTime || timestamp > now) return;

      if (allTimestamps.has(timestamp)) {
        allTimestamps.get(timestamp)!.solarEstimate = wattHours;
      } else {
        allTimestamps.set(timestamp, {
          timestamp,
          value: null,
          time: new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
          solarEstimate: wattHours,
        });
      }
    });
  }

  // Sort and insert gaps for breaks > 3 hours
  const sortedData = Array.from(allTimestamps.values()).sort((a, b) => a.timestamp - b.timestamp);
  const threeHours = 3 * 60 * 60 * 1000;
  const dataWithGaps: ChartData[] = [];

  for (let i = 0; i < sortedData.length; i++) {
    dataWithGaps.push(sortedData[i]);

    if (i < sortedData.length - 1) {
      const timeDiff = sortedData[i + 1].timestamp - sortedData[i].timestamp;
      if (timeDiff > threeHours) {
        dataWithGaps.push({
          timestamp: sortedData[i].timestamp + 1,
          value: null,
          time: '',
          solarEstimate: undefined,
        });
      }
    }
  }

  return dataWithGaps;
};

const TelemetryChart: React.FC<TelemetryChartProps> = React.memo(
  ({
    id,
    favorite,
    node,
    temperatureUnit,
    hours,
    baseUrl,
    globalTimeRange,
    globalMinTime,
    solarEstimates,
    onRemove,
    onDataLoaded,
  }) => {
    // Fetch telemetry data using the hook
    const { data: rawTelemetryData, isLoading, error } = useTelemetry({
      nodeId: favorite.nodeId,
      hours,
      baseUrl,
      enabled: true,
    });

    // Filter data to only the specific telemetry type
    const telemetryData = useMemo(() => {
      if (!rawTelemetryData) return [];
      return rawTelemetryData.filter(d => d.telemetryType === favorite.telemetryType);
    }, [rawTelemetryData, favorite.telemetryType]);

    // Notify parent of loaded data for global time range calculation
    React.useEffect(() => {
      if (telemetryData.length > 0 && onDataLoaded) {
        onDataLoaded(`${favorite.nodeId}-${favorite.telemetryType}`, telemetryData);
      }
    }, [telemetryData, favorite.nodeId, favorite.telemetryType, onDataLoaded]);

    // Drag and drop
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

    const handleRemoveClick = useCallback(() => {
      onRemove(favorite.nodeId, favorite.telemetryType);
    }, [favorite.nodeId, favorite.telemetryType, onRemove]);

    const style = {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.5 : 1,
    };

    const nodeName = formatNodeName(node, favorite.nodeId);
    const isTemperature = favorite.telemetryType === 'temperature';
    const color = getColor(favorite.telemetryType);
    const label = getTelemetryLabel(favorite.telemetryType);

    // Loading state
    if (isLoading) {
      return (
        <div ref={setNodeRef} style={style} className="dashboard-chart-container">
          <div className="dashboard-chart-header">
            <div className="dashboard-drag-handle" {...attributes} {...listeners}>
              ⋮⋮
            </div>
            <h3 className="dashboard-chart-title" title={`${nodeName} - ${label}`}>
              {nodeName} - {label}
            </h3>
            <button className="dashboard-remove-btn" onClick={handleRemoveClick} aria-label="Remove from dashboard">
              ✕
            </button>
          </div>
          <div className="dashboard-loading-chart">Loading...</div>
        </div>
      );
    }

    // Error state
    if (error) {
      return (
        <div ref={setNodeRef} style={style} className="dashboard-chart-container">
          <div className="dashboard-chart-header">
            <div className="dashboard-drag-handle" {...attributes} {...listeners}>
              ⋮⋮
            </div>
            <h3 className="dashboard-chart-title" title={`${nodeName} - ${label}`}>
              {nodeName} - {label}
            </h3>
            <button className="dashboard-remove-btn" onClick={handleRemoveClick} aria-label="Remove from dashboard">
              ✕
            </button>
          </div>
          <div className="dashboard-error-chart">Error loading data</div>
        </div>
      );
    }

    // No data state
    if (telemetryData.length === 0) {
      return (
        <div ref={setNodeRef} style={style} className="dashboard-chart-container">
          <div className="dashboard-chart-header">
            <div className="dashboard-drag-handle" {...attributes} {...listeners}>
              ⋮⋮
            </div>
            <h3 className="dashboard-chart-title" title={`${nodeName} - ${label}`}>
              {nodeName} - {label}
            </h3>
            <button className="dashboard-remove-btn" onClick={handleRemoveClick} aria-label="Remove from dashboard">
              ✕
            </button>
          </div>
          <div className="dashboard-no-data">No data available</div>
        </div>
      );
    }

    // Prepare chart data
    const chartData = prepareChartData(telemetryData, isTemperature, temperatureUnit, solarEstimates, globalMinTime);
    const unit = isTemperature ? getTemperatureUnit(temperatureUnit) : telemetryData[0]?.unit || '';

    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        <div className="dashboard-chart-header">
          <div className="dashboard-drag-handle" {...attributes} {...listeners}>
            ⋮⋮
          </div>
          <h3
            className="dashboard-chart-title"
            title={`${nodeName} - ${label} ${unit ? `(${unit})` : ''}`}
          >
            {nodeName} - {label} {unit && `(${unit})`}
          </h3>
          <button className="dashboard-remove-btn" onClick={handleRemoveClick} aria-label="Remove from dashboard">
            ✕
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
              tickFormatter={timestamp =>
                new Date(timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              }
            />
            <YAxis yAxisId="left" tick={{ fontSize: 12 }} domain={['auto', 'auto']} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} domain={['auto', 'auto']} hide={true} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e1e2e',
                border: '1px solid #45475a',
                borderRadius: '4px',
                color: '#cdd6f4',
              }}
              labelStyle={{ color: '#cdd6f4' }}
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
  }
);

TelemetryChart.displayName = 'TelemetryChart';

export default TelemetryChart;
export { getTelemetryLabel, getColor };
export type { FavoriteChart, NodeInfo };
