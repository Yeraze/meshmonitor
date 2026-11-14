/**
 * Direct RF Contacts report (#6210).
 *
 * "Which nodes has my radio heard directly over RF in the past X days?" One
 * row per node heard at zero hops by the chosen source's own radio (never via
 * MQTT), from the `direct_rf_contacts` daily rollup. Works for Meshtastic TCP
 * and MeshCore companion sources; viewing it sends nothing on the mesh.
 *
 * Backend: `GET /api/sources/:id/direct-rf-contacts?from=&to=` returns
 * `{ success, data }`; `ApiService` does not unwrap `data`, so it is read
 * explicitly.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useSettingsOptional } from '../../contexts/SettingsContext';
import { formatDateTime } from '../../utils/datetime';
import { formatDistance } from '../../utils/distance';
import { downloadTextFile } from '../../utils/nodeExport';
import { UiIcon } from '../icons';
import {
  buildDirectRfCsv,
  contactLabel,
  directRfCsvFilename,
  isDirectRfSourceType,
  resolveWindow,
  sortContacts,
  type DirectRfContactsResponse,
  type DirectRfPreset,
  type DirectRfSortKey,
} from './directRfContacts';
import styles from './DirectRfContactsReport.module.css';

interface SourceRow {
  id: string;
  name: string;
  type?: string;
}

const PRESETS: Array<Exclude<DirectRfPreset, 'custom'>> = ['24h', '7d', '30d'];

const fmtDb = (n: number | null, unit: string): string => (n == null ? '—' : `${n} ${unit}`);

export default function DirectRfContactsReport() {
  const { t } = useTranslation();
  const settings = useSettingsOptional();
  const timeFormat = settings?.timeFormat ?? '24';
  const dateFormat = settings?.dateFormat ?? 'MM/DD/YYYY';
  const distanceUnit = settings?.distanceUnit ?? 'km';

  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [sourceId, setSourceId] = useState<string>('');
  const [preset, setPreset] = useState<DirectRfPreset>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<DirectRfContactsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<DirectRfSortKey>('lastHeardAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    let cancelled = false;
    apiService.get<SourceRow[]>('/api/sources')
      .then((rows) => {
        if (cancelled) return;
        const usable = (Array.isArray(rows) ? rows : []).filter((s) => isDirectRfSourceType(s.type));
        setSources(usable);
        setSourceId((cur) => cur || usable[0]?.id || '');
      })
      .catch(() => { if (!cancelled) setSources([]); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!sourceId) return;
    const window = resolveWindow(preset, Date.now(), customFrom, customTo);
    if (!window) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.get<{ success: boolean; data: DirectRfContactsResponse }>(
        `/api/sources/${encodeURIComponent(sourceId)}/direct-rf-contacts?from=${window.from}&to=${window.to}`,
      );
      setData(res?.data ?? null);
    } catch (err) {
      setData(null);
      setError((err as Error)?.message || t('analysis.direct_rf.failed', 'Failed to load direct RF contacts.'));
    } finally {
      setLoading(false);
    }
  }, [sourceId, preset, customFrom, customTo, t]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(
    () => (data ? sortContacts(data.contacts, sortKey, sortDir) : []),
    [data, sortKey, sortDir],
  );

  const onSort = (key: DirectRfSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const onExport = () => {
    if (!data) return;
    const sourceName = sources?.find((s) => s.id === sourceId)?.name ?? sourceId;
    downloadTextFile(directRfCsvFilename(sourceName, data.from, data.to), buildDirectRfCsv(rows), 'text/csv;charset=utf-8');
  };

  const when = (ms: number) => formatDateTime(new Date(ms), timeFormat, dateFormat);

  const header = (key: DirectRfSortKey, label: string, numeric = false) => (
    <th className={numeric ? styles.numeric : undefined} aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={styles.sortButton} onClick={() => onSort(key)} data-testid={`direct-rf-sort-${key}`}>
        {label}
        {sortKey === key && <UiIcon name={sortDir === 'asc' ? 'sortAscending' : 'sortDescending'} size={12} />}
      </button>
    </th>
  );

  const customIncomplete = preset === 'custom' && !resolveWindow('custom', Date.now(), customFrom, customTo);

  return (
    <section className={styles.report} data-testid="direct-rf-report">
      <h2 className={styles.title}>
        <UiIcon name="radio" /> {t('analysis.direct_rf.title', 'Direct RF Contacts')}
      </h2>
      <p className={styles.intro}>
        {t(
          'analysis.direct_rf.intro',
          'Nodes your radio heard directly over RF (zero hops, not via MQTT), counted per UTC day. Viewing this sends nothing on the mesh.',
        )}
      </p>

      <div className={styles.controls}>
        <label className={styles.field}>
          {t('analysis.direct_rf.source', 'Source')}
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            disabled={!sources || sources.length === 0}
            data-testid="direct-rf-source"
          >
            {(sources ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <div className={styles.field}>
          {t('analysis.direct_rf.range', 'Time range')}
          <div className={styles.presets} role="group">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`${styles.preset} ${preset === p ? styles.presetActive : ''}`}
                aria-pressed={preset === p}
                onClick={() => setPreset(p)}
                data-testid={`direct-rf-preset-${p}`}
              >
                {t(`analysis.direct_rf.preset_${p}`, p)}
              </button>
            ))}
            <button
              type="button"
              className={`${styles.preset} ${preset === 'custom' ? styles.presetActive : ''}`}
              aria-pressed={preset === 'custom'}
              onClick={() => setPreset('custom')}
              data-testid="direct-rf-preset-custom"
            >
              {t('analysis.direct_rf.preset_custom', 'Custom')}
            </button>
          </div>
        </div>

        {preset === 'custom' && (
          <>
            <label className={styles.field}>
              {t('analysis.direct_rf.from', 'From')}
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} data-testid="direct-rf-from" />
            </label>
            <label className={styles.field}>
              {t('analysis.direct_rf.to', 'To')}
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} data-testid="direct-rf-to" />
            </label>
          </>
        )}

        <button
          type="button"
          className={styles.exportButton}
          onClick={onExport}
          disabled={rows.length === 0}
          data-testid="direct-rf-export"
        >
          <UiIcon name="download" size={14} /> {t('analysis.direct_rf.export_csv', 'Export CSV')}
        </button>
      </div>

      {sources && sources.length === 0 && (
        <p className={styles.empty} data-testid="direct-rf-no-sources">
          {t('analysis.direct_rf.no_sources', 'No Meshtastic TCP or MeshCore companion source you can read.')}
        </p>
      )}
      {customIncomplete && (
        <p className={styles.empty}>{t('analysis.direct_rf.custom_hint', 'Pick a start and end date.')}</p>
      )}
      {error && <p className={styles.error} role="alert" data-testid="direct-rf-error">{error}</p>}
      {loading && !data && <p className={styles.empty}>{t('analysis.direct_rf.loading', 'Loading…')}</p>}

      {data && (
        <>
          <p className={styles.summary} data-testid="direct-rf-summary">
            {t('analysis.direct_rf.summary', '{{count}} nodes heard directly. History is kept for {{days}} days.', {
              count: data.contacts.length,
              days: data.retentionDays,
            })}
          </p>
          {rows.length === 0 ? (
            <p className={styles.empty} data-testid="direct-rf-empty">
              {t('analysis.direct_rf.empty', 'No nodes heard directly over RF in this window. Only receptions since this feature was installed are counted.')}
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="direct-rf-table">
                <thead>
                  <tr>
                    {header('name', t('analysis.direct_rf.col_node', 'Node'))}
                    {header('firstHeardAt', t('analysis.direct_rf.col_first', 'First heard direct'))}
                    {header('lastHeardAt', t('analysis.direct_rf.col_last', 'Last heard direct'))}
                    {header('receptionCount', t('analysis.direct_rf.col_count', 'Direct receptions'), true)}
                    {header('bestSnr', t('analysis.direct_rf.col_best_snr', 'Best SNR'), true)}
                    {header('avgSnr', t('analysis.direct_rf.col_avg_snr', 'Avg SNR'), true)}
                    {header('bestRssi', t('analysis.direct_rf.col_best_rssi', 'Best RSSI'), true)}
                    {header('avgRssi', t('analysis.direct_rf.col_avg_rssi', 'Avg RSSI'), true)}
                    {header('distanceKm', t('analysis.direct_rf.col_distance', 'Distance'), true)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.nodeKey} data-testid={`direct-rf-row-${c.nodeKey}`}>
                      <td>
                        {contactLabel(c)}
                        <span className={styles.nodeId}>{c.protocol === 'meshcore' ? `${c.nodeKey.slice(0, 16)}…` : c.nodeKey}</span>
                      </td>
                      <td>{when(c.firstHeardAt)}</td>
                      <td>{when(c.lastHeardAt)}</td>
                      <td className={styles.numeric}>{c.receptionCount}</td>
                      <td className={styles.numeric}>{fmtDb(c.bestSnr, 'dB')}</td>
                      <td className={styles.numeric}>{fmtDb(c.avgSnr, 'dB')}</td>
                      <td className={styles.numeric}>{fmtDb(c.bestRssi, 'dBm')}</td>
                      <td className={styles.numeric}>{fmtDb(c.avgRssi, 'dBm')}</td>
                      <td className={styles.numeric}>{c.distanceKm == null ? '—' : formatDistance(c.distanceKm, distanceUnit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
