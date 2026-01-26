/**
 * LinkQualityChart - Individual link quality chart component for Dashboard
 *
 * This component displays link quality history as a line chart.
 * Used by the Dashboard to display favorited link quality charts.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useLinkQuality, type LinkQualityData } from '../hooks/useLinkQuality';
import { formatChartAxisTimestamp } from '../utils/datetime';
import { LINK_QUALITY_TYPE } from './LinkQualityGraph';
import type { TelemetryNodeInfo } from '../types/device';

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

interface LinkQualityChartProps {
  id: string;
  favorite: FavoriteChart;
  node: TelemetryNodeInfo | undefined;
  hours: number;
  baseUrl: string;
  globalTimeRange: [number, number] | null;
  onRemove: (nodeId: string, telemetryType: string) => void;
}

/**
 * Get quality label based on value
 */
function getQualityLabel(quality: number, t: (key: string) => string): string {
  if (quality === 0) return t('info.link_quality_dead');
  if (quality <= 3) return t('info.link_quality_poor');
  if (quality <= 6) return t('info.link_quality_moderate');
  if (quality <= 8) return t('info.link_quality_good');
  return t('info.link_quality_excellent');
}

/**
 * Process link quality data for charting
 */
function processLinkQualityData(data: LinkQualityData[] | undefined): Array<Record<string, number>> {
  if (!data || data.length === 0) return [];

  // Sort by timestamp ascending and map to chart format
  return [...data]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(d => ({
      timestamp: d.timestamp,
      quality: d.quality,
    }));
}

const LinkQualityChart: React.FC<LinkQualityChartProps> = ({
  id,
  favorite,
  node,
  hours,
  baseUrl,
  globalTimeRange,
  onRemove,
}) => {
  const { t } = useTranslation();

  // Fetch link quality data
  const { data: qualityData, isLoading, error } = useLinkQuality({
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
  const chartData = useMemo(() => processLinkQualityData(qualityData), [qualityData]);

  // Get current (latest) quality value for title display
  const currentQuality = useMemo(() => {
    if (!qualityData || qualityData.length === 0) return null;
    const sorted = [...qualityData].sort((a, b) => b.timestamp - a.timestamp);
    return sorted[0].quality;
  }, [qualityData]);

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
  const chartTitle = t('info.link_quality_title');
  const label = currentQuality !== null
    ? `${nodeName} - ${chartTitle} (${currentQuality}/10)`
    : `${nodeName} - ${chartTitle}`;

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
        <div className="dashboard-no-data">{t('info.link_quality_no_data')}</div>
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
          <defs>
            <linearGradient id={`qualityGradient-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a6e3a1" stopOpacity={0.3} />
              <stop offset="50%" stopColor="#f9e2af" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#f38ba8" stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={globalTimeRange || ['dataMin', 'dataMax']}
            tick={{ fontSize: 12 }}
            tickFormatter={timestamp => formatChartAxisTimestamp(timestamp, globalTimeRange)}
          />
          <YAxis tick={{ fontSize: 12 }} domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tickFormatter={value => value.toString()} />
          {/* Reference lines for quality zones */}
          <ReferenceLine y={3} stroke="#f38ba8" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={7} stroke="#a6e3a1" strokeDasharray="3 3" strokeOpacity={0.5} />
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
            formatter={(value, _name: string) => {
              if (value === null || value === undefined) return ['-', t('info.link_quality_label')];
              const numValue = typeof value === 'number' ? value : parseFloat(String(value));
              if (isNaN(numValue)) return ['-', t('info.link_quality_label')];
              return [`${numValue}/10 (${getQualityLabel(numValue, t)})`, t('info.link_quality_label')];
            }}
          />
          <Area type="monotone" dataKey="quality" stroke="none" fill={`url(#qualityGradient-${id})`} />
          <Line type="monotone" dataKey="quality" stroke="#89b4fa" strokeWidth={2} dot={{ r: 3, fill: '#89b4fa', strokeWidth: 0 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default LinkQualityChart;

// Helper to check if a telemetry type is link quality
export function isLinkQualityType(telemetryType: string): boolean {
  return telemetryType === LINK_QUALITY_TYPE;
}
