/**
 * PacketRateChart - Individual packet rate chart component for Dashboard
 *
 * This component displays packet rate statistics (RX or TX) as a multi-line chart.
 * Used by the Dashboard to display favorited packet rate charts.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { usePacketRates, type PacketRatesResponse } from '../hooks/usePacketRates';
import { formatChartAxisTimestamp } from '../utils/datetime';
import { PACKET_RATE_RX_TYPE, PACKET_RATE_TX_TYPE } from './PacketRateGraphs';
import type { TelemetryNodeInfo } from '../types/device';

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

interface PacketRateChartProps {
  id: string;
  favorite: FavoriteChart;
  node: TelemetryNodeInfo | undefined;
  hours: number;
  baseUrl: string;
  globalTimeRange: [number, number] | null;
  onRemove: (nodeId: string, telemetryType: string) => void;
}

// RX metrics configuration
const RX_METRICS = [
  { key: 'numPacketsRx' as keyof PacketRatesResponse, label: 'Packets Received', color: '#a6e3a1' },
  { key: 'numPacketsRxBad' as keyof PacketRatesResponse, label: 'Bad Packets', color: '#f38ba8' },
  { key: 'numRxDupe' as keyof PacketRatesResponse, label: 'Duplicates', color: '#fab387' },
];

// TX metrics configuration
const TX_METRICS = [
  { key: 'numPacketsTx' as keyof PacketRatesResponse, label: 'Packets Transmitted', color: '#89b4fa' },
  { key: 'numTxDropped' as keyof PacketRatesResponse, label: 'Dropped', color: '#f38ba8' },
  { key: 'numTxRelay' as keyof PacketRatesResponse, label: 'Relayed', color: '#a6e3a1' },
  { key: 'numTxRelayCanceled' as keyof PacketRatesResponse, label: 'Relay Canceled', color: '#fab387' },
];

/**
 * Merge multiple rate data arrays into a single array for charting
 */
function mergeRateData(
  data: PacketRatesResponse | undefined,
  metrics: Array<{ key: keyof PacketRatesResponse; label: string; color: string }>
): Array<Record<string, number | null>> {
  if (!data) return [];

  const allTimestamps = new Set<number>();
  for (const metric of metrics) {
    const metricData = data[metric.key];
    if (metricData) {
      for (const point of metricData) {
        allTimestamps.add(point.timestamp);
      }
    }
  }

  if (allTimestamps.size === 0) return [];

  const lookups: Record<string, Map<number, number>> = {};
  for (const metric of metrics) {
    const metricData = data[metric.key];
    lookups[metric.key] = new Map();
    if (metricData) {
      for (const point of metricData) {
        lookups[metric.key].set(point.timestamp, point.ratePerMinute);
      }
    }
  }

  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
  const result: Array<Record<string, number | null>> = [];

  for (const timestamp of sortedTimestamps) {
    const point: Record<string, number | null> = { timestamp };
    for (const metric of metrics) {
      const value = lookups[metric.key].get(timestamp);
      point[metric.key] = value !== undefined ? value : null;
    }
    result.push(point);
  }

  // Insert gaps for breaks > 1 hour
  const oneHour = 60 * 60 * 1000;
  const dataWithGaps: Array<Record<string, number | null>> = [];

  for (let i = 0; i < result.length; i++) {
    dataWithGaps.push(result[i]);
    if (i < result.length - 1) {
      const timeDiff = (result[i + 1].timestamp as number) - (result[i].timestamp as number);
      if (timeDiff > oneHour) {
        const gapPoint: Record<string, number | null> = {
          timestamp: (result[i].timestamp as number) + 1,
        };
        for (const metric of metrics) {
          gapPoint[metric.key] = null;
        }
        dataWithGaps.push(gapPoint);
      }
    }
  }

  return dataWithGaps;
}

