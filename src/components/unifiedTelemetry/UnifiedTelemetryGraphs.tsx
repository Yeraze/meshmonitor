/**
 * The graphs view of the cross-source Telemetry Dashboard (#5896).
 *
 * Every favorited series across the sources the viewer may read, one chart per
 * (node, type) with one line per source, grouped into the per-source
 * dashboard's categories. Fetched once on load, on a range change and on the
 * refresh button: no polling.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { setTelemetryFavorite } from '../../services/telemetryFavorites';
import type { TemperatureUnit } from '../../utils/temperature';
import type { TimeFormat } from '../../contexts/SettingsContext';
import { resolveSourceColor } from '../../utils/sourceColors';
import { TELEMETRY_RANGE_PRESETS } from '../../utils/telemetryRangePresets';
import {
  TELEMETRY_CATEGORY_LABELS,
  TELEMETRY_CATEGORY_ORDER,
  type TelemetryCategory,
} from '../../utils/telemetryCategory';
import CombinedTelemetryChart, { type CombinedSeries } from '../CombinedTelemetryChart/CombinedTelemetryChart';
import { UiIcon } from '../icons';
import styles from './UnifiedTelemetryGraphs.module.css';
import '../../styles/unified.css';

const RANGE_STORAGE_KEY = 'unifiedTelemetryHours';
const DEFAULT_HOURS = 24;

function loadHours(): number {
  try {
    const saved = parseFloat(localStorage.getItem(RANGE_STORAGE_KEY) ?? '');
    if (TELEMETRY_RANGE_PRESETS.some((p) => p.hours === saved)) return saved;
  } catch {
    // Storage blocked: use the default.
  }
  return DEFAULT_HOURS;
}

interface SeriesResponse {
  success: boolean;
  data: { series: CombinedSeries[] };
}

interface UnifiedTelemetryGraphsProps {
  /** Back button, title and view tabs, rendered at the top of the sticky header. */
  header: ReactNode;
  temperatureUnit: TemperatureUnit;
  timeFormat: TimeFormat;
  /** Bumped by the parent to force a refetch (a favorite changed elsewhere). */
  reloadToken?: number;
}

export default function UnifiedTelemetryGraphs({ header, temperatureUnit, timeFormat, reloadToken = 0 }: UnifiedTelemetryGraphsProps) {
  const { t } = useTranslation();
  const [hours, setHours] = useState<number>(loadHours);
  const [series, setSeries] = useState<CombinedSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  const fetchSeries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiService.get<SeriesResponse>(`/api/unified/telemetry/series?hours=${hours}`);
      setSeries(res?.data?.series ?? []);
      setFetchedAt(Date.now());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? t('unified.telemetry.failed') : t('unified.telemetry.network_error'));
    } finally {
      setLoading(false);
    }
  }, [hours, t]);

  useEffect(() => {
    void fetchSeries();
  }, [fetchSeries, reloadToken]);

  const chooseHours = (h: number) => {
    setHours(h);
    try {
      localStorage.setItem(RANGE_STORAGE_KEY, String(h));
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  };

  // Every source with a line, in first-seen order: a stable colour per source
  // and the filter's options.
  const sources = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of series) for (const l of s.lines) if (!seen.has(l.sourceId)) seen.set(l.sourceId, l.sourceName);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [series]);
  const sourceIds = useMemo(() => sources.map((s) => s.id), [sources]);
  const colorFor = useCallback((sourceId: string) => resolveSourceColor(sourceId, sourceIds), [sourceIds]);

  const visible = useMemo(() => {
    if (!sourceFilter) return series;
    return series
      .map((s) => ({ ...s, lines: s.lines.filter((l) => l.sourceId === sourceFilter) }))
      .filter((s) => s.lines.length > 0);
  }, [series, sourceFilter]);

  const sections = useMemo(() => {
    const by = new Map<TelemetryCategory, CombinedSeries[]>();
    for (const s of visible) {
      const cat = (TELEMETRY_CATEGORY_ORDER as string[]).includes(s.category) ? (s.category as TelemetryCategory) : 'other';
      let list = by.get(cat);
      if (!list) by.set(cat, (list = []));
      list.push(s);
    }
    return TELEMETRY_CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => ({ category: c, items: by.get(c)! }));
  }, [visible]);

  const timeRange = useMemo<[number, number]>(() => [fetchedAt - hours * 3600 * 1000, fetchedAt], [fetchedAt, hours]);

  // Remove a series from every favorites list the viewer may change. A list on
  // a source they cannot change keeps it, so the chart may stay.
  const removeFavorite = useCallback(async (s: CombinedSeries) => {
    const key = `${s.subjectKey}|${s.type}`;
    const editable = s.lines.filter((l) => l.favorited && l.canEditFavorite);
    setBusyKey(key);
    try {
      await Promise.all(editable.map((l) => setTelemetryFavorite(l.sourceId, s.subjectKey, s.favoriteType, false)));
    } catch {
      setError(t('unified.telemetry.favorite_failed'));
    } finally {
      setBusyKey(null);
      void fetchSeries();
    }
  }, [fetchSeries, t]);

  return (
    <>
      <div className="unified-header unified-header--sticky">
        {header}
        <div className="unified-controls">
          <div className="unified-btn-group" role="group" aria-label={t('unified.telemetry.range_aria')}>
            {TELEMETRY_RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={hours === p.hours ? 'active' : ''}
                aria-pressed={hours === p.hours}
                onClick={() => chooseHours(p.hours)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <select
            className="unified-select"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label={t('unified.telemetry.filter_source_aria')}
          >
            <option value="">{t('unified.telemetry.all_sources')}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <button
            type="button"
            className={styles.refresh}
            onClick={() => void fetchSeries()}
            disabled={loading}
            aria-label={t('unified.telemetry.refresh')}
            title={t('unified.telemetry.refresh')}
          >
            <UiIcon name="refresh" size={15} />
          </button>
        </div>
      </div>

      <div className="unified-body unified-body--wide">
        {loading && series.length === 0 && <div className="unified-empty">{t('unified.telemetry.loading')}</div>}
        {error && <div className="unified-error">{error}</div>}

        {!loading && !error && series.length === 0 && (
          <div className="unified-empty">{t('unified.telemetry.no_favorites')}</div>
        )}

        {sections.map(({ category, items }) => (
          <section key={category} className={styles.section} aria-label={t(`telemetry.category.${category}`, TELEMETRY_CATEGORY_LABELS[category])}>
            <h2 className={styles.sectionTitle}>{t(`telemetry.category.${category}`, TELEMETRY_CATEGORY_LABELS[category])}</h2>
            <div className={styles.grid}>
              {items.map((s) => {
                const canRemove = s.lines.some((l) => l.favorited && l.canEditFavorite);
                return (
                  <CombinedTelemetryChart
                    key={`${s.subjectKey}|${s.type}`}
                    series={s}
                    colorFor={colorFor}
                    temperatureUnit={temperatureUnit}
                    timeFormat={timeFormat}
                    hours={hours}
                    timeRange={timeRange}
                    onRemoveFavorite={canRemove ? () => void removeFavorite(s) : undefined}
                    favoriteBusy={busyKey === `${s.subjectKey}|${s.type}`}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
