/**
 * CoverageCrossSourceSummary — "N fixes from source A heard by B" rows for
 * the Coverage Report (#5560). Presentational: rows come from
 * `summarizeCrossSourceCoverage` over the loaded receptions. Renders nothing
 * when there are no cross-source rows, so single-source installs (and
 * viewers who can read only one source) never see the section.
 *
 * Styles are shared with the summary panel (CoverageSummaryPanel.module.css
 * is the trio's shared sheet, COVERAGE_P4_SPEC.md §2a.6).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from '../../utils/telemetryFormat';
import { formatCoverageNodeId } from '../../utils/coverage';
import { receiverKey } from '../../utils/coverageReceiverFilter';
import { crossSourceTransportLabel } from '../../utils/crossSourceLabels';
import type { CoverageCrossSourceRow } from '../../utils/coverageCrossSource';
import styles from './CoverageSummaryPanel.module.css';

export interface CoverageCrossSourceSummaryProps {
  rows: CoverageCrossSourceRow[];
  /** sourceId -> source name. */
  sourceNames: Map<string, string>;
  /** receiverKey(sourceId, receiverId) -> receiver name. */
  receiverNames: Map<string, string>;
  /** The report window, for the "over T" part. */
  sinceMs: number;
  untilMs: number;
}

export const CoverageCrossSourceSummary: React.FC<CoverageCrossSourceSummaryProps> = ({
  rows,
  sourceNames,
  receiverNames,
  sinceMs,
  untilMs,
}) => {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const span = formatDuration(Math.max(0, (untilMs - sinceMs) / 1000));

  return (
    <section className={styles.panel} data-testid="coverage-cross-source-summary">
      <h3 className={styles.title}>{t('analysis.coverage.cross_source_title', 'Heard between your sources')}</h3>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('analysis.coverage.cross_source_col_summary', 'Summary')}</th>
              <th>{t('analysis.coverage.cross_source_col_via', 'Via')}</th>
              <th>{t('analysis.coverage.col_median_snr', 'Median SNR')}</th>
              <th>{t('analysis.coverage.cross_source_col_best_snr', 'Best SNR')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const sender = sourceNames.get(row.senderSourceId) ?? row.senderSourceId;
              const source = sourceNames.get(row.sourceId) ?? row.sourceId;
              const receiver =
                receiverNames.get(receiverKey(row.sourceId, row.receiverId)) ?? formatCoverageNodeId(row.receiverId);
              return (
                <tr key={row.key}>
                  <td>
                    {row.receiverKind === 'mqtt_gateway'
                      ? t(
                          'analysis.coverage.cross_source_row_gateway',
                          '{{count}} fixes from {{sender}} heard by gateway {{receiver}} ({{source}}) over {{span}}',
                          { count: row.fixes, sender, receiver, source, span },
                        )
                      : t(
                          'analysis.coverage.cross_source_row',
                          '{{count}} fixes from {{sender}} heard by {{source}} over {{span}}',
                          { count: row.fixes, sender, source, span },
                        )}
                  </td>
                  <td>{crossSourceTransportLabel(t, row.transport)}</td>
                  <td>{row.medianSnr == null ? '—' : `${row.medianSnr.toFixed(1)} dB`}</td>
                  <td>{row.bestSnr == null ? '—' : `${row.bestSnr.toFixed(1)} dB`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default CoverageCrossSourceSummary;
