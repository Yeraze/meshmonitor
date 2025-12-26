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
import { usePacketRates, type PacketRatesResponse } from '../hooks/usePacketRates';
import { formatChartAxisTimestamp } from '../utils/datetime';
import { useFavorites, useToggleFavorite } from '../hooks/useFavorites';
import { useToast } from './ToastContainer';

// Telemetry type constants for favorites
export const PACKET_RATE_RX_TYPE = 'packetRateRx';
export const PACKET_RATE_TX_TYPE = 'packetRateTx';

interface PacketRateGraphsProps {
  nodeId: string;
  telemetryHours?: number;
  baseUrl?: string;
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
 * Each data point will have a timestamp and rate values for each metric
 */
function mergeRateData(
  data: PacketRatesResponse | undefined,
  metrics: Array<{ key: keyof PacketRatesResponse; label: string; color: string }>
): Array<Record<string, number | null>> {
  if (!data) return [];

  // Collect all unique timestamps
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

  // Create lookup maps for each metric
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

  // Build merged data array
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
        // Insert a gap point
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

const PacketRateGraphs: React.FC<PacketRateGraphsProps> = React.memo(
  ({ nodeId, telemetryHours = 24, baseUrl = '' }) => {
    const { t } = useTranslation();
    const { showToast } = useToast();

    // Fetch packet rate data
    const { data: rateData, isLoading, error } = usePacketRates({
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

    // Prepare chart data
    const rxChartData = useMemo(() => mergeRateData(rateData, RX_METRICS), [rateData]);
    const txChartData = useMemo(() => mergeRateData(rateData, TX_METRICS), [rateData]);

    // Calculate global time range for both charts
    const globalTimeRange = useMemo((): [number, number] | null => {
      const allData = [...rxChartData, ...txChartData];
      if (allData.length === 0) return null;

      const timestamps = allData.map(d => d.timestamp as number).filter(t => t > 0);
      if (timestamps.length === 0) return null;

      return [Math.min(...timestamps), Math.max(...timestamps)];
    }, [rxChartData, txChartData]);

    // Check if we have any data
    const hasRxData = rxChartData.length > 0;
    const hasTxData = txChartData.length > 0;
    const hasAnyData = hasRxData || hasTxData;

    if (isLoading) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.packet_rate_graphs')}</h3>
          <p className="telemetry-loading">{t('common.loading_indicator')}</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.packet_rate_graphs')}</h3>
          <p className="telemetry-empty">{t('info.rate_error')}</p>
        </div>
      );
    }

    if (!hasAnyData) {
      return (
        <div className="telemetry-graphs">
          <h3 className="telemetry-title">{t('info.packet_rate_graphs')}</h3>
          <p className="telemetry-empty">{t('info.no_rate_data')}</p>
        </div>
      );
    }

    const renderChart = (
      data: Array<Record<string, number | null>>,
      metrics: Array<{ key: keyof PacketRatesResponse; label: string; color: string }>,
      title: string,
      telemetryType: string
    ) => {
      if (data.length === 0) return null;

      const isFavorited = favorites.has(telemetryType);

      return (
        <div className="graph-container">
          <div className="graph-header">
            <h4 className="graph-title">{title}</h4>
            <div className="graph-actions">
              <button
                className={`favorite-btn ${isFavorited ? 'favorited' : ''}`}
                onClick={createToggleFavorite(telemetryType)}
                aria-label={isFavorited ? t('telemetry.remove_favorite') : t('telemetry.add_favorite')}
              >
                {isFavorited ? '★' : '☆'}
              </button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
                tickFormatter={value => value.toFixed(1)}
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
                  if (value === null || value === undefined) return ['-', name];
                  const numValue = typeof value === 'number' ? value : parseFloat(String(value));
                  if (isNaN(numValue)) return ['-', name];
                  return [`${numValue.toFixed(2)} pkts/min`, name];
                }}
              />
              <Legend
                verticalAlign="bottom"
                height={36}
                formatter={(value: string) => {
                  const metric = metrics.find(m => m.key === value);
                  return metric?.label || value;
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

    return (
      <div className="telemetry-graphs">
        <h3 className="telemetry-title">{t('info.packet_rate_graphs')}</h3>
        <div className="graphs-grid">
          {hasRxData && renderChart(rxChartData, RX_METRICS, t('info.rx_rates'), PACKET_RATE_RX_TYPE)}
          {hasTxData && renderChart(txChartData, TX_METRICS, t('info.tx_rates'), PACKET_RATE_TX_TYPE)}
        </div>
      </div>
    );
  }
);

PacketRateGraphs.displayName = 'PacketRateGraphs';

export default PacketRateGraphs;
