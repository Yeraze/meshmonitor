/**
 * MeshIssuesReport — Mesh Issues Analysis findings report (#4964 Phase 1
 * WP5, widened Phase 3 WP4, reorganized WP4 of the report-reorg follow-on —
 * see docs/internal/dev-notes/MESH_ISSUES_REORG_SPEC.md).
 *
 * Thin shell: view state (`useMeshIssuesViewState`), the `/summary` +
 * `/status` queries, the run-now/dismiss/restore mutations, and the header
 * chrome (title, run-now button, coverage preface). Findings themselves are
 * fetched on demand, per section, by `IssueTypeSection` — this component
 * issues exactly `/summary` + `/status` on first load and never fetches a
 * single finding row itself (spec §11 WP4 acceptance).
 *
 * Backend contract (frozen by WP1 — MESH_ISSUES_REORG_SPEC.md §4):
 *  - GET  /api/analysis/mesh-issues                 -> { success, data: MeshIssuesResponse }
 *  - GET  /api/analysis/mesh-issues/summary          -> { success, data: MeshIssuesSummary }
 *  - GET  /api/analysis/mesh-issues/status           -> { success, data: MeshIssuesStatus }
 *  - POST /api/analysis/mesh-issues/run-now          -> { success, data: MeshIssuesRunNowResult }
 *  - POST /api/analysis/mesh-issues/:id/dismiss      -> { success }
 *  - POST /api/analysis/mesh-issues/:id/restore      -> { success }
 *  - POST /api/analysis/mesh-issues/bulk/dismiss     -> { success, data: MeshIssuesBulkResult } (WP5, spec §4.4)
 *  - POST /api/analysis/mesh-issues/bulk/restore     -> { success, data: MeshIssuesBulkResult } (WP5, spec §4.4)
 *  - POST /api/settings (mesh_issues_disabled_rules + mesh_issues_b7_enabled) — mute, via `MuteRuleDialog` (WP5, spec §6.4)
 * `ApiService.request()` returns the raw envelope and does NOT unwrap `data`
 * (CLAUDE.md gotcha) — every fetcher in `meshIssues/meshIssuesApi.ts` reads
 * `body.data` explicitly.
 *
 * The "Run analysis now" button, and dismiss/restore, are shown only once
 * the status call has succeeded (a 401/403 there means the caller cannot
 * even read findings) and hide themselves permanently if a mutating call
 * later comes back 401/403 — `settings:write` is a narrower grant than the
 * read permission that gates the list/status/summary endpoints. The same
 * `actionsForbidden` flag also gates the WP5 bulk-action and mute-rule
 * controls (`BulkActionMenu`, `MuteRuleDialog`) — one forbidden-hiding flag
 * for every `settings:write`-gated mutation this report makes.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../services/api';
import { UiIcon } from '../icons';
import type {
  MeshIssueBulkScope,
  MeshIssuesBulkResult,
  MeshIssuesFilters,
  MeshIssuesRunNowResult,
  MeshIssuesStatus,
  MeshIssuesSummary,
} from './meshIssueTypes';
import { CoveragePreface } from './meshIssues/CoveragePreface';
import { useMeshIssuesViewState } from './meshIssues/useMeshIssuesViewState';
import SummaryTiles from './meshIssues/SummaryTiles';
import FilterBar from './meshIssues/FilterBar';
import ByIssueView from './meshIssues/ByIssueView';
import ByNodeView from './meshIssues/ByNodeView';
import {
  ISSUES_BASE_KEY,
  STATUS_KEY,
  SUMMARY_BASE_KEY,
  fetchStatus,
  fetchSummary,
  postBulkDismiss,
  postBulkRestore,
  postDismiss,
  postRestore,
  postRunNow,
  summaryKey,
} from './meshIssues/meshIssuesApi';
import styles from './meshIssues/meshIssues.module.css';

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

const MeshIssuesReport: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [viewState, setViewState] = useMeshIssuesViewState();
  const [runNowForbidden, setRunNowForbidden] = useState(false);
  const [actionsForbidden, setActionsForbidden] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const { filters } = viewState;

  const summaryQuery = useQuery<MeshIssuesSummary>({
    queryKey: summaryKey(filters),
    queryFn: () => fetchSummary(filters),
    retry: false,
  });

  const statusQuery = useQuery<MeshIssuesStatus>({
    queryKey: STATUS_KEY,
    queryFn: fetchStatus,
    retry: false,
  });

  const invalidateIssues = useCallback(() => {
    // Partial key match — invalidates every per-type/per-node variant.
    void qc.invalidateQueries({ queryKey: [ISSUES_BASE_KEY] });
  }, [qc]);
  const invalidateSummary = useCallback(() => {
    void qc.invalidateQueries({ queryKey: [SUMMARY_BASE_KEY] });
  }, [qc]);

  const runNowMutation = useMutation<MeshIssuesRunNowResult, unknown, void>({
    mutationFn: postRunNow,
    onSuccess: () => {
      setRunError(null);
      invalidateIssues();
      invalidateSummary();
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      if (isForbidden(err)) setRunNowForbidden(true);
      setRunError(
        err instanceof Error ? err.message : t('analysis.mesh_issues.run_failed', 'Failed to run analysis'),
      );
    },
  });

  const dismissMutation = useMutation<void, unknown, number>({
    mutationFn: postDismiss,
    onSuccess: () => {
      invalidateIssues();
      invalidateSummary();
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      if (isForbidden(err)) setActionsForbidden(true);
    },
  });

  const restoreMutation = useMutation<void, unknown, number>({
    mutationFn: postRestore,
    onSuccess: () => {
      invalidateIssues();
      invalidateSummary();
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      if (isForbidden(err)) setActionsForbidden(true);
    },
  });

  /** Bulk dismiss/restore (WP5, spec §4.4/§6.4/§7.4) — one shared mutation
   *  pair reused by every `IssueTypeSection`/`NodeGroupSection`'s
   *  `BulkActionMenu`, keyed by the declarative `MeshIssueBulkScope` each
   *  caller passes in. Refreshes tiles + sections + status on success, per
   *  the WP5 acceptance bullet. */
  const bulkDismissMutation = useMutation<MeshIssuesBulkResult, unknown, MeshIssueBulkScope>({
    mutationFn: postBulkDismiss,
    onSuccess: () => {
      invalidateIssues();
      invalidateSummary();
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      if (isForbidden(err)) setActionsForbidden(true);
    },
  });

  const bulkRestoreMutation = useMutation<MeshIssuesBulkResult, unknown, MeshIssueBulkScope>({
    mutationFn: postBulkRestore,
    onSuccess: () => {
      invalidateIssues();
      invalidateSummary();
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      if (isForbidden(err)) setActionsForbidden(true);
    },
  });

  const canRunNow = statusQuery.isSuccess && !runNowForbidden;
  const canAct = statusQuery.isSuccess && !actionsForbidden;
  const running = runNowMutation.isPending || statusQuery.data?.inProgress === true;

  const handleRunNow = useCallback(() => runNowMutation.mutate(), [runNowMutation]);
  const handleDismiss = useCallback((id: number) => dismissMutation.mutate(id), [dismissMutation]);
  const handleRestore = useCallback((id: number) => restoreMutation.mutate(id), [restoreMutation]);
  const handleBulkDismiss = useCallback(
    (scope: MeshIssueBulkScope) => bulkDismissMutation.mutate(scope),
    [bulkDismissMutation],
  );
  const handleBulkRestore = useCallback(
    (scope: MeshIssueBulkScope) => bulkRestoreMutation.mutate(scope),
    [bulkRestoreMutation],
  );
  /** Passed to `MuteRuleDialog` (self-contained mutation) so a 401/403 there
   *  hides the report's mutating controls the same as every other mutation. */
  const handleForbidden = useCallback(() => setActionsForbidden(true), []);
  const bulkPending = bulkDismissMutation.isPending || bulkRestoreMutation.isPending;

  const handleFiltersChange = useCallback(
    (next: MeshIssuesFilters) => setViewState((vs) => ({ ...vs, filters: next })),
    [setViewState],
  );

  /** Tile click (spec §6.1): sets `filters.issueTypes` to just this type
   *  (or clears it for the active tile / the "All" tile), switches to the
   *  By-issue view, and force-expands the matching section regardless of
   *  its current collapsed state. */
  const handleTileSelect = useCallback(
    (issueType: string | null) => {
      setViewState((vs) => ({
        ...vs,
        view: 'byIssue',
        filters: { ...vs.filters, issueTypes: issueType ? [issueType] : [] },
        expandedTypes:
          issueType && !vs.expandedTypes.includes(issueType) ? [...vs.expandedTypes, issueType] : vs.expandedTypes,
      }));
    },
    [setViewState],
  );

  const summary = summaryQuery.data ?? null;
  const total = summary?.total ?? 0;
  const lastRunResult = statusQuery.data?.lastRunResult ?? null;
  const lastRunTime = statusQuery.data?.lastRunTime ?? null;
  // Mute (WP5, spec §6.4) — the current mute set + the values MuteRuleDialog
  // needs for its auto-close copy. Fallbacks match the server's own defaults
  // (`DEFAULT_MESH_ISSUE_THRESHOLDS`, `thresholds.ts`) for the brief window
  // before `/status` resolves.
  const disabledRules = statusQuery.data?.thresholds.disabledRules ?? [];
  const autoCloseCleanRuns = statusQuery.data?.thresholds.autoCloseCleanRuns ?? 3;
  const frequencyHours = statusQuery.data?.frequencyHours ?? 24;

  return (
    <>
      <div>
        <h2 className="reports-section__title">
          <UiIcon name="alert" size={22} />
          {t('analysis.mesh_issues.title', 'Mesh Issues')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.mesh_issues.description',
            'Flag wrongly-roled or poorly placed routers, airtime abusers, and infrastructure nodes on failing power — from passively collected data only.',
          )}
        </p>
      </div>

      <div className="reports-panel">
        <div className="reports-controls">
          {canRunNow && (
            <button type="button" className="reports-btn" onClick={handleRunNow} disabled={running}>
              <UiIcon name="play" size={16} />
              {running ? t('analysis.mesh_issues.running', 'Running…') : t('analysis.mesh_issues.run_now', 'Run analysis now')}
            </button>
          )}
          {statusQuery.data?.lastRunTime != null && (
            <span className={styles.lastRun}>
              {t('analysis.mesh_issues.last_run', 'Last run:')} {new Date(statusQuery.data.lastRunTime).toLocaleString()}
              {statusQuery.data.lastRunResultFromStorage && (
                <span className={styles.fromStorageNote}>
                  {' '}
                  {t('analysis.mesh_issues.from_storage', '(from the last completed run before restart)')}
                </span>
              )}
            </span>
          )}
        </div>
        {runError && <div className={`reports-banner reports-banner--error ${styles.runErrorBanner}`}>{runError}</div>}
        <CoveragePreface result={lastRunResult} />
      </div>

      {summaryQuery.isLoading && (
        <div className="reports-banner">{t('analysis.mesh_issues.loading', 'Loading mesh issues…')}</div>
      )}

      {summaryQuery.error && (
        <div className="reports-banner reports-banner--error">
          {summaryQuery.error instanceof Error
            ? summaryQuery.error.message
            : t('analysis.mesh_issues.error', 'Error loading mesh issues')}
        </div>
      )}

      {summary && !summaryQuery.error && (
        <>
          <SummaryTiles
            byType={summary.byType}
            total={total}
            activeIssueTypes={filters.issueTypes}
            newByType={lastRunResult?.newByType}
            reopenedByType={lastRunResult?.reopenedByType}
            disabledRules={disabledRules}
            onSelect={handleTileSelect}
          />

          <FilterBar filters={filters} sourceNames={summary.sourceNames} onChange={handleFiltersChange} />

          {total === 0 ? (
            <div className="reports-banner reports-banner--empty">
              {t('analysis.mesh_issues.empty', 'No mesh issues detected.')}
            </div>
          ) : (
            <>
              <div className={styles.viewSwitch}>
                <button
                  type="button"
                  className={`reports-btn reports-btn--ghost ${viewState.view === 'byIssue' ? styles.viewToggleActive : ''}`}
                  aria-pressed={viewState.view === 'byIssue'}
                  onClick={() => setViewState((vs) => ({ ...vs, view: 'byIssue' }))}
                >
                  <UiIcon name="list" size={14} />
                  {t('analysis.mesh_issues.view.by_issue', 'By issue')}
                </button>
                <button
                  type="button"
                  className={`reports-btn reports-btn--ghost ${viewState.view === 'byNode' ? styles.viewToggleActive : ''}`}
                  aria-pressed={viewState.view === 'byNode'}
                  onClick={() => setViewState((vs) => ({ ...vs, view: 'byNode' }))}
                >
                  <UiIcon name="nodes" size={14} />
                  {t('analysis.mesh_issues.view.by_node', 'By node')}
                </button>
              </div>

              {viewState.view === 'byIssue' ? (
                <ByIssueView
                  summary={summary}
                  filters={filters}
                  viewState={viewState}
                  setViewState={setViewState}
                  sourceNames={summary.sourceNames}
                  lastRunTime={lastRunTime}
                  newByType={lastRunResult?.newByType}
                  reopenedByType={lastRunResult?.reopenedByType}
                  canAct={canAct}
                  onDismiss={handleDismiss}
                  onRestore={handleRestore}
                  dismissPendingId={dismissMutation.isPending ? (dismissMutation.variables ?? null) : null}
                  restorePendingId={restoreMutation.isPending ? (restoreMutation.variables ?? null) : null}
                  disabledRules={disabledRules}
                  autoCloseCleanRuns={autoCloseCleanRuns}
                  frequencyHours={frequencyHours}
                  onBulkDismiss={handleBulkDismiss}
                  onBulkRestore={handleBulkRestore}
                  bulkPending={bulkPending}
                  onForbidden={handleForbidden}
                />
              ) : (
                <ByNodeView
                  summary={summary}
                  filters={filters}
                  viewState={viewState}
                  setViewState={setViewState}
                  sourceNames={summary.sourceNames}
                  lastRunTime={lastRunTime}
                  canAct={canAct}
                  onDismiss={handleDismiss}
                  onRestore={handleRestore}
                  dismissPendingId={dismissMutation.isPending ? (dismissMutation.variables ?? null) : null}
                  restorePendingId={restoreMutation.isPending ? (restoreMutation.variables ?? null) : null}
                  onBulkDismiss={handleBulkDismiss}
                  onBulkRestore={handleBulkRestore}
                  bulkPending={bulkPending}
                />
              )}
            </>
          )}
        </>
      )}
    </>
  );
};

export default MeshIssuesReport;
