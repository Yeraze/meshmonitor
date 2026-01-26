import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
import './TelemetryGraphs.css';
import { useLinkQuality, type LinkQualityData } from '../hooks/useLinkQuality';
import { formatChartAxisTimestamp } from '../utils/datetime';
import { useFavorites, useToggleFavorite } from '../hooks/useFavorites';
import { useToast } from './ToastContainer';

// Telemetry type constant for favorites
export const LINK_QUALITY_TYPE = 'linkQuality';

interface LinkQualityGraphProps {
  nodeId: string;
  telemetryHours?: number;
  baseUrl?: string;
}

/**
 * Get color based on link quality value
 * 0-3: Red (poor)
 * 4-6: Yellow (moderate)
 * 7-10: Green (good)
 */
function getQualityColor(quality: number): string {
  if (quality <= 3) return '#f38ba8'; // Red
  if (quality <= 6) return '#f9e2af'; // Yellow
  return '#a6e3a1'; // Green
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

const LinkQualityGraph: React.FC<LinkQualityGraphProps> = React.memo(
  ({ nodeId, telemetryHours = 24, baseUrl = '' }) => {
    const { t } = useTranslation();
    const { showToast } = useToast();

    // Fetch link quality data
    const { data: qualityData, isLoading, error } = useLinkQuality({
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
    const chartData = useMemo(() => processLinkQualityData(qualityData), [qualityData]);

    // Calculate time range for chart
    const timeRange = useMemo((): [number, number] | null => {
      if (chartData.length === 0) return null;

      const timestamps = chartData.map(d => d.timestamp as number).filter(t => t > 0);
      if (timestamps.length === 0) return null;

      return [Math.min(...timestamps), Math.max(...timestamps)];
    }, [chartData]);

    // Get current (latest) quality value
    const currentQuality = useMemo(() => {
      if (!qualityData || qualityData.length === 0) return null;
      const sorted = [...qualityData].sort((a, b) => b.timestamp - a.timestamp);
      return sorted[0].quality;
    }, [qualityData]);

    const hasData = chartData.length > 0;
    const isFavorited = favorites.has(LINK_QUALITY_TYPE);

    if (isLoading) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.link_quality_graph')}</h3>
          <p className="telemetry-loading">{t('common.loading_indicator')}</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.link_quality_graph')}</h3>
          <p className="telemetry-empty">{t('info.link_quality_error')}</p>
        </div>
      );
    }

    if (!hasData) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.link_quality_graph')}</h3>
          <p className="telemetry-empty">{t('info.link_quality_no_data')}</p>
        </div>
      );
    }

    return (
      <div className="telemetry-graphs">
        <h3 className="telemetry-title">{t('info.link_quality_graph')}</h3>
        <div className="graphs-grid">
          <div className="graph-container">
            <div className="graph-header">
              <h4 className="graph-title">
                {t('info.link_quality_title')}
                {currentQuality !== null && (
                  <span style={{
                    marginLeft: '8px',
                    color: getQualityColor(currentQuality),
                    fontSize: '0.9em'
                  }}>
                    ({currentQuality}/10 - {getQualityLabel(currentQuality, t)})
                  </span>
                )}
              </h4>
              <div className="graph-actions">
                <button
                  className={`favorite-btn ${isFavorited ? 'favorited' : ''}`}
                  onClick={createToggleFavorite(LINK_QUALITY_TYPE)}
                  aria-label={isFavorited ? t('telemetry.remove_favorite') : t('telemetry.add_favorite')}
                >
                  {isFavorited ? '\u2605' : '\u2606'}
                </button>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <defs>
                  <linearGradient id="qualityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a6e3a1" stopOpacity={0.3} />
                    <stop offset="50%" stopColor="#f9e2af" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#f38ba8" stopOpacity={0.1} />
                  </linearGradient>
                </defs>
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
                  domain={[0, 10]}
                  ticks={[0, 2, 4, 6, 8, 10]}
                  tickFormatter={value => value.toString()}
                />
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
                    return [
                      `${numValue}/10 (${getQualityLabel(numValue, t)})`,
                      t('info.link_quality_label')
                    ];
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="quality"
                  stroke="none"
                  fill="url(#qualityGradient)"
                />
                <Line
                  type="monotone"
                  dataKey="quality"
                  stroke="#89b4fa"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#89b4fa', strokeWidth: 0 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    );
  }
);

LinkQualityGraph.displayName = 'LinkQualityGraph';

export default LinkQualityGraph;
