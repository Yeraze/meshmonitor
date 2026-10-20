/**
 * Unified Telemetry Page: the cross-source Telemetry Dashboard (#5896).
 *
 * Two views:
 *   - Graphs (default): every favorited series across the sources the viewer
 *     may read, one chart per (node, type) with one line per source.
 *   - Latest: the latest reading per node per source (the old fleet overview),
 *     where a reading can be starred onto its source's favorites.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TemperatureUnit } from '../utils/temperature';
import type { TimeFormat } from '../contexts/SettingsContext';
import UnifiedTelemetryGraphs from '../components/unifiedTelemetry/UnifiedTelemetryGraphs';
import UnifiedTelemetryLatest from '../components/unifiedTelemetry/UnifiedTelemetryLatest';
import '../styles/unified.css';

type View = 'graphs' | 'latest';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export default function UnifiedTelemetryPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [view, setView] = useState<View>('graphs');
  // Bumped when a favorite changes on the Latest tab, so the graphs refetch.
  const [reloadToken, setReloadToken] = useState(0);
  // This page renders outside SettingsProvider, so read the persisted
  // preferences directly (same localStorage keys SettingsContext uses).
  const temperatureUnit: TemperatureUnit = readPref('temperatureUnit') === 'F' ? 'F' : 'C';
  const timeFormat: TimeFormat = readPref('timeFormat') === '12' ? '12' : '24';

  const header = (
    <>
      <button className="unified-header__back" onClick={() => navigate('/', { state: { showList: true } })}>
        {t('unified.back_to_sources')}
      </button>
      <div className="unified-header__title">
        <h1>{t('unified.telemetry.title')}</h1>
        <p>{view === 'graphs' ? t('unified.telemetry.subtitle_graphs') : t('unified.telemetry.subtitle')}</p>
      </div>
      <div className="unified-btn-group" role="tablist" aria-label={t('unified.telemetry.view_aria')}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'graphs'}
          className={view === 'graphs' ? 'active' : ''}
          onClick={() => setView('graphs')}
        >
          {t('unified.telemetry.view_graphs')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'latest'}
          className={view === 'latest' ? 'active' : ''}
          onClick={() => setView('latest')}
        >
          {t('unified.telemetry.view_latest')}
        </button>
      </div>
    </>
  );

  return (
    <div className="unified-page">
      {view === 'graphs' ? (
        <UnifiedTelemetryGraphs
          header={header}
          temperatureUnit={temperatureUnit}
          timeFormat={timeFormat}
          reloadToken={reloadToken}
        />
      ) : (
        <UnifiedTelemetryLatest header={header} onFavoritesChanged={() => setReloadToken((n) => n + 1)} />
      )}
    </div>
  );
}
