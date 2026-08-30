/**
 * CoveragePreface — moved verbatim out of MeshIssuesReport.tsx (#4964 report
 * reorganization, WP3, spec §7.1/§3.3). No behavioral change; only the import
 * paths and the `export` keyword changed.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { coverageNotes, type CoverageNote, type MeshIssuesLastRunResult } from '../meshIssueTypes';
import styles from './meshIssues.module.css';

/** Corpus funnel, evidence-class pills, and degradation notes rendered above
 * the severity groups (spec §5.1, C3). Renders nothing — not a broken shell
 * — when there is no last-run result to summarize (e.g. right after a fresh
 * install with a scheduler that hasn't completed a run yet). */
export const CoveragePreface: React.FC<{ result: MeshIssuesLastRunResult | null }> = ({ result }) => {
  const { t } = useTranslation();
  const notes = useMemo<CoverageNote[]>(
    () => (result ? coverageNotes(result.coverage) : []),
    [result],
  );

  if (!result) return null;

  const { corpusStats, coverage } = result;
  const funnel = [
    corpusStats.rawCount,
    corpusStats.validCount,
    corpusStats.dedupedCount,
    corpusStats.sampledCount,
  ]
    .map((n) => n.toLocaleString())
    .join(' -> ');

  const pills: Array<{ key: string; label: string; count: number; available: boolean }> = [
    {
      key: 'neighborInfo',
      label: t('analysis.mesh_issues.coverage.neighbor_info', 'NeighborInfo'),
      count: coverage.neighborInfoEdgeCount,
      available: coverage.evidence.neighborInfo,
    },
    {
      key: 'traceroute',
      label: t('analysis.mesh_issues.coverage.traceroutes', 'Traceroutes'),
      count: coverage.tracerouteEdgeCount,
      available: coverage.evidence.traceroute,
    },
    {
      key: 'mqttGateway',
      label: t('analysis.mesh_issues.coverage.mqtt_gateway', 'MQTT gateway'),
      count: coverage.gatewayDirectEdgeCount + coverage.gatewayCoReceptionEdgeCount,
      available: coverage.evidence.mqttGateway,
    },
    {
      key: 'packetLog',
      label: t('analysis.mesh_issues.coverage.packet_log', 'Packet log'),
      count: coverage.hopHorizonNodeCount,
      available: coverage.evidence.packetLog,
    },
  ];

  return (
    <div className={styles.coveragePreface}>
      <div className={styles.corpusFunnel}>
        {t('analysis.mesh_issues.coverage.funnel', '{{funnel}} sampled, {{pairs}} distinct pairs{{capped}}', {
          funnel,
          pairs: corpusStats.distinctPairCount.toLocaleString(),
          capped: corpusStats.truncated ? ` ${t('analysis.mesh_issues.coverage.capped', '(capped)')}` : '',
        })}
      </div>
      <div className={styles.evidencePills}>
        {pills.map((pill) => (
          <span
            key={pill.key}
            className={`${styles.evidencePill} ${
              pill.available ? styles.evidencePillAvailable : styles.evidencePillUnavailable
            }`}
          >
            {pill.label} ({pill.count.toLocaleString()})
          </span>
        ))}
      </div>
      {notes.length > 0 && (
        <ul className={styles.degradationNotes}>
          {notes.map((note, i) => (
            <li
              key={`${note.rule}-${i}`}
              className={`${styles.degradationNote} ${
                note.severity === 'blocked' ? styles.degradationNoteBlocked : styles.degradationNoteHint
              }`}
            >
              <strong>{note.rule}</strong>: {note.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
