/**
 * SmartHopsChart - Individual smart hops chart component for Dashboard
 *
 * This component displays smart hops statistics (min/max/avg) as a multi-line chart.
 * Used by the Dashboard to display favorited smart hops charts.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSmartHops, type SmartHopsData } from '../hooks/useSmartHops';
import { formatChartAxisTimestamp } from '../utils/datetime';
import { SMART_HOPS_TYPE } from './SmartHopsGraphs';
import type { TelemetryNodeInfo } from '../types/device';

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

interface SmartHopsChartProps {
  id: string;
  favorite: FavoriteChart;
  node: TelemetryNodeInfo | undefined;
  hours: number;
  baseUrl: string;
  globalTimeRange: [number, number] | null;
  onRemove: (nodeId: string, telemetryType: string) => void;
}

// Hop metrics configuration
const HOP_METRICS = [
  { key: 'minHops' as keyof SmartHopsData, label: 'smart_hops_min', color: '#a6e3a1' },
  { key: 'avgHops' as keyof SmartHopsData, label: 'smart_hops_avg', color: '#89b4fa' },
  { key: 'maxHops' as keyof SmartHopsData, label: 'smart_hops_max', color: '#f38ba8' },
];

/**
 * Process smart hops data and insert gaps for breaks > 1 hour
 */
function processHopsData(data: SmartHopsData[] | undefined): Array<Record<string, number | null>> {
  if (!data || data.length === 0) return [];

  // Sort by timestamp ascending
  const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp);

  const oneHour = 60 * 60 * 1000;
  const result: Array<Record<string, number | null>> = [];

  for (let i = 0; i < sorted.length; i++) {
    result.push({
      timestamp: sorted[i].timestamp,
      minHops: sorted[i].minHops,
      avgHops: sorted[i].avgHops,
      maxHops: sorted[i].maxHops,
    });

    if (i < sorted.length - 1) {
      const timeDiff = sorted[i + 1].timestamp - sorted[i].timestamp;
      if (timeDiff > oneHour) {
        // Insert a gap point
        result.push({
          timestamp: sorted[i].timestamp + 1,
          minHops: null,
          avgHops: null,
          maxHops: null,
        });
      }
    }
  }

  return result;
}

const SmartHopsChart: React.FC<SmartHopsChartProps> = ({
  id,
  favorite,
  node,
  hours,
  baseUrl,
  globalTimeRange,
  onRemove,
}) => {
  const { t } = useTranslation();

  // Fetch smart hops data
  const { data: hopsData, isLoading, error } = useSmartHops({
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
  const chartData = useMemo(() => processHopsData(hopsData), [hopsData]);

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
  const chartTitle = t('info.smart_hops_title');
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
        <div className="dashboard-no-data">{t('info.smart_hops_no_data')}</div>
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
          <YAxis
            tick={{ fontSize: 12 }}
            domain={[0, 'auto']}
            tickFormatter={value => Math.round(value).toString()}
            allowDecimals={false}
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
              });
            }}
            formatter={(value, name: string) => {
              if (value === null || value === undefined) return ['-', t(`info.${name}`)];
              const numValue = typeof value === 'number' ? value : parseFloat(String(value));
              if (isNaN(numValue)) return ['-', t(`info.${name}`)];
              return [`${numValue.toFixed(1)} hops`, t(`info.${name}`)];
            }}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            formatter={(value: string) => {
              const metric = HOP_METRICS.find(m => m.key === value);
              return metric ? t(`info.${metric.label}`) : value;
            }}
          />
          {HOP_METRICS.map(metric => (
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

export default SmartHopsChart;

// Helper to check if a telemetry type is smart hops
export function isSmartHopsType(telemetryType: string): boolean {
  return telemetryType === SMART_HOPS_TYPE;
}
