/**
 * Traceroute Explorer (#5511) — table pane.
 *
 * Two row modes: grouped by from→to pair (expand a pair to see its runs), or
 * one row per run. Hovering a run previews it on the map; clicking pins it.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { formatDateTime, formatRelativeTime } from '../../../utils/datetime';
import type { DateFormat, TimeFormat } from '../../../contexts/SettingsContext';
import {
  formatSnr,
  nodeLabel,
  nodeLongLabel,
  snrBand,
  type ExplorerNodeWire,
  type ExplorerPair,
  type ExplorerRun,
} from './explorerModel';
import styles from './TracerouteExplorer.module.css';

export type GroupMode = 'pair' | 'flat';

const FLAT_PAGE = 200;
const SPARK_RUNS = 14;

interface Ctx {
  nodes: Map<number, ExplorerNodeWire>;
  sourceNames: Map<string, string>;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

export const PathChips: React.FC<{
  seq: number[];
  snr: Array<number | null>;
  nodes: Map<number, ExplorerNodeWire>;
}> = ({ seq, snr, nodes }) => (
  <span className={styles.path}>
    {seq.map((n, i) => (
      <React.Fragment key={`${i}-${n}`}>
        {i > 0 && <span className={styles.pathSep} aria-hidden="true">›</span>}
        <span className={styles.hop} title={nodeLongLabel(nodes, n)}>
          {nodeLabel(nodes, n)}
          {i > 0 && <span className={`${styles.db} ${styles[`db_${snrBand(snr[i - 1] ?? null)}`]}`}>{formatSnr(snr[i - 1] ?? null)}</span>}
        </span>
      </React.Fragment>
    ))}
  </span>
);

const When: React.FC<{ ts: number; ctx: Ctx }> = ({ ts, ctx }) => (
  <span className={styles.when} title={formatDateTime(new Date(ts), ctx.timeFormat, ctx.dateFormat)}>
    {formatRelativeTime(ts, ctx.timeFormat, ctx.dateFormat)}
  </span>
);

const sourceList = (ids: string[], ctx: Ctx) => ids.map(id => ctx.sourceNames.get(id) ?? id).join(', ');

const RunResult: React.FC<{ run: ExplorerRun }> = ({ run }) => {
  const { t } = useTranslation();
  return (
    <>
      <span className={`${styles.status} ${run.answered ? styles.statusOk : styles.statusFail}`}>
        {run.answered
          ? t('analysis.traceroute_explorer.answered', 'Answered')
          : t('analysis.traceroute_explorer.no_response', 'No response')}
      </span>
      <span className={styles.tags}>
        <span className={styles.tag}>{run.transport.toUpperCase()}</span>
        {run.routeChanged && (
          <span className={`${styles.tag} ${styles.tagFlag}`}>{t('analysis.traceroute_explorer.route_changed', 'Route changed')}</span>
        )}
        {run.asymmetric && (
          <span className={`${styles.tag} ${styles.tagFlag}`}>{t('analysis.traceroute_explorer.asymmetric', 'Asymmetric')}</span>
        )}
      </span>
    </>
  );
};

export interface ExplorerTableProps extends Ctx {
  runs: ExplorerRun[];
  pairs: ExplorerPair[];
  groupMode: GroupMode;
  selectedKey: string | null;
  openPairs: Set<string>;
  onTogglePair: (key: string) => void;
  onSelectRun: (run: ExplorerRun) => void;
  onHoverRun: (run: ExplorerRun | null) => void;
}

export const ExplorerTable: React.FC<ExplorerTableProps> = props => {
  const { t } = useTranslation();
  const { runs, pairs, groupMode, selectedKey, openPairs, onTogglePair, onSelectRun, onHoverRun } = props;
  const ctx: Ctx = props;
  const [flatLimit, setFlatLimit] = useState(FLAT_PAGE);
  // New data or filters start from the first page again.
  useEffect(() => setFlatLimit(FLAT_PAGE), [runs]);

  const activate = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  const runRow = (run: ExplorerRun, child: boolean) => (
    <tr
      key={run.key}
      className={`${child ? styles.childRow : ''} ${selectedKey === run.key ? styles.selectedRow : ''}`}
      tabIndex={0}
      aria-selected={selectedKey === run.key}
      onClick={() => onSelectRun(run)}
      onKeyDown={e => activate(e, () => onSelectRun(run))}
      onMouseEnter={() => onHoverRun(run)}
      data-testid="explorer-run-row"
    >
      <td colSpan={child ? 2 : 1}>
        <When ts={run.timestamp} ctx={ctx} />
      </td>
      {!child && (
        <td className={styles.pair}>
          {nodeLabel(ctx.nodes, run.fromNodeNum)}
          <UiIcon name="forward" size={12} className={styles.pairArrow} />
          {nodeLabel(ctx.nodes, run.toNodeNum)}
        </td>
      )}
      <td>
        {run.forward ? (
          <PathChips seq={run.forward} snr={run.forwardSnr} nodes={ctx.nodes} />
        ) : (
          <span className={styles.muted}>{t('analysis.traceroute_explorer.no_route', 'No route returned')}</span>
        )}
      </td>
      <td>{run.back ? <PathChips seq={run.back} snr={run.backSnr} nodes={ctx.nodes} /> : <span className={styles.muted}>—</span>}</td>
      <td className={styles.num}>
        {run.hops == null ? '—' : run.back ? `${run.hops} / ${run.back.length - 2}` : run.hops}
      </td>
      <td>
        <RunResult run={run} />
      </td>
      <td className={styles.muted}>{sourceList(run.sourceIds, ctx)}</td>
    </tr>
  );

  if (runs.length === 0) {
    return (
      <div className={styles.empty}>
        {t('analysis.traceroute_explorer.empty', 'No traceroutes match these filters. Try a wider time range or clear the node filter.')}
      </div>
    );
  }

  if (groupMode === 'flat') {
    return (
      <>
        <table className={styles.table} onMouseLeave={() => onHoverRun(null)}>
          <thead>
            <tr>
              <th>{t('analysis.traceroute_explorer.col_when', 'When')}</th>
              <th>{t('analysis.traceroute_explorer.col_pair', 'Pair')}</th>
              <th>{t('analysis.traceroute_explorer.col_forward', 'Forward (SNR dB)')}</th>
              <th>{t('analysis.traceroute_explorer.col_return', 'Return')}</th>
              <th>{t('analysis.traceroute_explorer.col_hops', 'Hops')}</th>
              <th>{t('analysis.traceroute_explorer.col_result', 'Result')}</th>
              <th>{t('analysis.traceroute_explorer.col_source', 'Source')}</th>
            </tr>
          </thead>
          <tbody>{runs.slice(0, flatLimit).map(run => runRow(run, false))}</tbody>
        </table>
        {runs.length > flatLimit && (
          <div className={styles.moreRow}>
            <button type="button" className="reports-btn reports-btn--ghost" onClick={() => setFlatLimit(l => l + FLAT_PAGE)}>
              {t('analysis.traceroute_explorer.show_more', 'Show {{count}} more', { count: Math.min(FLAT_PAGE, runs.length - flatLimit) })}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <table className={styles.table} onMouseLeave={() => onHoverRun(null)}>
      <thead>
        <tr>
          <th>{t('analysis.traceroute_explorer.col_last_run', 'Last run')}</th>
          <th>{t('analysis.traceroute_explorer.col_pair', 'Pair')}</th>
          <th>{t('analysis.traceroute_explorer.col_latest_path', 'Latest forward path (SNR dB)')}</th>
          <th>{t('analysis.traceroute_explorer.col_history', 'History')}</th>
          <th>{t('analysis.traceroute_explorer.col_median_hops', 'Med. hops')}</th>
          <th>{t('analysis.traceroute_explorer.col_answer_rate', 'Answer rate')}</th>
          <th>{t('analysis.traceroute_explorer.col_source', 'Source')}</th>
        </tr>
      </thead>
      <tbody>
        {pairs.map(pair => {
          const open = openPairs.has(pair.key);
          const pct = Math.round((pair.answeredCount / pair.runs.length) * 100);
          const rateClass = pct >= 80 ? styles.rateGood : pct >= 50 ? styles.rateFair : styles.ratePoor;
          const latest = pair.latestAnswered;
          return (
            <React.Fragment key={pair.key}>
              <tr
                className={styles.pairRow}
                tabIndex={0}
                aria-expanded={open}
                onClick={() => onTogglePair(pair.key)}
                onKeyDown={e => activate(e, () => onTogglePair(pair.key))}
                onMouseEnter={() => onHoverRun(latest)}
                data-testid="explorer-pair-row"
              >
                <td>
                  <span className={styles.caret}>
                    <UiIcon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                  </span>
                  <When ts={pair.runs[0].timestamp} ctx={ctx} />
                </td>
                <td className={styles.pair}>
                  {nodeLabel(ctx.nodes, pair.fromNodeNum)}
                  <UiIcon name="forward" size={12} className={styles.pairArrow} />
                  {nodeLabel(ctx.nodes, pair.toNodeNum)}
                </td>
                <td>
                  {latest?.forward ? (
                    <PathChips seq={latest.forward} snr={latest.forwardSnr} nodes={ctx.nodes} />
                  ) : (
                    <span className={styles.muted}>{t('analysis.traceroute_explorer.never_answered', 'Never answered')}</span>
                  )}
                  {pair.distinctPaths > 1 && (
                    <div>
                      <span className={`${styles.tag} ${styles.tagFlag}`}>
                        {t('analysis.traceroute_explorer.paths_seen', '{{count}} paths seen', { count: pair.distinctPaths })}
                      </span>
                    </div>
                  )}
                </td>
                <td className={styles.num}>
                  {t('analysis.traceroute_explorer.run_count', '{{count}} runs', { count: pair.runs.length })}
                  <span className={styles.spark} aria-hidden="true">
                    {pair.runs
                      .slice(0, SPARK_RUNS)
                      .reverse()
                      .map(r => (
                        <i key={r.key} className={r.answered ? styles.sparkOk : styles.sparkFail} />
                      ))}
                  </span>
                </td>
                <td className={styles.num}>{pair.medianHops ?? '—'}</td>
                <td className={`${styles.num} ${rateClass}`}>
                  {t('analysis.traceroute_explorer.answer_pct', '{{pct}}% answered', { pct })}
                </td>
                <td className={styles.muted}>{sourceList(pair.sourceIds, ctx)}</td>
              </tr>
              {open && pair.runs.map(run => runRow(run, true))}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
};

export default ExplorerTable;
