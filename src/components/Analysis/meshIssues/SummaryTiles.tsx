/**
 * SummaryTiles — the per-issue-type dashboard grid at the top of the report
 * (#4964 report reorganization, WP4, spec §6.1). One tile per
 * `summary.byType` entry plus a leading "All" tile. Clicking a tile sets
 * `filters.issueTypes = [issueType]` (clicking the active tile clears it);
 * the shell reacts by narrowing the By-issue view to that type and
 * auto-expanding its section.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import { ISSUE_TYPE_LABELS, SEVERITY_ORDER, ruleShortId, type MeshIssueTypeSummary } from '../meshIssueTypes';
import { SEVERITY_ICON, SEVERITY_LABEL } from './severityUi';
import styles from './SummaryTiles.module.css';

interface SummaryTilesProps {
  byType: MeshIssueTypeSummary[];
  /** `summary.total` (== `summary.counts.total`) — the "All" tile's count. */
  total: number;
  /** `filters.issueTypes` — drives `aria-pressed` on the matching tile. */
  activeIssueTypes: string[];
  /** `lastRunResult?.newByType` / `.reopenedByType` (spec §4.6) — absent or
   *  zero hides the chip rather than showing a stale/zero count. */
  newByType?: Record<string, number>;
  reopenedByType?: Record<string, number>;
  /** `null` == the "All" tile (clear the issueType filter). */
  onSelect: (issueType: string | null) => void;
}

const SummaryTiles: React.FC<SummaryTilesProps> = ({
  byType,
  total,
  activeIssueTypes,
  newByType,
  reopenedByType,
  onSelect,
}) => {
  const { t } = useTranslation();
  const isAllActive = activeIssueTypes.length === 0;

  return (
    <div className={styles.grid}>
      <button type="button" className={styles.tile} aria-pressed={isAllActive} onClick={() => onSelect(null)}>
        <div className={styles.tileHeader}>{t('analysis.mesh_issues.tiles.all', 'All')}</div>
        <div className={styles.tileTotal}>{total}</div>
      </button>

      {byType.map((type) => {
        const isActive = activeIssueTypes.length === 1 && activeIssueTypes[0] === type.issueType;
        const breakdown = SEVERITY_ORDER.filter((s) => type.bySeverity[s] > 0)
          .map((s) => `${type.bySeverity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
          .join(', ');
        const newCount = newByType?.[type.issueType] ?? 0;
        const reopenedCount = reopenedByType?.[type.issueType] ?? 0;

        return (
          <button
            key={type.issueType}
            type="button"
            className={`${styles.tile} ${styles[`tile--${type.worstSeverity}`]}`}
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? null : type.issueType)}
          >
            <div className={styles.tileHeader}>
              <UiIcon name={SEVERITY_ICON[type.worstSeverity]} size={14} />
              {ruleShortId(type.issueType)} {ISSUE_TYPE_LABELS[type.issueType] ?? type.issueType}
            </div>
            <div className={styles.tileTotal}>{type.total}</div>
            <div className={styles.tileBreakdown}>{breakdown}</div>
            {(newCount > 0 || reopenedCount > 0) && (
              <div className={styles.tileChips}>
                {newCount > 0 && (
                  <span className={styles.tileChip}>
                    {t('analysis.mesh_issues.tiles.new', '{{count}} new this run', { count: newCount })}
                  </span>
                )}
                {reopenedCount > 0 && (
                  <span className={styles.tileChip}>
                    {t('analysis.mesh_issues.tiles.reopened', '{{count}} reopened', { count: reopenedCount })}
                  </span>
                )}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default SummaryTiles;
