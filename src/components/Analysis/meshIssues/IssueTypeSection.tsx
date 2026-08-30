/**
 * IssueTypeSection — one collapsible By-issue-view section: header (label,
 * count/severity breakdown, run chips) plus its own on-demand query, which
 * fires only on first expand (#4964 report reorganization, WP4, spec §6.2).
 * The whole group is fetched in one request (`limit=2000`) via
 * `meshIssuesApi.ts`'s `fetchIssuesForType` and sorted client-side by
 * `IssueTable` — expanding the biggest section never issues a second
 * request just to re-sort it.
 */
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { UiIcon } from '../../icons';
import {
  ISSUE_TYPE_LABELS,
  SEVERITY_ORDER,
  ruleShortId,
  type MeshIssueTypeSummary,
  type MeshIssuesFilters,
  type MeshIssuesResponse,
} from '../meshIssueTypes';
import { fetchIssuesForType, typeIssuesKey } from './meshIssuesApi';
import type { MeshIssuesSortState } from './useMeshIssuesViewState';
import { SEVERITY_ICON, SEVERITY_LABEL } from './severityUi';
import IssueTable from './IssueTable';
import styles from './IssueTypeSection.module.css';

interface IssueTypeSectionProps {
  typeSummary: MeshIssueTypeSummary;
  filters: MeshIssuesFilters;
  sourceNames: Record<string, string>;
  expanded: boolean;
  onToggleExpand: () => void;
  sort?: MeshIssuesSortState;
  onSortChange: (sort: MeshIssuesSortState) => void;
  lastRunTime: number | null;
  /** From `status.lastRunResult.newByType`/`.reopenedByType` (spec §4.6) —
   *  absent or zero hides the chip. */
  newCount?: number;
  reopenedCount?: number;
  canAct: boolean;
  onDismiss: (id: number) => void;
  onRestore: (id: number) => void;
  dismissPendingId: number | null;
  restorePendingId: number | null;
}

const IssueTypeSection: React.FC<IssueTypeSectionProps> = ({
  typeSummary,
  filters,
  sourceNames,
  expanded,
  onToggleExpand,
  sort,
  onSortChange,
  lastRunTime,
  newCount,
  reopenedCount,
  canAct,
  onDismiss,
  onRestore,
  dismissPendingId,
  restorePendingId,
}) => {
  const { t } = useTranslation();
  const { issueType, total, bySeverity, worstSeverity } = typeSummary;

  const query = useQuery<MeshIssuesResponse>({
    queryKey: typeIssuesKey(issueType, filters),
    queryFn: () => fetchIssuesForType(issueType, filters),
    enabled: expanded,
    retry: false,
  });

  const breakdown = SEVERITY_ORDER.filter((s) => bySeverity[s] > 0)
    .map((s) => `${bySeverity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
    .join(', ');

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>
        <button type="button" className={styles.toggle} onClick={onToggleExpand} aria-expanded={expanded}>
          <UiIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
          <UiIcon name={SEVERITY_ICON[worstSeverity]} size={14} className={styles[`sectionIcon--${worstSeverity}`]} />
          {ruleShortId(issueType)} {ISSUE_TYPE_LABELS[issueType] ?? issueType}
          <span className={styles.breakdown}>
            — {total} · {breakdown}
          </span>
          {typeof newCount === 'number' && newCount > 0 && (
            <span className={styles.runChip}>
              {t('analysis.mesh_issues.section.new', '{{count}} new', { count: newCount })}
            </span>
          )}
          {typeof reopenedCount === 'number' && reopenedCount > 0 && (
            <span className={styles.runChip}>
              {t('analysis.mesh_issues.section.reopened', '{{count}} reopened', { count: reopenedCount })}
            </span>
          )}
        </button>
      </h3>

      {expanded && (
        <>
          {query.isLoading && (
            <div className="reports-banner">{t('analysis.mesh_issues.section.loading', 'Loading findings…')}</div>
          )}
          {query.error && (
            <div className="reports-banner reports-banner--error">
              {query.error instanceof Error
                ? query.error.message
                : t('analysis.mesh_issues.section.error', 'Error loading findings')}
            </div>
          )}
          {query.data && (
            <IssueTable
              issueType={issueType}
              rows={query.data.issues}
              sourceNames={sourceNames}
              sort={sort}
              onSortChange={onSortChange}
              lastRunTime={lastRunTime}
              canAct={canAct}
              onDismiss={onDismiss}
              onRestore={onRestore}
              dismissPendingId={dismissPendingId}
              restorePendingId={restorePendingId}
            />
          )}
        </>
      )}
    </section>
  );
};

export default IssueTypeSection;
