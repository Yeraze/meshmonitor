/**
 * One telemetry chart with one line per source (#5896).
 *
 * The cross-source Telemetry Dashboard draws a (node, type) series as
 * overlapping lines, one per source that holds data for it, coloured by
 * source. Lines are never merged or averaged together. For an
 * observer-relative type (SNR, RSSI, channel load, packet counters) each line
 * is labelled "heard by <source>", since two sources' lines there are two
 * observers' views, not two readings of one quantity.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { TemperatureUnit } from '../../utils/temperature';
import { formatChartAxisTimestamp } from '../../utils/datetime';
import type { TimeFormat } from '../../contexts/SettingsContext';
import { resolveSeriesDisplay, downloadTelemetryCsv } from '../../utils/telemetrySeriesDisplay';
import { getTelemetryLabel } from '../TelemetryChart';
import { UiIcon } from '../icons';
import styles from './CombinedTelemetryChart.module.css';

export interface CombinedSeriesLine {
  sourceId: string;
  sourceName: string;
  unit: string | null;
  favorited: boolean;
  canEditFavorite: boolean;
  points: Array<{ timestamp: number; value: number }>;
}

export interface CombinedSeries {
  subjectKey: string;
  nodeName: string;
  type: string;
  favoriteType: string;
  category: string;
  observerRelative: boolean;
  lines: CombinedSeriesLine[];
}

interface CombinedTelemetryChartProps {
  series: CombinedSeries;
  /** Line colour per source id. */
  colorFor: (sourceId: string) => string;
  temperatureUnit: TemperatureUnit;
  timeFormat?: TimeFormat;
  hours: number;
  /** Shared x-axis window for every chart on the page. */
  timeRange: [number, number] | null;
  /** Remove this series from the favorites the caller may edit. Absent: no toggle. */
  onRemoveFavorite?: () => void;
  favoriteBusy?: boolean;
}

/** Row key of line `i` in the merged chart data. */
const lineKey = (i: number) => `l${i}`;

const CombinedTelemetryChart: React.FC<CombinedTelemetryChartProps> = ({
  series,
  colorFor,
  temperatureUnit,
  timeFormat = '24',
  hours,
  timeRange,
  onRemoveFavorite,
  favoriteBusy = false,
}) => {
  const { t } = useTranslation();

  const display = useMemo(
    () => resolveSeriesDisplay(
      series.type,
      series.lines.flatMap((l) => l.points.map((p) => p.value)),
      series.lines.find((l) => l.unit)?.unit ?? '',
      temperatureUnit,
    ),
    [series, temperatureUnit],
  );

  const lineLabel = (line: CombinedSeriesLine) =>
    series.observerRelative
      ? t('unified.telemetry.heard_by', { name: line.sourceName })
      : line.sourceName;

  // One row per timestamp; each line's value under its own key. A line with
  // no point at a timestamp leaves a gap that `connectNulls` bridges.
  const data = useMemo(() => {
    const rows = new Map<number, Record<string, number>>();
    series.lines.forEach((line, i) => {
      for (const p of line.points) {
        let row = rows.get(p.timestamp);
        if (!row) rows.set(p.timestamp, (row = { timestamp: p.timestamp }));
        row[lineKey(i)] = display.toDisplay(p.value);
      }
    });
    return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [series, display]);

  const title = getTelemetryLabel(series.type);
  const unit = display.unit;

  const handleExport = () => {
    downloadTelemetryCsv(
      series.lines.flatMap((line) =>
        line.points.map((p) => ({ timestamp: p.timestamp, value: display.toDisplay(p.value), source: line.sourceName })),
      ),
      { nodeId: series.subjectKey, telemetryType: series.type, unit, hours },
    );
  };

  return (
    <div className={styles.card} data-testid="combined-telemetry-chart">
      <div className={styles.header}>
        <div className={styles.titles}>
          <h4 className={styles.title} title={`${title}${unit ? ` (${unit})` : ''}`}>
            {title} {unit && `(${unit})`}
          </h4>
          <span className={styles.subject} title={series.subjectKey}>{series.nodeName}</span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={handleExport}
            disabled={data.length === 0}
            aria-label={t('telemetry.export_csv')}
            title={t('telemetry.export_csv')}
          >
            <UiIcon name="downloadData" size={15} />
          </button>
          {onRemoveFavorite && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.favorited}`}
              onClick={onRemoveFavorite}
              disabled={favoriteBusy}
              aria-label={t('telemetry.remove_favorite')}
              title={t('telemetry.remove_favorite')}
            >
              <UiIcon name="favorite" size={15} />
            </button>
          )}
        </div>
      </div>

      <ul className={styles.legend} aria-label={t('unified.telemetry.legend_aria')}>
        {series.lines.map((line) => (
          <li key={line.sourceId} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: colorFor(line.sourceId) }} aria-hidden="true" />
            {lineLabel(line)}
          </li>
        ))}
      </ul>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={timeRange ?? ['dataMin', 'dataMax']}
            allowDataOverflow={timeRange !== null}
            tick={{ fontSize: 12 }}
            tickFormatter={(ts) => formatChartAxisTimestamp(ts, timeRange, timeFormat)}
          />
          <YAxis tick={{ fontSize: 12 }} domain={['auto', 'auto']} tickFormatter={display.formatValue} />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '4px',
              color: 'var(--color-text)',
            }}
            labelStyle={{ color: 'var(--color-text)' }}
            formatter={(value) =>
              typeof value === 'number' && display.formatValue ? display.formatValue(value) : value
            }
            labelFormatter={(value) =>
              new Date(value as number).toLocaleString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
              })
            }
          />
          {series.lines.map((line, i) => (
            <Line
              key={line.sourceId}
              type="monotone"
              dataKey={lineKey(i)}
              name={lineLabel(line)}
              stroke={colorFor(line.sourceId)}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls={true}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default CombinedTelemetryChart;
