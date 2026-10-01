/**
 * Traceroute Explorer report (#5511).
 *
 * Every stored traceroute across the sources the user can read, on a linked
 * map and table. The server returns one window of runs (time range only);
 * every other filter runs client-side, so map clicks and filter changes
 * re-render without a round trip.
 *
 * Layout: Table | Map + Table | Map. Collapsing the map leaves a thin rail
 * (the same state as Table view); full screen pins the workspace to the
 * viewport. Read-only — this report sends nothing to any node.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { UiIcon } from '../../icons';
import { useSettings } from '../../../contexts/SettingsContext';
import type { DeviceInfo } from '../../../types/device';
import type { NodeTransportClass } from '../../../utils/nodeTransport';
import { EXPLORER_QUERY_KEY, RANGE_PRESETS, fetchExplorer } from './explorerApi';
import {
  DEFAULT_FILTERS,
  buildRuns,
  filterRuns,
  groupByPair,
  nodeLongLabel,
  summarize,
  type ExplorerFilters,
  type ExplorerNodeWire,
  type ExplorerRun,
  type ResultFilter,
} from './explorerModel';
import { ExplorerMap, type LineMode } from './ExplorerMap';
import { ExplorerTable, type GroupMode } from './ExplorerTable';
import { ExplorerDetail } from './ExplorerDetail';
import styles from './TracerouteExplorer.module.css';

export type ViewMode = 'table' | 'split' | 'map';

const PREFS_KEY = 'meshmonitor.tracerouteExplorer.prefs';
const TRANSPORTS: NodeTransportClass[] = ['rf', 'mqtt', 'udp'];
const HOP_CAPS = [1, 2, 3, 5];

interface Prefs {
  view: ViewMode;
  group: GroupMode;
  lines: LineMode;
  split: number;
}
const DEFAULT_PREFS: Prefs = { view: 'split', group: 'pair', lines: 'usage', split: 52 };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      view: p.view === 'table' || p.view === 'map' || p.view === 'split' ? p.view : DEFAULT_PREFS.view,
      group: p.group === 'flat' ? 'flat' : 'pair',
      lines: p.lines === 'snr' ? 'snr' : 'usage',
      split: typeof p.split === 'number' && p.split >= 25 && p.split <= 75 ? p.split : DEFAULT_PREFS.split,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const TracerouteExplorerReport: React.FC = () => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();

  const [rangeId, setRangeId] = useState('24h');
  const hours = RANGE_PRESETS.find(p => p.id === rangeId)?.hours ?? null;
  const [sourceFilter, setSourceFilter] = useState('');
  const [filters, setFilters] = useState<ExplorerFilters>(DEFAULT_FILTERS);
  const [syncMap, setSyncMap] = useState(true);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [openPairs, setOpenPairs] = useState<Set<string>>(new Set());
  const [full, setFull] = useState(false);
  const workRef = useRef<HTMLDivElement>(null);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs(prev => ({ ...prev, ...patch })), []);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage blocked: the choice still applies for this visit.
    }
  }, [prefs]);

  const query = useQuery({
    queryKey: [EXPLORER_QUERY_KEY, { hours }],
    queryFn: () => fetchExplorer({ hours, sourceIds: [] }),
    staleTime: 30_000,
  });
  const data = query.data;

  const allRuns = useMemo(() => buildRuns(data?.runs ?? []), [data]);
  const nodes = useMemo(() => new Map<number, ExplorerNodeWire>((data?.nodes ?? []).map(n => [n.nodeNum, n])), [data]);
  const sourceNames = useMemo(() => new Map((data?.sources ?? []).map(s => [s.id, s.name])), [data]);
  const devices = useMemo<DeviceInfo[]>(
    () =>
      (data?.nodes ?? []).map(n => ({
        nodeNum: n.nodeNum,
        user: {
          id: n.nodeId,
          longName: n.longName ?? undefined,
          shortName: n.shortName ?? undefined,
          hwModel: n.hwModel ?? undefined,
          role: n.role != null ? String(n.role) : undefined,
        },
        position: n.latitude != null && n.longitude != null ? { latitude: n.latitude, longitude: n.longitude } : undefined,
      })),
    [data],
  );

  const sourceRuns = useMemo(
    () => (sourceFilter ? allRuns.filter(r => r.sourceIds.includes(sourceFilter)) : allRuns),
    [allRuns, sourceFilter],
  );
  const mapRuns = useMemo(() => filterRuns(sourceRuns, { ...filters, nodeNum: null }, nodes), [sourceRuns, filters, nodes]);
  const tableRuns = useMemo(
    () => (syncMap && filters.nodeNum != null ? filterRuns(sourceRuns, filters, nodes) : mapRuns),
    [syncMap, sourceRuns, filters, nodes, mapRuns],
  );
  const pairs = useMemo(() => groupByPair(tableRuns), [tableRuns]);
  const summary = useMemo(() => summarize(tableRuns), [tableRuns]);

  const runByKey = useMemo(() => new Map(allRuns.map(r => [r.key, r])), [allRuns]);
  const selectedRun = selectedKey ? runByKey.get(selectedKey) ?? null : null;
  const focusRun = (hoverKey ? runByKey.get(hoverKey) : null) ?? selectedRun;
  const pairRuns = useMemo(
    () => (selectedRun ? sourceRuns.filter(r => r.pairKey === selectedRun.pairKey) : []),
    [selectedRun, sourceRuns],
  );

  // Esc leaves full screen; the page behind it must not scroll meanwhile.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [full]);

  const setFilter = <K extends keyof ExplorerFilters>(key: K, value: ExplorerFilters[K]) =>
    setFilters(prev => ({ ...prev, [key]: value }));

  const toggleTransport = (tr: NodeTransportClass) =>
    setFilter('transports', filters.transports.includes(tr) ? filters.transports.filter(x => x !== tr) : [...filters.transports, tr]);

  const onSelectRun = (run: ExplorerRun) => {
    setSelectedKey(prev => (prev === run.key ? null : run.key));
    setHoverKey(null);
  };
  const onNodeClick = (nodeNum: number) => {
    setFilter('nodeNum', filters.nodeNum === nodeNum ? null : nodeNum);
    setSelectedKey(null);
  };
  const onTogglePair = (key: string) =>
    setOpenPairs(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const work = workRef.current;
    if (!work) return;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = work.getBoundingClientRect();
      const pct = Math.min(75, Math.max(25, ((ev.clientX - rect.left) / rect.width) * 100));
      updatePrefs({ split: Math.round(pct) });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const onDividerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') updatePrefs({ split: Math.max(25, prefs.split - 4) });
    if (e.key === 'ArrowRight') updatePrefs({ split: Math.min(75, prefs.split + 4) });
  };

  const fitKey = `${rangeId}|${sourceFilter}|${data ? 'loaded' : 'empty'}`;
  const filterNode = filters.nodeNum != null ? nodeLongLabel(nodes, filters.nodeNum) : null;

  return (
    <>
      <div>
        <h2 className="reports-section__title">
          <UiIcon name="route" size={22} />
          {t('analysis.traceroute_explorer.title', 'Traceroute Explorer')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.traceroute_explorer.subtitle',
            'Every stored traceroute across your sources: forward and return paths, SNR per hop, and how routes change over time.',
          )}
        </p>
      </div>

      <div className="reports-panel">
        <div className={styles.filters}>
          <div className={styles.field}>
            <span>{t('analysis.traceroute_explorer.range', 'Time range')}</span>
            <Segmented
              label={t('analysis.traceroute_explorer.range', 'Time range')}
              value={rangeId}
              onChange={setRangeId}
              options={RANGE_PRESETS.map(p => ({
                id: p.id,
                label: p.hours == null ? t('analysis.traceroute_explorer.range_all', 'All') : p.id,
              }))}
            />
          </div>
          <label className={styles.field}>
            <span>{t('analysis.traceroute_explorer.source', 'Source')}</span>
            <select id="trx-source" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
              <option value="">{t('analysis.traceroute_explorer.all_sources', 'All sources')}</option>
              {(data?.sources ?? []).map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.field}>
            <span>{t('analysis.traceroute_explorer.result', 'Result')}</span>
            <Segmented<ResultFilter>
              label={t('analysis.traceroute_explorer.result', 'Result')}
              value={filters.result}
              onChange={v => setFilter('result', v)}
              options={[
                { id: 'all', label: t('analysis.traceroute_explorer.result_all', 'All') },
                { id: 'answered', label: t('analysis.traceroute_explorer.answered', 'Answered') },
                { id: 'failed', label: t('analysis.traceroute_explorer.no_response', 'No response') },
              ]}
            />
          </div>
          <div className={styles.field}>
            <span>{t('analysis.traceroute_explorer.transport', 'Transport')}</span>
            <div className={styles.chips}>
              {TRANSPORTS.map(tr => (
                <button
                  key={tr}
                  type="button"
                  className={styles.chip}
                  aria-pressed={filters.transports.includes(tr)}
                  onClick={() => toggleTransport(tr)}
                >
                  {tr.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <label className={styles.field}>
            <span>{t('analysis.traceroute_explorer.node_search', 'Node (endpoint or relay)')}</span>
            <input
              id="trx-search"
              type="search"
              value={filters.search}
              placeholder={t('analysis.traceroute_explorer.node_search_placeholder', 'Name or !id')}
              onChange={e => setFilter('search', e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>{t('analysis.traceroute_explorer.max_hops', 'Max hops')}</span>
            <select
              id="trx-maxhops"
              value={filters.maxHops ?? ''}
              onChange={e => setFilter('maxHops', e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">{t('analysis.traceroute_explorer.any', 'Any')}</option>
              {HOP_CAPS.map(n => (
                <option key={n} value={n}>
                  ≤ {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {filterNode && (
          <div className={styles.activeFilters}>
            <span className={styles.pill}>
              {t('analysis.traceroute_explorer.through_node', 'Through {{name}}', { name: filterNode })}
              <button
                type="button"
                aria-label={t('analysis.traceroute_explorer.clear_node', 'Clear node filter')}
                onClick={() => setFilter('nodeNum', null)}
              >
                <UiIcon name="close" size={12} />
              </button>
            </span>
          </div>
        )}
      </div>

      {query.isError && (
        <div className="reports-banner reports-banner--error">
          {t('analysis.traceroute_explorer.load_failed', 'Could not load traceroutes. Check your connection and try again.')}
        </div>
      )}
      {data?.truncated && (
        <div className="reports-banner reports-banner--warning">
          {t(
            'analysis.traceroute_explorer.truncated',
            'Showing the newest {{count}} traceroutes. Pick a shorter time range to see everything in it.',
            { count: data.scanLimit },
          )}
        </div>
      )}

      <div className={styles.summary} data-testid="traceroute-explorer-summary">
        {[
          [summary.total, t('analysis.traceroute_explorer.stat_traceroutes', 'Traceroutes')],
          [summary.pairs, t('analysis.traceroute_explorer.stat_pairs', 'Node pairs')],
          [summary.answeredPct == null ? '—' : `${summary.answeredPct}%`, t('analysis.traceroute_explorer.stat_answered', 'Answered')],
          [summary.medianHops ?? '—', t('analysis.traceroute_explorer.stat_median_hops', 'Median hops')],
          [summary.routeChanges, t('analysis.traceroute_explorer.stat_route_changes', 'Route changes')],
        ].map(([value, label]) => (
          <div key={String(label)} className={styles.stat}>
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
        {data && (
          <div className={styles.retention}>
            {t(
              'analysis.traceroute_explorer.retention',
              'The database keeps the newest {{count}} runs per node pair, so older history thins out on busy pairs.',
              { count: data.retentionPerPair },
            )}
          </div>
        )}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <Segmented<ViewMode>
            label={t('analysis.traceroute_explorer.layout', 'Layout')}
            value={prefs.view}
            onChange={v => updatePrefs({ view: v })}
            options={[
              { id: 'table', label: t('analysis.traceroute_explorer.view_table', 'Table') },
              { id: 'split', label: t('analysis.traceroute_explorer.view_split', 'Map + Table') },
              { id: 'map', label: t('analysis.traceroute_explorer.view_map', 'Map') },
            ]}
          />
          <Segmented<GroupMode>
            label={t('analysis.traceroute_explorer.rows', 'Rows')}
            value={prefs.group}
            onChange={v => updatePrefs({ group: v })}
            options={[
              { id: 'pair', label: t('analysis.traceroute_explorer.group_pair', 'Group by pair') },
              { id: 'flat', label: t('analysis.traceroute_explorer.group_flat', 'Every run') },
            ]}
          />
        </div>
        <div className={styles.toolbarGroup}>
          <label className={styles.toggle}>
            <input id="trx-sync" type="checkbox" checked={syncMap} onChange={e => setSyncMap(e.target.checked)} />
            {t('analysis.traceroute_explorer.sync_map', 'Filter table by map selection')}
          </label>
          <button type="button" className="reports-btn reports-btn--ghost" onClick={() => setFull(f => !f)}>
            <UiIcon name={full ? 'minimize' : 'maximize'} size={14} />{' '}
            {full
              ? t('analysis.traceroute_explorer.exit_full_screen', 'Exit full screen')
              : t('analysis.traceroute_explorer.full_screen', 'Full screen')}
          </button>
        </div>
      </div>

      <div
        ref={workRef}
        className={`${styles.work} ${full ? styles.full : ''}`}
        data-view={prefs.view}
        style={{ '--trx-split': `${prefs.split}%` } as React.CSSProperties}
        data-testid="traceroute-explorer-workspace"
      >
        {prefs.view === 'table' && (
          <div className={styles.rail}>
            <button type="button" onClick={() => updatePrefs({ view: 'split' })}>
              <UiIcon name="map" size={14} /> {t('analysis.traceroute_explorer.show_map', 'Show map')}
            </button>
          </div>
        )}
        {prefs.view !== 'table' && (
          <div className={styles.mapPane}>
            <ExplorerMap
              runs={mapRuns}
              nodes={nodes}
              focusRun={focusRun}
              nodeFilter={filters.nodeNum}
              lineMode={prefs.lines}
              fitKey={fitKey}
              onNodeClick={onNodeClick}
              onBackgroundClick={() => setSelectedKey(null)}
            />
            <div className={styles.mapTools}>
              {full && prefs.view === 'map' && (
                <button type="button" className={styles.mapToolBtn} onClick={() => setFull(false)}>
                  <UiIcon name="minimize" size={14} />
                  {t('analysis.traceroute_explorer.exit_full_screen', 'Exit full screen')}
                </button>
              )}
              {prefs.view === 'split' && (
                <button type="button" className={styles.mapToolBtn} onClick={() => updatePrefs({ view: 'table' })}>
                  <UiIcon name="chevronRight" size={14} style={{ transform: 'rotate(180deg)' }} />
                  {t('analysis.traceroute_explorer.collapse_map', 'Collapse map')}
                </button>
              )}
              <Segmented<LineMode>
                label={t('analysis.traceroute_explorer.map_lines', 'Map lines')}
                value={prefs.lines}
                onChange={v => updatePrefs({ lines: v })}
                options={[
                  { id: 'usage', label: t('analysis.traceroute_explorer.lines_usage', 'Link usage') },
                  { id: 'snr', label: t('analysis.traceroute_explorer.lines_snr', 'Link SNR') },
                ]}
              />
            </div>
            <div className={styles.mapHint}>
              {focusRun
                ? t('analysis.traceroute_explorer.hint_run', '{{from}} to {{to}}', {
                    from: nodeLongLabel(nodes, focusRun.fromNodeNum),
                    to: nodeLongLabel(nodes, focusRun.toNodeNum),
                  })
                : filterNode
                  ? t('analysis.traceroute_explorer.hint_node', 'Showing routes through {{name}}', { name: filterNode })
                  : t('analysis.traceroute_explorer.hint_default', 'Line width shows how many traceroute hops used a link. Click a node to filter.')}
            </div>
          </div>
        )}
        {prefs.view === 'split' && (
          <div
            className={styles.divider}
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={prefs.split}
            aria-valuemin={25}
            aria-valuemax={75}
            aria-label={t('analysis.traceroute_explorer.resize', 'Resize map and table')}
            tabIndex={0}
            onPointerDown={onDividerPointerDown}
            onKeyDown={onDividerKey}
          />
        )}
        {prefs.view !== 'map' && (
          <div className={styles.tablePane}>
            <div className={styles.tableScroll}>
              {query.isLoading ? (
                <div className={styles.empty}>{t('analysis.traceroute_explorer.loading', 'Loading traceroutes…')}</div>
              ) : (
                <ExplorerTable
                  runs={tableRuns}
                  pairs={pairs}
                  groupMode={prefs.group}
                  selectedKey={selectedKey}
                  openPairs={openPairs}
                  onTogglePair={onTogglePair}
                  onSelectRun={onSelectRun}
                  onHoverRun={run => setHoverKey(run?.key ?? null)}
                  nodes={nodes}
                  sourceNames={sourceNames}
                  timeFormat={timeFormat}
                  dateFormat={dateFormat}
                />
              )}
            </div>
            <div className={styles.tableFoot}>
              <span>
                {prefs.group === 'pair'
                  ? t('analysis.traceroute_explorer.count_pairs', '{{pairs}} pairs · {{runs}} runs', {
                      pairs: pairs.length,
                      runs: tableRuns.length,
                    })
                  : t('analysis.traceroute_explorer.count_runs', '{{runs}} runs', { runs: tableRuns.length })}
              </span>
              {full && (
                <button type="button" className="reports-btn reports-btn--ghost" onClick={() => setFull(false)}>
                  <UiIcon name="minimize" size={14} /> {t('analysis.traceroute_explorer.exit_full_screen', 'Exit full screen')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="reports-panel">
        <ExplorerDetail run={selectedRun} pairRuns={pairRuns} nodes={nodes} devices={devices} sourceNames={sourceNames} />
      </div>
    </>
  );
};

export default TracerouteExplorerReport;
