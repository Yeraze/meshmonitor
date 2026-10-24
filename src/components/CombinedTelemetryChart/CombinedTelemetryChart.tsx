/**
 * One telemetry chart with one line per source (#5896).
 *
 * The cross-source Telemetry Dashboard draws a (node, type) series per
 * source that holds data for it, coloured by source.
 *  - An observer-relative type (SNR, RSSI, channel load, packet counters)
 *    keeps one line per source, labelled "heard by <source>": two sources'
 *    lines there are two observers' views, not two readings of one quantity.
 *  - An objective type (battery, temperature, voltage) with data on more than
 *    one source draws ONE merged line (#5931), so a reading one source missed
 *    fills the other's gap. "Split by source" brings back one line per source.
 *    The CSV follows the view on screen.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { TemperatureUnit } from '../../utils/temperature';
import { formatChartAxisTimestamp } from '../../utils/datetime';
import type { TimeFormat } from '../../contexts/SettingsContext';
import { resolveSeriesDisplay, downloadTelemetryCsv } from '../../utils/telemetrySeriesDisplay';
import { getTelemetryLabel } from '../TelemetryChart';
import { UiIcon } from '../icons';
import { mergeSourceLines } from './mergeSourceLines';
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
/** Row key of the merged line, and of its contributing sources. */
const MERGED_KEY = 'merged';
const MERGED_SOURCES_KEY = 'mergedSources';

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

  // Objective types with more than one source merge unless split (#5931).
  const canMerge = !series.observerRelative && series.lines.length > 1;
  const [split, setSplit] = useState(false);
  const merged = canMerge && !split;

  const mergedPoints = useMemo(
    () => (merged ? mergeSourceLines(series.lines) : []),
    [merged, series],
  );

  const lineLabel = (line: CombinedSeriesLine) =>
    series.observerRelative
      ? t('unified.telemetry.heard_by', { name: line.sourceName })
      : line.sourceName;

  // One row per timestamp; each line's value under its own key. A line with
  // no point at a timestamp leaves a gap that `connectNulls` bridges.
  const data = useMemo((): Array<Record<string, number | string>> => {
    if (merged) {
      return mergedPoints.map((p) => ({
        timestamp: p.timestamp,
        [MERGED_KEY]: display.toDisplay(p.value),
        [MERGED_SOURCES_KEY]: p.sources.join(', '),
      }));
    }
    const rows = new Map<number, Record<string, number>>();
    series.lines.forEach((line, i) => {
      for (const p of line.points) {
        let row = rows.get(p.timestamp);
        if (!row) rows.set(p.timestamp, (row = { timestamp: p.timestamp }));
        row[lineKey(i)] = display.toDisplay(p.value);
      }
    });
    return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [series, display, merged, mergedPoints]);

  const title = getTelemetryLabel(series.type);
  const unit = display.unit;

  const handleExport = () => {
    const rows = merged
      ? mergedPoints.map((p) => ({ timestamp: p.timestamp, value: display.toDisplay(p.value), source: p.sources.join('; ') }))
      : series.lines.flatMap((line) =>
        line.points.map((p) => ({ timestamp: p.timestamp, value: display.toDisplay(p.value), source: line.sourceName })),
      );
    downloadTelemetryCsv(rows, { nodeId: series.subjectKey, telemetryType: series.type, unit, hours });
  };

  const mergedLabel = t('unified.telemetry.merged_label', {
    names: series.lines.map((l) => l.sourceName).join(', '),
  });

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
          {canMerge && (
            <button
              type="button"
              className={styles.textBtn}
              onClick={() => setSplit((v) => !v)}
              aria-pressed={split}
              title={t('unified.telemetry.split_hint')}
            >
              {t('unified.telemetry.split_by_source')}
            </button>
          )}
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
        {merged ? (
          <li className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.mergedSwatch}`} aria-hidden="true" />
            {mergedLabel}
          </li>
        ) : series.lines.map((line) => (
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
            labelFormatter={(value, payload) => {
              const when = new Date(value as number).toLocaleString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
              });
              const from = merged ? payload?.[0]?.payload?.[MERGED_SOURCES_KEY] : undefined;
              return from ? `${when} · ${t('unified.telemetry.merged_from', { names: from })}` : when;
            }}
          />
          {merged ? (
            <Line
              key={MERGED_KEY}
              type="monotone"
              dataKey={MERGED_KEY}
              name={mergedLabel}
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls={true}
              isAnimationActive={false}
            />
          ) : series.lines.map((line, i) => (
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
