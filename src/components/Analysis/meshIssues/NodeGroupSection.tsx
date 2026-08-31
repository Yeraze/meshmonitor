/**
 * NodeGroupSection — one collapsible By-node-view row: header (node name,
 * total, severity badge, a badge row of its distinct issue types) plus its
 * own on-demand query, firing only on first expand — the same idiom as
 * `IssueTypeSection` (#4964 report reorganization, WP5, spec §6.3).
 * `nodeNum === null` renders the pinned Mesh-wide pseudo-group. Expanding
 * fetches `GET /?nodeNum=<n>` (`fetchIssuesForNode`) and renders each
 * finding as a compact row reusing `FindingDetail` for the body — no full
 * `IssueTable`, since a node's findings can span several issue types and
 * `IssueTable`'s columns are type-specific (spec §6.5/§8).
 *
 * The node-scope bulk-restore count has no dedicated summary field the way
 * `MeshIssueTypeSummary.dismissed` does (`MeshIssueNodeSummary` carries no
 * `dismissed` count) — it is derived from this section's own fetched rows
 * once expanded, so "Restore all N dismissed" only becomes actionable after
 * the user has expanded the node and can see there is something to restore.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import {
  ISSUE_TYPE_LABELS,
  hexNodeId,
  ruleShortId,
  type MeshIssueBulkScope,
  type MeshIssueNodeSummary,
  type MeshIssuesFilters,
  type MeshIssuesResponse,
} from '../meshIssueTypes';
import { fetchIssuesForNode, nodeIssuesKey } from './meshIssuesApi';
import { renderSubject } from './IssueTable';
import FindingDetail from './FindingDetail';
import BulkActionMenu from './BulkActionMenu';
import { SEVERITY_LABEL } from './severityUi';
import sharedStyles from './meshIssues.module.css';
import styles from './NodeGroupSection.module.css';

interface NodeGroupSectionProps {
  nodeSummary: MeshIssueNodeSummary;
  filters: MeshIssuesFilters;
  sourceNames: Record<string, string>;
  expanded: boolean;
  onToggleExpand: () => void;
  lastRunTime: number | null;
  canAct: boolean;
  onDismiss: (id: number) => void;
  onRestore: (id: number) => void;
  dismissPendingId: number | null;
  restorePendingId: number | null;
  onBulkDismiss: (scope: MeshIssueBulkScope) => void;
  onBulkRestore: (scope: MeshIssueBulkScope) => void;
  bulkPending: boolean;
}

const NodeGroupSection: React.FC<NodeGroupSectionProps> = ({
  nodeSummary,
  filters,
  sourceNames,
  expanded,
  onToggleExpand,
  lastRunTime,
  canAct,
  onDismiss,
  onRestore,
  dismissPendingId,
  restorePendingId,
  onBulkDismiss,
  onBulkRestore,
  bulkPending,
}) => {
  const { t } = useTranslation();
  const { nodeNum, nodeName, total, worstSeverity, issueTypes } = nodeSummary;
  const isMeshWide = nodeNum === null;

  const query = useQuery<MeshIssuesResponse>({
    queryKey: nodeIssuesKey(nodeNum, filters),
    queryFn: () => fetchIssuesForNode(nodeNum, filters),
    enabled: expanded,
    retry: false,
  });

  const label =
    nodeNum === null ? t('analysis.mesh_issues.by_node.mesh_wide', 'Mesh-wide') : (nodeName ?? hexNodeId(nodeNum));
  const dismissedCount = query.data ? query.data.issues.filter((i) => i.dismissed).length : 0;

  return (
    <div className="reports-node">
      <div className={styles.header}>
        <button type="button" className={styles.toggle} onClick={onToggleExpand} aria-expanded={expanded}>
          <UiIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
          <span className={styles.name}>{label}</span>
          {isMeshWide && (
            <span className={styles.meshWideTag}>
              {t('analysis.mesh_issues.by_node.mesh_wide_hint', 'findings not tied to a single node')}
            </span>
          )}
          <span className={`${sharedStyles.badge} ${sharedStyles[`badge--${worstSeverity}`]}`}>
            {SEVERITY_LABEL[worstSeverity]}
          </span>
          <span className={styles.meta}>
            {t('analysis.mesh_issues.by_node.total', '{{count}} finding(s)', { count: total })}
          </span>
          <span className={styles.typeBadges}>
            {issueTypes.map((type) => (
              <span key={type} className={styles.typeBadge} title={ISSUE_TYPE_LABELS[type] ?? type}>
                {ruleShortId(type)}
              </span>
            ))}
          </span>
        </button>

        <BulkActionMenu
          canAct={canAct}
          subjectLabel={label}
          openCount={total}
          dismissedCount={dismissedCount}
          onDismissAll={() => onBulkDismiss({ scope: 'node', nodeNum })}
          onRestoreAll={() => onBulkRestore({ scope: 'node', nodeNum })}
          bulkPending={bulkPending}
        />
      </div>

      {expanded && (
        <div className={styles.body}>
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
          {query.data?.issues.map((issue) => {
            const isNew = lastRunTime != null && issue.firstDetected >= lastRunTime;
            return (
              <div key={issue.id} className={styles.findingRow}>
                <div className={styles.findingRowHeader}>
                  <span className={`${sharedStyles.badge} ${sharedStyles[`badge--${issue.severity}`]}`}>
                    {SEVERITY_LABEL[issue.severity]}
                  </span>
                  <span className={styles.findingRowTitle}>
                    {ruleShortId(issue.issueType)} {ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType}
                  </span>
                  <span className={styles.findingRowMeta}>{renderSubject(issue)}</span>
                  {isNew && (
                    <span className={`${sharedStyles.badge} ${sharedStyles['badge--new']}`}>
                      {t('analysis.mesh_issues.table.new', 'New')}
                    </span>
                  )}
                  {issue.dismissed && (
                    <span className={`${sharedStyles.badge} ${sharedStyles.dismissedBadge}`}>
                      {t('analysis.mesh_issues.dismissed_badge', 'Dismissed')}
                    </span>
                  )}
                  {canAct && (
                    <span className={styles.findingRowActions}>
                      {issue.dismissed ? (
                        <button
                          type="button"
                          className={`reports-btn reports-btn--ghost ${sharedStyles.iconButton}`}
                          onClick={() => onRestore(issue.id)}
                          disabled={restorePendingId === issue.id}
                          aria-label={t('analysis.mesh_issues.restore', 'Restore')}
                          title={t('analysis.mesh_issues.restore', 'Restore')}
                        >
                          <UiIcon name="refresh" size={14} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`reports-btn reports-btn--ghost ${sharedStyles.iconButton}`}
                          onClick={() => onDismiss(issue.id)}
                          disabled={dismissPendingId === issue.id}
                          aria-label={t('analysis.mesh_issues.dismiss', 'Dismiss')}
                          title={t('analysis.mesh_issues.dismiss', 'Dismiss')}
                        >
                          <UiIcon name="close" size={14} />
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <div className={styles.findingRowBody}>
                  <FindingDetail issue={issue} sourceNames={sourceNames} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default NodeGroupSection;
