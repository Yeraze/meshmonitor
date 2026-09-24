/**
 * TransportSeriesPlot - shared recharts body for the two MeshMonitor-computed
 * per-transport series (#5101 Phase 3, D5).
 *
 * Used by both TransportSeriesGraphs (Info tab) and TransportSeriesChart
 * (Dashboard card) so the chart body is written once — PacketRateGraphs and
 * PacketRateChart each carry an identical copy of `mergeRateData`, and this
 * component exists specifically so that duplication is not repeated here
 * (see TRANSPORT_BREAKDOWN_P3_SPEC.md §1).
 *
 * Chart shape (D5, user decision):
 * - "nodes heard" renders as three lines. The classes overlap (a node heard
 *   over two transports in the same bin counts on both), so a stack would
 *   suggest a false total.
 * - "packets RX" renders as a stacked area. Each packet counts once, under
 *   exactly one class, so summing is correct there.
 * - A transport class whose values are all zero or null across the visible
 *   rows is hidden entirely, rather than drawn as a flat line/empty band.
 *
 * Colours match the transport-class legend already established in
 * `src/components/survey/NetworkSurveyPanel.module.css`: RF `var(--chart-1)`,
 * UDP `var(--chart-6)`, MQTT `var(--chart-4)`.
 */
import { useMemo } from 'react';
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
  Legend,
} from 'recharts';
import { formatChartAxisTimestamp } from '../utils/datetime';
import type { TransportChartRow, TransportSeriesKind } from '../utils/transportSeries';
import type { NodeTransportClass } from '../utils/nodeTransport';
import styles from './TransportSeries.module.css';

export interface TransportSeriesPlotProps {
  rows: TransportChartRow[];
  kind: TransportSeriesKind;
  averaged: boolean;
  height?: number;
  timeRange: [number, number] | null;
}

const TRANSPORT_CLASSES: readonly NodeTransportClass[] = ['rf', 'udp', 'mqtt'];

// Matches src/components/survey/NetworkSurveyPanel.module.css .surveyHopSeg{Rf,Udp,Mqtt}.
const TRANSPORT_COLORS: Record<NodeTransportClass, string> = {
  rf: 'var(--chart-1)',
  udp: 'var(--chart-6)',
  mqtt: 'var(--chart-4)',
};

function isNonZero(value: number | null): boolean {
  return value !== null && value !== 0;
}

export default function TransportSeriesPlot({
  rows,
  kind,
  averaged,
  height = 200,
  timeRange,
}: TransportSeriesPlotProps) {
  const { t } = useTranslation();

  // D5: hide a class whose values are all zero or null in the visible range.
  const visibleClasses = useMemo(
    () => TRANSPORT_CLASSES.filter(cls => rows.some(row => isNonZero(row[cls]))),
    [rows]
  );

  if (visibleClasses.length === 0) {
    return null;
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
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
            allowDecimals={averaged}
            tickFormatter={value => (averaged ? Number(value).toFixed(1) : String(value))}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-bg)',
              border: '1px solid var(--color-surface)',
              borderRadius: '4px',
              color: 'var(--color-text)',
            }}
            labelStyle={{ color: 'var(--color-text)' }}
            labelFormatter={value => {
              const date = new Date(value as number);
              return date.toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
            }}
            formatter={(value, name) => {
              const label = t(`transport.${String(name ?? '')}`);
              if (value === null || value === undefined) return ['-', label];
              const numValue = typeof value === 'number' ? value : parseFloat(String(value));
              if (isNaN(numValue)) return ['-', label];
              return [averaged ? numValue.toFixed(2) : String(numValue), label];
            }}
          />
          <Legend verticalAlign="bottom" height={36} formatter={value => t(`transport.${String(value ?? '')}`)} />
          {kind === 'nodesHeard'
            ? visibleClasses.map(cls => (
                <Line
                  key={cls}
                  type="monotone"
                  dataKey={cls}
                  name={cls}
                  stroke={TRANSPORT_COLORS[cls]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
              ))
            : visibleClasses.map(cls => (
                <Area
                  key={cls}
                  type="monotone"
                  dataKey={cls}
                  name={cls}
                  stackId="transport"
                  stroke={TRANSPORT_COLORS[cls]}
                  fill={TRANSPORT_COLORS[cls]}
                  connectNulls={false}
                />
              ))}
        </ComposedChart>
      </ResponsiveContainer>
      {averaged && (
        <p className={styles.caption} data-testid="transport-series-averaged-note">
          {t('info.transport_series_averaged')}
        </p>
      )}
    </>
  );
}
