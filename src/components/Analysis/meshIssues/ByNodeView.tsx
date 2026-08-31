/**
 * ByNodeView — renders one `NodeGroupSection` per `summary.byNode` entry,
 * ranked worst-first with the Mesh-wide pseudo-group pinned first (#4964
 * report reorganization, WP5, spec §6.3). Owns per-node expand state, read
 * from and written back to the `useMeshIssuesViewState` hook the shell owns
 * — same pattern as `ByIssueView`'s per-type expand state.
 *
 * No dedicated CSS module: this component is pure composition over
 * `NodeGroupSection` plus the shared `reports-node-list` layout class
 * (`src/styles/analysis-reports.css`) — there is no styling of its own.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshIssueBulkScope, MeshIssuesFilters, MeshIssuesSummary } from '../meshIssueTypes';
import type { MeshIssuesViewState } from './useMeshIssuesViewState';
import { rankNodeSummaries } from './grouping';
import NodeGroupSection from './NodeGroupSection';

interface ByNodeViewProps {
  summary: MeshIssuesSummary;
  filters: MeshIssuesFilters;
  viewState: MeshIssuesViewState;
  setViewState: React.Dispatch<React.SetStateAction<MeshIssuesViewState>>;
  sourceNames: Record<string, string>;
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

const ByNodeView: React.FC<ByNodeViewProps> = ({
  summary,
  filters,
  viewState,
  setViewState,
  sourceNames,
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
  const rankedNodes = useMemo(() => rankNodeSummaries(summary.byNode), [summary.byNode]);

  const toggleNode = (key: number | 'mesh-wide') => {
    setViewState((vs) => ({
      ...vs,
      expandedNodes: vs.expandedNodes.includes(key)
        ? vs.expandedNodes.filter((n) => n !== key)
        : [...vs.expandedNodes, key],
    }));
  };

  if (rankedNodes.length === 0) {
    return (
      <div className="reports-banner reports-banner--empty">
        {t('analysis.mesh_issues.by_node.no_match', 'No nodes match the active filters.')}
      </div>
    );
  }

  return (
    <div className="reports-node-list">
      {rankedNodes.map((nodeSummary) => {
        const key = nodeSummary.nodeNum ?? 'mesh-wide';
        return (
          <NodeGroupSection
            key={key}
            nodeSummary={nodeSummary}
            filters={filters}
            sourceNames={sourceNames}
            expanded={viewState.expandedNodes.includes(key)}
            onToggleExpand={() => toggleNode(key)}
            lastRunTime={lastRunTime}
            canAct={canAct}
            onDismiss={onDismiss}
            onRestore={onRestore}
            dismissPendingId={dismissPendingId}
            restorePendingId={restorePendingId}
            onBulkDismiss={onBulkDismiss}
            onBulkRestore={onBulkRestore}
            bulkPending={bulkPending}
          />
        );
      })}
    </div>
  );
};

export default ByNodeView;
