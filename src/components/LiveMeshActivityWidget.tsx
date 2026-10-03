/**
 * LiveMeshActivityWidget - per-source dashboard widget listing every remote
 * node this source heard in a rolling window (#5557), like the Meshtastic
 * mobile client's live mesh activity view.
 *
 * Read-only: it polls GET /api/packets/stats/node-activity every 10 s while
 * the tab is visible and sends nothing to the mesh. Data comes from the
 * opt-in packet log, so the widget explains how to turn that on when it is
 * off, and says how far back the data reaches when the log cap cuts the
 * window short.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UiIcon } from './icons';
import { useSource } from '../contexts/SourceContext';
import { useSettings } from '../contexts/SettingsContext';
import { formatTime } from '../utils/datetime';
import { getNodeActivity, type NodeActivityNode } from '../services/packetApi';
import styles from './LiveMeshActivityWidget.module.css';

/** Window choices in minutes; must match NODE_ACTIVITY_WINDOWS on the server. */
const LIVE_ACTIVITY_WINDOWS = [1, 5, 10, 30, 60] as const;
const LIVE_ACTIVITY_DEFAULT_WINDOW = 10;
const LIVE_ACTIVITY_POLL_MS = 10_000;
/** SNR within this many dB of the window average reads as steady. */
const TREND_DEADBAND_DB = 1;

type SortKey = 'lastHeard' | 'packets' | 'snr' | 'hops';

interface LiveMeshActivityWidgetProps {
  id: string;
  windowMinutes: number;
  onWindowChange: (windowMinutes: number) => void;
  onRemove: () => void;
  onOpenNodeDetails?: (nodeId: string) => void;
  canEdit?: boolean;
}

const nodeIdOf = (n: NodeActivityNode): string =>
  n.nodeId ?? `!${(n.nodeNum >>> 0).toString(16).padStart(8, '0')}`;

/** Sort value; nulls always sink to the bottom regardless of direction. */
function sortValue(n: NodeActivityNode, key: SortKey): number | null {
  switch (key) {
    case 'packets': return n.packets;
    case 'snr': return n.lastSnr;
    case 'hops': return n.lastHops;
    default: return n.lastHeard;
  }
}

