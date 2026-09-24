/**
 * TransportSeriesGraphs - Info tab section for the two MeshMonitor-computed
 * per-transport series (#5101 Phase 3): nodes heard and packets received,
 * each split by transport class (RF/UDP/MQTT) and computed by MeshMonitor
 * itself in 5-minute bins (see `src/utils/transportSeries.ts` and
 * `src/server/services/transportTrafficService.ts`).
 *
 * Structure mirrors PacketRateGraphs.tsx (telemetry-graphs wrapper,
 * graphs-grid, favorite stars via the shared favorites hooks), but the chart
 * body itself lives in the shared TransportSeriesPlot so it is not
 * duplicated between the Info tab and the Dashboard card (TransportSeriesChart).
 *
 * See docs/internal/dev-notes/TRANSPORT_BREAKDOWN_P3_SPEC.md §3.5.
 */
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import './TelemetryGraphs.css';
import { useTelemetry } from '../hooks/useTelemetry';
import { useFavorites, useToggleFavorite } from '../hooks/useFavorites';
import { useToast } from './ToastContainer';
import { useSource } from '../contexts/SourceContext';
import { UiIcon } from './icons';
import TransportSeriesPlot from './TransportSeriesPlot';
import {
  toTransportChartRows,
  TRANSPORT_NODES_HEARD_TYPE,
  TRANSPORT_PACKETS_RX_TYPE,
  type TransportChartRow,
} from '../utils/transportSeries';
import styles from './TransportSeries.module.css';

interface TransportSeriesGraphsProps {
  nodeId: string;
  telemetryHours?: number;
  baseUrl?: string;
}

/** True when at least one row has a non-zero value for some class (D5 emptiness). */
function hasVisibleData(rows: TransportChartRow[]): boolean {
  return rows.some(row => (row.rf ?? 0) !== 0 || (row.udp ?? 0) !== 0 || (row.mqtt ?? 0) !== 0);
}

function computeTimeRange(a: TransportChartRow[], b: TransportChartRow[]): [number, number] | null {
  const timestamps = [...a, ...b].map(row => row.timestamp).filter(ts => ts > 0);
  if (timestamps.length === 0) return null;
  return [Math.min(...timestamps), Math.max(...timestamps)];
}

const TransportSeriesGraphs: React.FC<TransportSeriesGraphsProps> = ({
  nodeId,
  telemetryHours = 24,
  baseUrl = '',
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { sourceId } = useSource();

  const { data, isLoading, error } = useTelemetry({
    nodeId,
    hours: telemetryHours,
    baseUrl,
    sourceId,
  });

  const nodesHeard = useMemo(() => toTransportChartRows(data ?? [], 'nodesHeard'), [data]);
  const packetsRx = useMemo(() => toTransportChartRows(data ?? [], 'packetsRx'), [data]);

  const timeRange = useMemo(
    () => computeTimeRange(nodesHeard.rows, packetsRx.rows),
    [nodesHeard.rows, packetsRx.rows]
  );

  const { data: favorites = new Set<string>() } = useFavorites({ nodeId, baseUrl });

  const toggleFavoriteMutation = useToggleFavorite({
    baseUrl,
    onError: message => showToast(message || t('telemetry.favorite_save_failed'), 'error'),
  });

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

  if (isLoading) {
    return (
      <div className="telemetry-graphs" data-testid="transport-series-section">
        <h3 className="telemetry-title">{t('info.transport_series_title')}</h3>
        <p className="telemetry-loading">{t('common.loading_indicator')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="telemetry-graphs" data-testid="transport-series-section">
        <h3 className="telemetry-title">{t('info.transport_series_title')}</h3>
        <p className={styles.empty}>{t('info.transport_series_error')}</p>
      </div>
    );
  }

  const hasNodesData = hasVisibleData(nodesHeard.rows);
  const hasPacketsData = hasVisibleData(packetsRx.rows);

  if (!hasNodesData && !hasPacketsData) {
    return (
      <div className="telemetry-graphs" data-testid="transport-series-section">
        <h3 className="telemetry-title">{t('info.transport_series_title')}</h3>
        <p className={styles.empty} data-testid="transport-series-empty">
          {t('info.transport_series_empty')}
        </p>
      </div>
    );
  }

  const renderStar = (telemetryType: string) => {
    const isFavorited = favorites.has(telemetryType);
    return (
      <button
        className={`favorite-btn ${isFavorited ? 'favorited' : ''}`}
        onClick={createToggleFavorite(telemetryType)}
        aria-label={isFavorited ? t('telemetry.remove_favorite') : t('telemetry.add_favorite')}
      >
        <UiIcon name={isFavorited ? 'favorite' : 'favoriteOff'} size={15} />
      </button>
    );
  };

  return (
    <div className="telemetry-graphs" data-testid="transport-series-section">
      <h3 className="telemetry-title">{t('info.transport_series_title')}</h3>
      <p className={styles.caption}>{t('info.transport_series_note')}</p>
      <div className="graphs-grid">
        {hasNodesData && (
          <div className="graph-container" data-testid="transport-series-nodes">
            <div className="graph-header">
              <h4 className="graph-title">{t('info.transport_nodes_heard')}</h4>
              <div className="graph-actions">{renderStar(TRANSPORT_NODES_HEARD_TYPE)}</div>
            </div>
            <p className={styles.caption}>{t('info.transport_nodes_note')}</p>
            <TransportSeriesPlot
              rows={nodesHeard.rows}
              kind="nodesHeard"
              averaged={nodesHeard.averaged}
              timeRange={timeRange}
            />
          </div>
        )}
        {hasPacketsData && (
          <div className="graph-container" data-testid="transport-series-packets">
            <div className="graph-header">
              <h4 className="graph-title">{t('info.transport_packets_rx')}</h4>
              <div className="graph-actions">{renderStar(TRANSPORT_PACKETS_RX_TYPE)}</div>
            </div>
            <p className={styles.caption}>{t('info.transport_packets_note')}</p>
            <TransportSeriesPlot
              rows={packetsRx.rows}
              kind="packetsRx"
              averaged={packetsRx.averaged}
              timeRange={timeRange}
            />
          </div>
        )}
      </div>
    </div>
  );
};

TransportSeriesGraphs.displayName = 'TransportSeriesGraphs';

export default TransportSeriesGraphs;
