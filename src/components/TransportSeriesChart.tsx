/**
 * TransportSeriesChart - Dashboard card for a favorited MeshMonitor-computed
 * per-transport series (#5101 Phase 3): "Nodes Heard by Transport" or
 * "Packets RX by Transport", selected by the favorite's pseudo telemetryType
 * (`TRANSPORT_NODES_HEARD_TYPE` / `TRANSPORT_PACKETS_RX_TYPE`).
 *
 * Structure mirrors PacketRateChart.tsx / LinkQualityChart.tsx (dashboard
 * card chrome, drag handle, remove button), but the chart body is the shared
 * TransportSeriesPlot — see TransportSeriesGraphs.tsx for the Info tab
 * equivalent — so it is not duplicated here.
 */
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTelemetry } from '../hooks/useTelemetry';
import { useSource } from '../contexts/SourceContext';
import type { TelemetryNodeInfo } from '../types/device';
import { UiIcon } from './icons';
import TransportSeriesPlot from './TransportSeriesPlot';
import { toTransportChartRows, TRANSPORT_SERIES_PSEUDO_TYPES } from '../utils/transportSeries';

interface FavoriteChart {
  nodeId: string;
  telemetryType: string;
}

interface TransportSeriesChartProps {
  id: string;
  favorite: FavoriteChart;
  node: TelemetryNodeInfo | undefined;
  hours: number;
  baseUrl: string;
  globalTimeRange: [number, number] | null;
  onRemove: (nodeId: string, telemetryType: string) => void;
}

const TransportSeriesChart: React.FC<TransportSeriesChartProps> = ({
  id,
  favorite,
  node,
  hours,
  baseUrl,
  globalTimeRange,
  onRemove,
}) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();

  // Falls back to 'nodesHeard' for an unrecognised type; DashboardGrid only
  // reaches this component when isTransportSeriesType(favorite.telemetryType)
  // is true, so this is defensive, not a real branch.
  const kind = TRANSPORT_SERIES_PSEUDO_TYPES[favorite.telemetryType] ?? 'nodesHeard';

  const { data, isLoading, error } = useTelemetry({
    nodeId: favorite.nodeId,
    hours,
    baseUrl,
    sourceId,
  });

  const { rows, averaged } = useMemo(() => toTransportChartRows(data ?? [], kind), [data, kind]);

  const hasData = useMemo(
    () => rows.some(row => (row.rf ?? 0) !== 0 || (row.udp ?? 0) !== 0 || (row.mqtt ?? 0) !== 0),
    [rows]
  );

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

  const nodeName = node?.user?.longName || node?.user?.shortName || favorite.nodeId;
  const chartTitle = kind === 'nodesHeard' ? t('info.transport_nodes_heard') : t('info.transport_packets_rx');
  const label = `${nodeName} - ${chartTitle}`;

  const header = (
    <div className="dashboard-chart-header">
      <div className="dashboard-drag-handle" {...attributes} {...listeners}>
        <UiIcon name="dragHandle" size={17} />
      </div>
      <h3 className="dashboard-chart-title" title={label}>
        {label}
      </h3>
      <button
        className="dashboard-remove-btn"
        onClick={handleRemoveClick}
        aria-label={t('dashboard.remove_from_dashboard')}
      >
        <UiIcon name="close" size={15} />
      </button>
    </div>
  );

  if (isLoading) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        {header}
        <div className="dashboard-loading-chart">{t('dashboard.loading_chart')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        {header}
        <div className="dashboard-error-chart">{t('dashboard.error_chart')}</div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div ref={setNodeRef} style={style} className="dashboard-chart-container">
        {header}
        <div className="dashboard-no-data">{t('info.transport_series_empty')}</div>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="dashboard-chart-container">
      {header}
      <TransportSeriesPlot rows={rows} kind={kind} averaged={averaged} timeRange={globalTimeRange} />
    </div>
  );
};

export default TransportSeriesChart;
