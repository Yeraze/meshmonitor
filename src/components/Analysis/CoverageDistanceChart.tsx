/**
 * CoverageDistanceChart — distance-vs-SNR scatter for the Coverage Report
 * (#5277 Phase 4a WP3, spec §2a.6). recharts `ScatterChart`; one series per
 * of the top `COVERAGE_CHART_MAX_SERIES` (7) receivers by point count, in
 * fixed `--chart-1..7` order, with every other receiver merged into a single
 * neutral "Other" series (`--color-text-muted`) — never a generated hue past
 * slot 7 (dataviz skill: "a 9th series is never a generated hue").
 *
 * `points` is not pre-capped by the caller (`CoverageSummary.distancePoints`,
 * §2a.3) — this component downsamples to `COVERAGE_CHART_MAX_POINTS` (3000)
 * by a deterministic stride (no random sampling, so the same input always
 * renders the same picture) and shows a "Showing N of M points" note when it
 * does. The stride is computed over the FULL input so the note's totals are
 * accurate; the top-7 ranking also uses the full input so downsampling never
 * reorders which receivers are "large enough" to get their own series.
 *
 * Colors: SVG presentation attributes set via React props go through
 * `setAttribute`, which (like Leaflet, see `sourceColors.ts`) does not
 * reliably evaluate `var(--chart-N)`, so colors are resolved to literal hex
 * via `resolveCssColor` before being handed to recharts, refreshed on theme
 * change the same way `LinkQualityChart` does.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { resolveCssColor } from '../../utils/sourceColors';
import { kmToMiles } from '../../utils/distance';
import { formatCoverageNodeId, COVERAGE_CHART_MAX_POINTS, COVERAGE_CHART_MAX_SERIES } from '../../utils/coverage';
import type { CoverageDistancePoint } from '../../types/coverageAnalysis';
import type { DistanceUnit } from '../../contexts/SettingsContext';
import styles from './CoverageSummaryPanel.module.css';

export interface CoverageDistanceChartProps {
  points: CoverageDistancePoint[];
  receiverNames: Map<string, string>;
  distanceUnit: DistanceUnit;
}

const SERIES_COLOR_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7'];
const OTHER_COLOR_VAR = '--color-text-muted';
const OTHER_SERIES_KEY = '__other__';

interface ChartPoint {
  distance: number;
  snr: number;
  receiverKey: string;
}

interface Series {
  key: string;
  label: string;
  colorVar: string;
  data: ChartPoint[];
}

/** Deterministic stride sample: keeps index 0, then every `stride`-th item.
 *  No randomness, so the same input always downsamples the same way. */
function strideSample<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) return items;
  const stride = Math.ceil(items.length / maxCount);
  const sampled: T[] = [];
  for (let i = 0; i < items.length; i += stride) sampled.push(items[i]);
  return sampled;
}

function receiverLabel(key: string, receiverNames: Map<string, string>): string {
  const name = receiverNames.get(key);
  if (name) return name;
  const rawId = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key;
  return formatCoverageNodeId(rawId);
}