const LiveMeshActivityWidget: React.FC<LiveMeshActivityWidgetProps> = ({
  id,
  windowMinutes,
  onWindowChange,
  onRemove,
  onOpenNodeDetails,
  canEdit = true,
}) => {
  const { t } = useTranslation();
  const { sourceId } = useSource();
  const { timeFormat } = useSettings();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  // Seeded from the saved config; a change is saved back through
  // onWindowChange (editors only) and otherwise stays local to this view.
  const [windowMin, setWindowMin] = useState<number>(() =>
    (LIVE_ACTIVITY_WINDOWS as readonly number[]).includes(windowMinutes) ? windowMinutes : LIVE_ACTIVITY_DEFAULT_WINDOW,
  );
  const [allTransports, setAllTransports] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('lastHeard');
  const [sortDesc, setSortDesc] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const transport = allTransports ? 'all' : 'rf';
  const query = useQuery({
    queryKey: ['liveMeshActivity', sourceId, windowMin, transport] as const,
    queryFn: () => getNodeActivity(sourceId as string, windowMin, transport),
    enabled: !!sourceId,
    refetchInterval: LIVE_ACTIVITY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: LIVE_ACTIVITY_POLL_MS / 2,
  });

  // One-second tick drives the countdown and the relative "last heard" text.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const data = query.data;
  const rows = useMemo(() => {
    const list = [...(data?.nodes ?? [])];
    list.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va === null && vb === null) return b.lastHeard - a.lastHeard;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va === vb) return b.lastHeard - a.lastHeard;
      return sortDesc ? vb - va : va - vb;
    });
    return list;
  }, [data, sortKey, sortDesc]);

  const secondsLeft = query.dataUpdatedAt
    ? Math.max(0, Math.ceil((query.dataUpdatedAt + LIVE_ACTIVITY_POLL_MS - now) / 1000))
    : null;

  const handleWindowChange = (value: number) => {
    setWindowMin(value);
    if (canEdit) onWindowChange(value);
  };

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc(d => !d);
    } else {
      setSortKey(key);
      // Hops read best low-first; everything else high-first.
      setSortDesc(key !== 'hops');
    }
  };

  const formatAgo = (ts: number): string => {
    const sec = Math.max(0, Math.floor((now - ts) / 1000));
    if (sec < 60) return t('dashboard.widget.live_mesh_activity.seconds_ago', { count: sec });
    return t('dashboard.widget.live_mesh_activity.minutes_ago', { count: Math.floor(sec / 60) });
  };

  const renderTrend = (n: NodeActivityNode) => {
    if (n.lastSnr === null || n.avgSnr === null) return null;
    const delta = n.lastSnr - n.avgSnr;
    if (delta > TREND_DEADBAND_DB) {
      return (
        <span className={`${styles.trend} ${styles.trendUp}`} title={t('dashboard.widget.live_mesh_activity.trend_up')} data-trend="up">
          <UiIcon name="sortAscending" size={12} />
        </span>
      );
    }
    if (delta < -TREND_DEADBAND_DB) {
      return (
        <span className={`${styles.trend} ${styles.trendDown}`} title={t('dashboard.widget.live_mesh_activity.trend_down')} data-trend="down">
          <UiIcon name="sortDescending" size={12} />
        </span>
      );
    }
    return <span className={styles.trend} title={t('dashboard.widget.live_mesh_activity.trend_flat')} data-trend="flat" />;
  };

  const sortHeader = (key: SortKey, label: string, numeric = true) => {
    const active = sortKey === key;
    return (
      <th className={numeric ? styles.num : undefined} aria-sort={active ? (sortDesc ? 'descending' : 'ascending') : 'none'}>
        <button
          type="button"
          className={`${styles.sortButton} ${active ? styles.sortActive : ''}`}
          onClick={() => handleSort(key)}
          title={t('dashboard.widget.live_mesh_activity.sort_by', { column: label })}
        >
          {label}
          {active && <UiIcon name={sortDesc ? 'sortDescending' : 'sortAscending'} size={11} />}
        </button>
      </th>
    );
  };

  const openNode = (n: NodeActivityNode) => {
    if (onOpenNodeDetails) onOpenNodeDetails(nodeIdOf(n));
  };

  const renderBody = () => {
    if (!sourceId) {
      return <div className={styles.empty}>{t('dashboard.widget.live_mesh_activity.no_source')}</div>;
    }
    if (query.isError) {
      return <div className={styles.empty}>{t('dashboard.widget.live_mesh_activity.error')}</div>;
    }
    if (!data) return null;
    if (!data.enabled) {
      return (
        <div className={styles.empty} data-testid="live-activity-disabled">
          <div className={styles.emptyTitle}>{t('dashboard.widget.live_mesh_activity.disabled_title')}</div>
          <div>{t('dashboard.widget.live_mesh_activity.disabled_where')}</div>
        </div>
      );
    }
    return (
      <>
        {data.truncated && data.coverageStart !== null && (
          <div className={styles.notice} data-testid="live-activity-truncated">
            {t('dashboard.widget.live_mesh_activity.truncated', {
              time: formatTime(new Date(data.coverageStart), timeFormat),
            })}
          </div>
        )}
        {rows.length === 0 ? (
          <div className={styles.empty}>{t('dashboard.widget.live_mesh_activity.empty')}</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('dashboard.widget.live_mesh_activity.col_node')}</th>
                  {sortHeader('packets', t('dashboard.widget.live_mesh_activity.col_packets'))}
                  <th className={styles.num} title={t('dashboard.widget.live_mesh_activity.col_extra_hint')}>
                    {t('dashboard.widget.live_mesh_activity.col_extra')}
                  </th>
                  {sortHeader('snr', t('dashboard.widget.live_mesh_activity.col_snr'))}
                  {sortHeader('hops', t('dashboard.widget.live_mesh_activity.col_hops'))}
                  {sortHeader('lastHeard', t('dashboard.widget.live_mesh_activity.col_last_heard'), false)}
                </tr>
              </thead>
              <tbody>
                {rows.map(n => (
                  <tr
                    key={n.nodeNum}
                    className={onOpenNodeDetails ? styles.row : undefined}
                    tabIndex={onOpenNodeDetails ? 0 : undefined}
                    onClick={() => openNode(n)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openNode(n);
                      }
                    }}
                    data-testid="live-activity-row"
                  >
                    <td title={n.longName ?? undefined}>
                      <span className={styles.nodeName}>{n.shortName ?? n.longName ?? nodeIdOf(n)}</span>
                      <span className={styles.nodeId}>{nodeIdOf(n)}</span>
                    </td>
                    <td className={styles.num}>{n.packets}</td>
                    <td className={styles.num}>{n.extraReceptions}</td>
                    <td className={styles.num}>
                      {n.lastSnr === null ? '-' : `${n.lastSnr.toFixed(1)} dB`}
                      {renderTrend(n)}
                    </td>
                    <td className={styles.num}>
                      {`${n.lastHops ?? '?'} / ${n.minHops ?? '?'}`}
                    </td>
                    <td>{formatAgo(n.lastHeard)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="dashboard-chart-container live-mesh-activity-widget"
    >
      <div className="dashboard-chart-header">
        <span className="dashboard-drag-handle" {...attributes} {...listeners}>
          <UiIcon name="dragHandle" size={14} />
        </span>
        <h3 className="dashboard-chart-title">{t('dashboard.widget.live_mesh_activity.title')}</h3>
        {canEdit && (
          <button className="dashboard-remove-btn" onClick={onRemove} title={t('dashboard.remove_widget')} aria-label={t('dashboard.remove_widget')}>
            <UiIcon name="close" size={14} />
          </button>
        )}
      </div>

      <div className={styles.controls}>
        <label className={styles.control}>
          {t('dashboard.widget.live_mesh_activity.window')}
          <select value={windowMin} onChange={e => handleWindowChange(Number(e.target.value))}>
            {LIVE_ACTIVITY_WINDOWS.map(w => (
              <option key={w} value={w}>
                {w === 60
                  ? t('dashboard.widget.live_mesh_activity.window_option_hour')
                  : t('dashboard.widget.live_mesh_activity.window_option', { count: w })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control} title={t('dashboard.widget.live_mesh_activity.all_transports_hint')}>
          <input type="checkbox" checked={allTransports} onChange={e => setAllTransports(e.target.checked)} />
          {t('dashboard.widget.live_mesh_activity.all_transports')}
        </label>
        {data?.enabled && secondsLeft !== null && (
          <span className={styles.countdown} aria-live="off">
            {t('dashboard.widget.live_mesh_activity.refresh_in', { seconds: secondsLeft })}
          </span>
        )}
      </div>

      {renderBody()}
    </div>
  );
};

export default LiveMeshActivityWidget;
