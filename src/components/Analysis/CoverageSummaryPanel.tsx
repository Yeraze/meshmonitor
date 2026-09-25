/**
 * CoverageSummaryPanel — Coverage Report summary tiles + per-receiver table
 * (#5277 Phase 4a WP3, spec §2a.6).
 *
 * Pure presentational component: every number it shows is already computed
 * by WP1's `summarizeCoverage` / `detectCoverageGaps` (`src/utils/coverageSummary.ts`,
 * `coverageGaps.ts`) and handed down as props. This component does no
 * aggregation of its own beyond building a receiverKey -> name/source lookup
 * for the table (§2a.3's `CoverageReceiverStat` carries ids, not names).
 *
 * Gap/expected-fix tiles only render when `gapResult` is non-null — the
 * caller (`CoverageReport`, WP4) only computes gaps with exactly one sender
 * selected (spec §2a.2 "When shown"). With "All" senders, `gapResult` is
 * `null` and this panel shows the pick-a-sender hint instead, while the
 * sender-independent tiles (best/worst SNR/RSSI, receptions) still render.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDistance } from '../../utils/distance';
import { formatCoverageNodeId } from '../../utils/coverage';
import { receiverKey } from '../../utils/coverageReceiverFilter';
import type { CoverageSummary, CoverageGapResult, IntervalSource } from '../../types/coverageAnalysis';
import type { CoverageReceiverDto } from '../../types/coverage';
import type { DistanceUnit } from '../../contexts/SettingsContext';
import styles from './CoverageSummaryPanel.module.css';

export interface CoverageSummaryPanelProps {
  summary: CoverageSummary;
  gapResult: CoverageGapResult | null;
  receivers: CoverageReceiverDto[];
  distanceUnit: DistanceUnit;
  truncated: boolean;
}

const INTERVAL_SOURCE_KEY: Record<IntervalSource, [string, string]> = {
  configured: ['analysis.coverage.summary_interval_configured', 'configured'],
  observed: ['analysis.coverage.summary_interval_observed', 'observed'],
  default: ['analysis.coverage.summary_interval_default', 'default'],
};

function formatSnr(value: number | null): string {
  return value == null ? '—' : `${value.toFixed(1)} dB`;
}

function formatRssi(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)} dBm`;
}

export const CoverageSummaryPanel: React.FC<CoverageSummaryPanelProps> = ({
  summary,
  gapResult,
  receivers,
  distanceUnit,
  truncated,
}) => {
  const { t } = useTranslation();

  const receiverInfoByKey = useMemo(() => {
    const map = new Map<string, CoverageReceiverDto>();
    for (const r of receivers) map.set(receiverKey(r.sourceId, r.receiverId), r);
    return map;
  }, [receivers]);

  const percent =
    gapResult && gapResult.expected > 0 ? Math.round((gapResult.heard / gapResult.expected) * 100) : 0;

  return (
    <div className={styles.panel} data-testid="coverage-summary-panel">
      <h3 className={styles.title}>{t('analysis.coverage.summary_title', 'Summary')}</h3>

      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('analysis.coverage.summary_fixes_heard', 'Fixes heard')}</span>
          <span className={styles.tileValue}>
            {gapResult
              ? t(
                  'analysis.coverage.summary_heard_of_expected',
                  '{{heard}} of {{expected}} expected ({{percent}}%)',
                  { heard: gapResult.heard, expected: gapResult.expected, percent },
                )
              : summary.fixesHeard}
          </span>
          {gapResult && (
            <span className={styles.tileCaption}>
              {t('analysis.coverage.summary_interval', 'Interval {{seconds}} s ({{source}})', {
                seconds: Math.round(gapResult.intervalSec),
                source: t(...INTERVAL_SOURCE_KEY[gapResult.intervalSource]),
              })}
            </span>
          )}
        </div>

        {gapResult && (
          <div className={styles.tile}>
            <span className={styles.tileLabel}>{t('analysis.coverage.summary_gaps', 'Likely gaps')}</span>
            <span className={styles.tileValue}>{gapResult.gaps.length}</span>
          </div>
        )}

        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('analysis.coverage.summary_best_snr', 'Best SNR')}</span>
          <span className={styles.tileValue}>{formatSnr(summary.bestSnr)}</span>
        </div>

        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('analysis.coverage.summary_worst_snr', 'Worst SNR')}</span>
          <span className={styles.tileValue}>{formatSnr(summary.worstSnr)}</span>
        </div>

        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('analysis.coverage.summary_best_rssi', 'Best RSSI')}</span>
          <span className={styles.tileValue}>{formatRssi(summary.bestRssi)}</span>
        </div>

        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('analysis.coverage.summary_worst_rssi', 'Worst RSSI')}</span>
          <span className={styles.tileValue}>{formatRssi(summary.worstRssi)}</span>
        </div>

        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('analysis.coverage.summary_receptions', 'Receptions')}</span>
          <span className={styles.tileValue}>{summary.receptions}</span>
        </div>
      </div>

      {!gapResult && (
        <p className={styles.note}>
          {t('analysis.coverage.summary_pick_sender', 'Pick one sender to see gaps and expected fixes.')}
        </p>
      )}

      {truncated && (
        <p className={styles.note}>
          {t(
            'analysis.coverage.truncated',
            'Showing the first {{count}} receptions in this window — narrow the time range or pick a sender to see the rest.',
            { count: summary.receptions },
          )}
        </p>
      )}

      {summary.receivers.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.title} style={{ captionSide: 'top', textAlign: 'left' }}>
              {t('analysis.coverage.receivers_table_title', 'Receivers')}
            </caption>
            <thead>
              <tr>
                <th>{t('analysis.coverage.col_receiver', 'Receiver')}</th>
                <th>{t('analysis.coverage.col_source', 'Source')}</th>
                <th>{t('analysis.coverage.col_kind', 'Kind')}</th>
                <th>{t('analysis.coverage.col_fixes_heard', 'Fixes heard')}</th>
                <th>{t('analysis.coverage.col_median_snr', 'Median SNR')}</th>
                <th>{t('analysis.coverage.col_furthest_direct', 'Furthest direct')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.receivers.map((stat) => {
                const info = receiverInfoByKey.get(stat.key);
                const name = info?.longName || info?.shortName || formatCoverageNodeId(stat.receiverId);
                const sourceName = info?.sourceName ?? stat.sourceId;
                const isGateway = stat.receiverKind === 'mqtt_gateway';
                const isObserver = isGateway && info?.protocol === 'meshcore';
                const kindLabel = isObserver
                  ? t('analysis.coverage.kind_observer', 'Observer')
                  : isGateway
                    ? t('analysis.coverage.kind_gateway', 'Gateway')
                    : t('analysis.coverage.kind_local', 'Local');
                const furthest =
                  stat.furthestDirectM == null ? '—' : formatDistance(stat.furthestDirectM / 1000, distanceUnit);
                return (
                  <tr key={stat.key}>
                    <td>{name}</td>
                    <td>{sourceName}</td>
                    <td>{kindLabel}</td>
                    <td>{stat.fixesHeard}</td>
                    <td>{formatSnr(stat.medianSnr)}</td>
                    <td>{furthest}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default CoverageSummaryPanel;