export const CoverageDistanceChart: React.FC<CoverageDistanceChartProps> = ({
  points,
  receiverNames,
  distanceUnit,
}) => {
  const { t } = useTranslation();

  // Resolve --chart-N / --color-text-muted to literal hex; refresh on theme
  // toggle the same way LinkQualityChart does (MutationObserver on <html>).
  const [colors, setColors] = useState<Record<string, string>>({});
  useEffect(() => {
    const resolve = () => {
      const next: Record<string, string> = {};
      for (const v of [...SERIES_COLOR_VARS, OTHER_COLOR_VAR]) next[v] = resolveCssColor(`var(${v})`);
      setColors(next);
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  const totalCount = points.length;

  const series = useMemo<Series[]>(() => {
    if (totalCount === 0) return [];

    const countByReceiver = new Map<string, number>();
    for (const p of points) countByReceiver.set(p.receiverKey, (countByReceiver.get(p.receiverKey) ?? 0) + 1);

    const topKeys = [...countByReceiver.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, COVERAGE_CHART_MAX_SERIES)
      .map(([key]) => key);
    const topKeySet = new Set(topKeys);

    const sampled = strideSample(points, COVERAGE_CHART_MAX_POINTS);

    const buckets = new Map<string, ChartPoint[]>();
    for (const p of sampled) {
      const seriesKey = topKeySet.has(p.receiverKey) ? p.receiverKey : OTHER_SERIES_KEY;
      const km = p.distanceM / 1000;
      const distance = distanceUnit === 'mi' ? kmToMiles(km) : km;
      const list = buckets.get(seriesKey) ?? [];
      list.push({ distance, snr: p.snr, receiverKey: p.receiverKey });
      buckets.set(seriesKey, list);
    }

    const result: Series[] = topKeys.map((key, idx) => ({
      key,
      label: receiverLabel(key, receiverNames),
      colorVar: SERIES_COLOR_VARS[idx],
      data: buckets.get(key) ?? [],
    }));
    const other = buckets.get(OTHER_SERIES_KEY);
    if (other && other.length > 0) {
      result.push({
        key: OTHER_SERIES_KEY,
        label: t('analysis.coverage.chart_other', 'Other'),
        colorVar: OTHER_COLOR_VAR,
        data: other,
      });
    }
    return result;
  }, [points, totalCount, receiverNames, distanceUnit, t]);

  const shownCount = useMemo(() => series.reduce((sum, s) => sum + s.data.length, 0), [series]);

  if (totalCount === 0) {
    return (
      <div className={styles.chartWrap} data-testid="coverage-distance-chart">
        <h3 className={styles.title}>{t('analysis.coverage.chart_title', 'Distance vs SNR (direct receptions)')}</h3>
        <div className={styles.chartEmpty}>
          {t('analysis.coverage.chart_empty', 'No direct (0-hop) receptions with a known receiver position.')}
        </div>
      </div>
    );
  }

  const xLabel =
    distanceUnit === 'mi'
      ? t('analysis.coverage.chart_x_mi', 'Distance (mi)')
      : t('analysis.coverage.chart_x_km', 'Distance (km)');
  const yLabel = t('analysis.coverage.chart_y_snr', 'SNR (dB)');

  return (
    <div className={styles.chartWrap} data-testid="coverage-distance-chart">
      <h3 className={styles.title}>{t('analysis.coverage.chart_title', 'Distance vs SNR (direct receptions)')}</h3>

      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-surface-hover)" />
          <XAxis
            type="number"
            dataKey="distance"
            name={xLabel}
            tick={{ fontSize: 11 }}
            label={{ value: xLabel, position: 'insideBottom', offset: -10, fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="snr"
            name={yLabel}
            tick={{ fontSize: 11 }}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }}
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            contentStyle={{
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-surface-hover)',
              borderRadius: '4px',
              fontSize: '0.8em',
            }}
            itemStyle={{ color: 'var(--color-text)' }}
            labelFormatter={() => ''}
            formatter={(value, name, item) => {
              const numValue = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
              if (name === xLabel) return [`${numValue.toFixed(2)}`, xLabel];
              if (name === yLabel) return [`${numValue.toFixed(1)} dB`, yLabel];
              const key = (item?.payload as ChartPoint | undefined)?.receiverKey;
              return [String(value), key ? receiverLabel(key, receiverNames) : String(name)];
            }}
          />
          {series.map((s) => (
            <Scatter key={s.key} name={s.label} data={s.data} fill={colors[s.colorVar] ?? undefined} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>

      <div className={styles.chartLegend} data-testid="coverage-distance-chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <span
              className={styles.chartLegendSwatch}
              style={{ backgroundColor: colors[s.colorVar] ?? undefined }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {shownCount < totalCount && (
        <p className={styles.note}>
          {t('analysis.coverage.chart_downsampled', 'Showing {{shown}} of {{total}} points.', {
            shown: shownCount,
            total: totalCount,
          })}
        </p>
      )}
    </div>
  );
};

export default CoverageDistanceChart;
