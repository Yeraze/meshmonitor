/**
 * ByIssueView — renders one `IssueTypeSection` per `summary.byType` entry
 * (#4964 report reorganization, WP4, spec §6.2). Owns:
 *  - narrowing to a single type when a dashboard tile is active
 *    (`filters.issueTypes`, spec §6.1's "clicking a tile filters below"),
 *  - the one-time "collapsed by default unless the type carries a critical
 *    finding" seed (spec §6.2) — done via a ref-tracked one-shot per type so
 *    a user's subsequent collapse of that section is never fought,
 *  - per-type expand/sort state, read from and written back to the
 *    `useMeshIssuesViewState` hook the shell owns.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshIssuesFilters, MeshIssuesSummary } from '../meshIssueTypes';
import type { MeshIssuesSortState, MeshIssuesViewState } from './useMeshIssuesViewState';
import IssueTypeSection from './IssueTypeSection';

interface ByIssueViewProps {
  summary: MeshIssuesSummary;
  filters: MeshIssuesFilters;
  viewState: MeshIssuesViewState;
  setViewState: React.Dispatch<React.SetStateAction<MeshIssuesViewState>>;
  sourceNames: Record<string, string>;
  lastRunTime: number | null;
  newByType?: Record<string, number>;
  reopenedByType?: Record<string, number>;
  canAct: boolean;
  onDismiss: (id: number) => void;
  onRestore: (id: number) => void;
  dismissPendingId: number | null;
  restorePendingId: number | null;
}

const ByIssueView: React.FC<ByIssueViewProps> = ({
  summary,
  filters,
  viewState,
  setViewState,
  sourceNames,
  lastRunTime,
  newByType,
  reopenedByType,
  canAct,
  onDismiss,
  onRestore,
  dismissPendingId,
  restorePendingId,
}) => {
  const { t } = useTranslation();
  // Types this component has already applied the critical-default seed to —
  // NOT persisted, and deliberately not read inside the effect below (only
  // written), so the effect's dependency array stays exhaustive without
  // fighting a user's subsequent manual collapse of a seeded section.
  const seededRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const toSeed = summary.byType
      .filter((t2) => t2.bySeverity.critical > 0 && !seededRef.current.has(t2.issueType))
      .map((t2) => t2.issueType);
    if (toSeed.length === 0) return;
    for (const type of toSeed) seededRef.current.add(type);
    setViewState((vs) => ({ ...vs, expandedTypes: [...new Set([...vs.expandedTypes, ...toSeed])] }));
  }, [summary, setViewState]);

  const visibleTypes =
    filters.issueTypes.length > 0
      ? summary.byType.filter((t2) => filters.issueTypes.includes(t2.issueType))
      : summary.byType;

  const toggleType = (type: string) => {
    setViewState((vs) => ({
      ...vs,
      expandedTypes: vs.expandedTypes.includes(type)
        ? vs.expandedTypes.filter((t2) => t2 !== type)
        : [...vs.expandedTypes, type],
    }));
  };

  const setSortForType = (type: string, sort: MeshIssuesSortState) => {
    setViewState((vs) => ({ ...vs, sortByType: { ...vs.sortByType, [type]: sort } }));
  };

  if (visibleTypes.length === 0) {
    return (
      <div className="reports-banner reports-banner--empty">
        {t('analysis.mesh_issues.by_issue.no_match', 'No mesh issue types match the active filters.')}
      </div>
    );
  }

  return (
    <div className="reports-node-list">
      {visibleTypes.map((typeSummary) => (
        <IssueTypeSection
          key={typeSummary.issueType}
          typeSummary={typeSummary}
          filters={filters}
          sourceNames={sourceNames}
          expanded={viewState.expandedTypes.includes(typeSummary.issueType)}
          onToggleExpand={() => toggleType(typeSummary.issueType)}
          sort={viewState.sortByType[typeSummary.issueType]}
          onSortChange={(sort) => setSortForType(typeSummary.issueType, sort)}
          lastRunTime={lastRunTime}
          newCount={newByType?.[typeSummary.issueType]}
          reopenedCount={reopenedByType?.[typeSummary.issueType]}
          canAct={canAct}
          onDismiss={onDismiss}
          onRestore={onRestore}
          dismissPendingId={dismissPendingId}
          restorePendingId={restorePendingId}
        />
      ))}
    </div>
  );
};

export default ByIssueView;
