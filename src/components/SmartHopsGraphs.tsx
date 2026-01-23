import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import './TelemetryGraphs.css';
import { useSmartHops, type SmartHopsData } from '../hooks/useSmartHops';
import { formatChartAxisTimestamp } from '../utils/datetime';
import { useFavorites, useToggleFavorite } from '../hooks/useFavorites';
import { useToast } from './ToastContainer';

// Telemetry type constant for favorites
export const SMART_HOPS_TYPE = 'smartHops';

interface SmartHopsGraphsProps {
  nodeId: string;
  telemetryHours?: number;
  baseUrl?: string;
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

const SmartHopsGraphs: React.FC<SmartHopsGraphsProps> = React.memo(
  ({ nodeId, telemetryHours = 24, baseUrl = '' }) => {
    const { t } = useTranslation();
    const { showToast } = useToast();

    // Fetch smart hops data
    const { data: hopsData, isLoading, error } = useSmartHops({
      nodeId,
      hours: telemetryHours,
      baseUrl,
    });

    // Favorites management
    const { data: favorites = new Set<string>() } = useFavorites({ nodeId, baseUrl });

    const toggleFavoriteMutation = useToggleFavorite({
      baseUrl,
      onError: message => showToast(message || t('telemetry.favorite_save_failed'), 'error'),
    });

    // Create stable callback for toggling favorites
    const createToggleFavorite = useCallback(
      (telemetryType: string) => () => {
        toggleFavoriteMutation.mutate({
          nodeId,
          telemetryType,
          currentFavorites: favorites,
        });
      },
      [nodeId, favorites, toggleFavoriteMutation]
    );

    // Get computed CSS color values for chart styling
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
      const observer = new MutationObserver(updateColors);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
      });

      return () => observer.disconnect();
    }, []);

    // Process chart data
    const chartData = useMemo(() => processHopsData(hopsData), [hopsData]);

    // Calculate time range for chart
    const timeRange = useMemo((): [number, number] | null => {
      if (chartData.length === 0) return null;

      const timestamps = chartData.map(d => d.timestamp as number).filter(t => t > 0);
      if (timestamps.length === 0) return null;

      return [Math.min(...timestamps), Math.max(...timestamps)];
    }, [chartData]);

    const hasData = chartData.length > 0;
    const isFavorited = favorites.has(SMART_HOPS_TYPE);

    if (isLoading) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.smart_hops_graph')}</h3>
          <p className="telemetry-loading">{t('common.loading_indicator')}</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.smart_hops_graph')}</h3>
          <p className="telemetry-empty">{t('info.smart_hops_error')}</p>
        </div>
      );
    }

    if (!hasData) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.smart_hops_graph')}</h3>
          <p className="telemetry-empty">{t('info.smart_hops_no_data')}</p>
        </div>
      );
    }

    return (
      <div className="telemetry-graphs">
        <h3 className="telemetry-title">{t('info.smart_hops_graph')}</h3>
        <div className="graphs-grid">
          <div className="graph-container">
            <div className="graph-header">
              <h4 className="graph-title">{t('info.smart_hops_title')}</h4>
              <div className="graph-actions">
                <button
                  className={`favorite-btn ${isFavorited ? 'favorited' : ''}`}
                  onClick={createToggleFavorite(SMART_HOPS_TYPE)}
                  aria-label={isFavorited ? t('telemetry.remove_favorite') : t('telemetry.add_favorite')}
                >
                  {isFavorited ? '\u2605' : '\u2606'}
                </button>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ccc" />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  domain={timeRange || ['dataMin', 'dataMax']}
                  tick={{ fontSize: 12 }}
                  tickFormatter={timestamp => formatChartAxisTimestamp(timestamp, timeRange)}
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
        </div>
      </div>
    );
  }
);

SmartHopsGraphs.displayName = 'SmartHopsGraphs';

export default SmartHopsGraphs;
