/**
 * MeshCoreCliActivity — every MeshCore CLI command people issued through
 * MeshMonitor, across the sources the viewer may read (#5892).
 *
 * The server limits rows per source to what the viewer may see (remote rows
 * need remote_admin:read, local rows configuration:read) and lists only those
 * sources in the filter.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../services/api';
import { UiIcon } from '../icons';
import { CliHistoryList } from './CliHistoryList';
import { fetchUnifiedCliHistory, type CliHistoryEntry, type CliHistoryFilters } from './cliHistoryApi';
import styles from './CliHistory.module.css';

const PAGE_SIZE = 50;

/** `YYYY-MM-DD` (local) → ms at the start or end of that day. */
function dayBound(value: string, end: boolean): number | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (end) d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export const MeshCoreCliActivity: React.FC = () => {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const [user, setUser] = useState('');
  const [target, setTarget] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [entries, setEntries] = useState<CliHistoryEntry[]>([]);
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters = useMemo<CliHistoryFilters>(() => ({
    limit: PAGE_SIZE,
    source: source || undefined,
    user: user.trim() || undefined,
    target: target || undefined,
    from: dayBound(fromDate, false),
    to: dayBound(toDate, true),
  }), [source, user, target, fromDate, toDate]);

  const load = useCallback(async (before: number | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUnifiedCliHistory({ ...filters, before });
      setEntries((prev) => (before === null ? page.entries : [...prev, ...page.entries]));
      setNextBefore(page.nextBefore);
      if (page.sources) setSources(page.sources);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('meshcore.cliHistory.no_permission', 'You do not have permission to view MeshCore CLI history on any source.'));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setEntries([]);
      setNextBefore(null);
    } finally {
      setLoading(false);
    }
  }, [filters, t]);

  useEffect(() => {
    void load(null);
  }, [load]);

  const sourceNames = useMemo(
    () => Object.fromEntries(sources.map((s) => [s.id, s.name])),
    [sources],
  );

  const clear = () => {
    setSource('');
    setUser('');
    setTarget('');
    setFromDate('');
    setToDate('');
  };

  return (
    <div className={styles.activity}>
      <p className={styles.hint}>
        {t(
          'meshcore.cliHistory.activity_hint',
          'MeshCore CLI commands people sent through MeshMonitor: the Local and Remote consoles, the time-sync button, and Virtual Node apps. Background polls are not listed. Passwords and keys are masked.',
        )}
      </p>
      <div className={styles.filters}>
        <label className={styles.field}>
          {t('meshcore.cliHistory.filter_source', 'Source')}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t('meshcore.cliHistory.all_sources', 'All sources')}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          {t('meshcore.cliHistory.filter_target', 'Target')}
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t('meshcore.cliHistory.all_targets', 'All targets')}</option>
            <option value="local">{t('meshcore.cliHistory.target_local', 'Local node')}</option>
            <option value="remote">{t('meshcore.cliHistory.target_remote', 'Remote node')}</option>
          </select>
        </label>
        <label className={styles.field}>
          {t('meshcore.cliHistory.filter_user', 'User')}
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={t('meshcore.cliHistory.filter_user_placeholder', 'Exact username')}
          />
        </label>
        <label className={styles.field}>
          {t('meshcore.cliHistory.filter_from', 'From')}
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label className={styles.field}>
          {t('meshcore.cliHistory.filter_to', 'To')}
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <div className={styles.field}>
          <span>&nbsp;</span>
          <div className={styles.panelHeader}>
            <button type="button" className={styles.more} onClick={clear}>
              {t('meshcore.cliHistory.clear_filters', 'Clear')}
            </button>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => void load(null)}
              disabled={loading}
              title={t('meshcore.cliHistory.refresh', 'Refresh')}
              aria-label={t('meshcore.cliHistory.refresh', 'Refresh')}
            >
              <UiIcon name="refresh" size={14} />
            </button>
          </div>
        </div>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {!error && !loading && entries.length === 0 && (
        <p className={styles.empty}>{t('meshcore.cliHistory.empty', 'No commands recorded yet.')}</p>
      )}
      {entries.length > 0 && (
        <CliHistoryList entries={entries} showSource showTarget sourceNames={sourceNames} />
      )}
      {nextBefore !== null && (
        <div>
          <button type="button" className={styles.more} onClick={() => void load(nextBefore)} disabled={loading}>
            {t('meshcore.cliHistory.load_more', 'Load more')}
          </button>
        </div>
      )}
      {loading && <p className={styles.empty}>{t('meshcore.cliHistory.loading', 'Loading…')}</p>}
    </div>
  );
};

export default MeshCoreCliActivity;