const PacketRateChart: React.FC<PacketRateChartProps> = ({
  id,
  favorite,
  node,
  hours,
  baseUrl,
  globalTimeRange,
  onRemove,
}) => {
  const { t } = useTranslation();

  // Determine if this is RX or TX chart
  const isRxChart = favorite.telemetryType === PACKET_RATE_RX_TYPE;
  const metrics = isRxChart ? RX_METRICS : TX_METRICS;

  // Fetch packet rate data
  const { data: rateData, isLoading, error } = usePacketRates({
    nodeId: favorite.nodeId,
    hours,
    baseUrl,
  });

  // Get computed CSS color values for chart styling
  const [chartColors, setChartColors] = useState({
    base: '#1e1e2e',
    surface0: '#45475a',
    text: '#cdd6f4',
  });

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
    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // Prepare chart data
  const chartData = useMemo(() => mergeRateData(rateData, metrics), [rateData, metrics]);

  // Drag and drop support
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const handleRemoveClick = useCallback(() => {
    onRemove(favorite.nodeId, favorite.telemetryType);
  }, [favorite.nodeId, favorite.telemetryType, onRemove]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Get node name for display
  const nodeName = node?.user?.longName || node?.user?.shortName || favorite.nodeId;
  const chartTitle = isRxChart ? t('info.rx_rates') : t('info.tx_rates');
  const label = `${nodeName} - ${chartTitle}`;

  if (isLoading) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        <div className="dashboard-chart-header">
          <div className="dashboard-drag-handle" {...attributes} {...listeners}>
            ⋮⋮
          </div>
          <h3 className="dashboard-chart-title" title={label}>
            {label}
          </h3>
          <button
            className="dashboard-remove-btn"
            onClick={handleRemoveClick}
            aria-label={t('dashboard.remove_from_dashboard')}
          >
            ✕
          </button>
        </div>
        <div className="dashboard-loading-chart">{t('dashboard.loading_chart')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        <div className="dashboard-chart-header">
          <div className="dashboard-drag-handle" {...attributes} {...listeners}>
            ⋮⋮
          </div>
          <h3 className="dashboard-chart-title" title={label}>
            {label}
          </h3>
          <button
            className="dashboard-remove-btn"
            onClick={handleRemoveClick}
            aria-label={t('dashboard.remove_from_dashboard')}
          >
            ✕
          </button>
        </div>
        <div className="dashboard-error-chart">{t('dashboard.error_chart')}</div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        <div className="dashboard-chart-header">
          <div className="dashboard-drag-handle" {...attributes} {...listeners}>
            ⋮⋮
          </div>
          <h3 className="dashboard-chart-title" title={label}>
            {label}
          </h3>
          <button
            className="dashboard-remove-btn"
            onClick={handleRemoveClick}
            aria-label={t('dashboard.remove_from_dashboard')}
          >
            ✕
          </button>
        </div>
        <div className="dashboard-no-data">{t('info.no_rate_data')}</div>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container">
      <div className="dashboard-chart-header">
        <div className="dashboard-drag-handle" {...attributes} {...listeners}>
          ⋮⋮
        </div>
        <h3 className="dashboard-chart-title" title={label}>
          {label}
        </h3>
        <button
          className="dashboard-remove-btn"
          onClick={handleRemoveClick}
          aria-label={t('dashboard.remove_from_dashboard')}
        >
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
            tickFormatter={timestamp => formatChartAxisTimestamp(timestamp, globalTimeRange)}
          />
          <YAxis tick={{ fontSize: 12 }} domain={[0, 'auto']} tickFormatter={value => value.toFixed(1)} />
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
              });
            }}
            formatter={(value, name) => {
              const label = name ?? '';
              if (value === null || value === undefined) return ['-', label];
              const numValue = typeof value === 'number' ? value : parseFloat(String(value));
              if (isNaN(numValue)) return ['-', label];
              return [`${numValue.toFixed(2)} pkts/min`, label];
            }}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            formatter={(value) => {
              const strValue = String(value ?? '');
              const metric = metrics.find(m => m.key === strValue);
              return metric?.label || strValue;
            }}
          />
          {metrics.map(metric => (
            <Line
              key={metric.key}
              type="monotone"
              dataKey={metric.key}
              name={metric.key}
              stroke={metric.color}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default PacketRateChart;

// Helper to check if a telemetry type is a packet rate type
export function isPacketRateType(telemetryType: string): boolean {
  return telemetryType === PACKET_RATE_RX_TYPE || telemetryType === PACKET_RATE_TX_TYPE;
}
