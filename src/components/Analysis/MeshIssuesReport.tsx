/**
 * MeshIssuesReport — Mesh Issues Analysis findings report (#4964 Phase 1 WP5,
 * widened in Phase 3 WP4).
 *
 * Renders passively-detected findings (deprecated roles, chatty nodes,
 * congested areas, infrastructure nodes on failing power, mobile infra
 * nodes, cosplay routers, RF-adjacency issues, node-flag/cadence issues)
 * grouped by severity. Zero mesh impact: this component only reads
 * already-computed findings and never sends packets.
 *
 * Backend contract (frozen in MESH_ISSUES_P1_SPEC.md §2.16, widened by
 * MESH_ISSUES_P3_SPEC.md §4):
 *  - GET  /api/analysis/mesh-issues                 -> { success, data: MeshIssuesResponse }
 *  - GET  /api/analysis/mesh-issues/status           -> { success, data: MeshIssuesStatus }
 *  - POST /api/analysis/mesh-issues/run-now          -> { success, data: MeshIssuesRunNowResult }
 *  - POST /api/analysis/mesh-issues/:id/dismiss      -> { success }
 *  - POST /api/analysis/mesh-issues/:id/restore      -> { success }
 * `ApiService.request()` returns the raw envelope and does NOT unwrap `data`
 * (CLAUDE.md gotcha) — every call here reads `body.data` explicitly.
 *
 * The "Run analysis now" button, and the per-card dismiss/restore buttons,
 * are shown only once the status call has succeeded (a 401/403 there means
 * the caller cannot even read findings, so it certainly cannot mutate them)
 * and hide themselves permanently if a mutating call later comes back
 * 401/403 — `settings:write` is a narrower grant than the read permission
 * that gates the list/status endpoints, so the two can disagree.
 */
import { useCallback, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { UiIcon, type UiIconName } from '../icons';
import {
  ISSUE_TYPE_BLURBS,
  ISSUE_TYPE_LABELS,
  SEVERITY_ORDER,
  formatSourceIds,
  type MeshIssueConfidence,
  type MeshIssueRow,
  type MeshIssueSeverity,
  type MeshIssuesResponse,
  type MeshIssuesRunNowResult,
  type MeshIssuesStatus,
} from './meshIssueTypes';
import { CoveragePreface } from './meshIssues/CoveragePreface';
import FindingDetail from './meshIssues/FindingDetail';
import styles from './meshIssues/meshIssues.module.css';

const ISSUES_BASE_KEY = 'mesh-issues';
const STATUS_KEY = ['mesh-issues-status'] as const;

/** Cards rendered on first expand of the `info` severity group, and per
 * "show more" click (spec §5.6, P3-D5). */
const INFO_PAGE_SIZE = 25;

/**
 * Wire-level page size (#4964 post-epic follow-ups) — matches the server's
 * own default (`DEFAULT_PAGE_LIMIT` in `meshIssuesRoutes.ts`). Page 1 is
 * fetched eagerly; subsequent pages are fetched on "Load more" via
 * `fetchNextPage()`, driven entirely by the server's `total` — this
 * component never re-derives pagination math from `issues.length` alone.
 */
const PAGE_LIMIT = 500;

const SEVERITY_ICON: Record<MeshIssueSeverity, UiIconName> = {
  critical: 'error',
  warning: 'alert',
  info: 'info',
};

const SEVERITY_LABEL: Record<MeshIssueSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const CONFIDENCE_LABEL: Record<MeshIssueConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

function issuesKey(includeDismissed: boolean) {
  return [ISSUES_BASE_KEY, { includeDismissed }] as const;
}

async function fetchIssues(
  includeDismissed: boolean,
  offset: number,
  limit: number,
): Promise<MeshIssuesResponse> {
  const params = new URLSearchParams();
  if (includeDismissed) params.set('includeDismissed', 'true');
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const body = await apiService.get<{ success: boolean; data: MeshIssuesResponse }>(
    `/api/analysis/mesh-issues?${params.toString()}`,
  );
  return body.data;
}

async function fetchStatus(): Promise<MeshIssuesStatus> {
  const body = await apiService.get<{ success: boolean; data: MeshIssuesStatus }>(
    '/api/analysis/mesh-issues/status',
  );
  return body.data;
}

async function postRunNow(): Promise<MeshIssuesRunNowResult> {
  const body = await apiService.post<{ success: boolean; data: MeshIssuesRunNowResult }>(
    '/api/analysis/mesh-issues/run-now',
  );
  return body.data;
}

async function postDismiss(id: number): Promise<void> {
  await apiService.post(`/api/analysis/mesh-issues/${id}/dismiss`);
}

async function postRestore(id: number): Promise<void> {
  await apiService.post(`/api/analysis/mesh-issues/${id}/restore`);
}

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

const MeshIssuesReport: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [runNowForbidden, setRunNowForbidden] = useState(false);
  const [actionsForbidden, setActionsForbidden] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [includeDismissed, setIncludeDismissed] = useState(false);

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<MeshIssuesResponse>({
    queryKey: issuesKey(includeDismissed),
    queryFn: ({ pageParam }) => fetchIssues(includeDismissed, pageParam as number, PAGE_LIMIT),
    initialPageParam: 0,
    // Driven by the server's `total`, not by assuming a full page means more
    // remain — the last page can legitimately be a partial page.
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.issues.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    retry: false,
  });

  // `counts`, `sourceNames`, and `total` are computed server-side over the
  // FULL filtered set and are identical on every page — any page's copy is
  // authoritative, so the first page is used directly rather than merged.
  const issues = useMemo(() => data?.pages.flatMap((p) => p.issues) ?? [], [data]);
  const counts = data?.pages[0]?.counts ?? null;
  const sourceNames = data?.pages[0]?.sourceNames ?? {};
  const total = data?.pages[0]?.total ?? 0;
  const remaining = total - issues.length;

  const statusQuery = useQuery<MeshIssuesStatus>({
    queryKey: STATUS_KEY,
    queryFn: fetchStatus,
    retry: false,
  });

  const invalidateIssues = useCallback(() => {
    // Partial key match — invalidates every `includeDismissed` variant.
    void qc.invalidateQueries({ queryKey: [ISSUES_BASE_KEY] });
  }, [qc]);

  const runNowMutation = useMutation<MeshIssuesRunNowResult, unknown, void>({
    mutationFn: postRunNow,
    onSuccess: () => {
      setRunError(null);
      invalidateIssues();
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => {
      if (isForbidden(err)) {
        setRunNowForbidden(true);
      }
      setRunError(
        err instanceof Error
          ? err.message
          : t('analysis.mesh_issues.run_failed', 'Failed to run analysis'),
      );
    },
  });

  const dismissMutation = useMutation<void, unknown, number>({
    mutationFn: postDismiss,
    onSuccess: invalidateIssues,
    onError: (err) => {
      if (isForbidden(err)) setActionsForbidden(true);
    },
  });

  const restoreMutation = useMutation<void, unknown, number>({
    mutationFn: postRestore,
    onSuccess: invalidateIssues,
    onError: (err) => {
      if (isForbidden(err)) setActionsForbidden(true);
    },
  });

  const canRunNow = statusQuery.isSuccess && !runNowForbidden;
  const canAct = statusQuery.isSuccess && !actionsForbidden;

  const groups = useMemo(() => {
    if (!counts) return [];
    return SEVERITY_ORDER.map((severity) => ({
      severity,
      issues: issues
        .filter((issue) => issue.severity === severity)
        .sort((a, b) => b.lastDetected - a.lastDetected),
      // Full-set count for this severity (spec: group counts come from
      // `counts`, not the loaded slice, so a partially-loaded group's
      // heading can say so rather than understating how many exist).
      fullCount: counts[severity],
    })).filter((g) => g.fullCount > 0);
  }, [issues, counts]);

  const handleRunNow = useCallback(() => {
    runNowMutation.mutate();
  }, [runNowMutation]);

  const handleDismiss = useCallback((id: number) => dismissMutation.mutate(id), [dismissMutation]);
  const handleRestore = useCallback((id: number) => restoreMutation.mutate(id), [restoreMutation]);

  const running = runNowMutation.isPending || statusQuery.data?.inProgress === true;

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
            <button
              type="button"
              className="reports-btn"
              onClick={handleRunNow}
              disabled={running}
            >
              <UiIcon name="play" size={16} />
              {running
                ? t('analysis.mesh_issues.running', 'Running…')
                : t('analysis.mesh_issues.run_now', 'Run analysis now')}
            </button>
          )}
          <label className={styles.showDismissedToggle}>
            <input
              type="checkbox"
              checked={includeDismissed}
              onChange={(e) => setIncludeDismissed(e.target.checked)}
            />
            {t('analysis.mesh_issues.show_dismissed', 'Show dismissed')}
          </label>
          {statusQuery.data?.lastRunTime != null && (
            <span className={styles.lastRun}>
              {t('analysis.mesh_issues.last_run', 'Last run:')}{' '}
              {new Date(statusQuery.data.lastRunTime).toLocaleString()}
              {statusQuery.data.lastRunResultFromStorage && (
                <span className={styles.fromStorageNote}>
                  {' '}
                  {t(
                    'analysis.mesh_issues.from_storage',
                    '(from the last completed run before restart)',
                  )}
                </span>
              )}
            </span>
          )}
        </div>
        {runError && (
          <div className={`reports-banner reports-banner--error ${styles.runErrorBanner}`}>
            {runError}
          </div>
        )}
        <CoveragePreface result={statusQuery.data?.lastRunResult ?? null} />
      </div>

      {isLoading && (
        <div className="reports-banner">
          {t('analysis.mesh_issues.loading', 'Loading mesh issues…')}
        </div>
      )}

      {error && (
        <div className="reports-banner reports-banner--error">
          {error instanceof Error
            ? error.message
            : t('analysis.mesh_issues.error', 'Error loading mesh issues')}
        </div>
      )}

      {data && !error && total === 0 && (
        <div className="reports-banner reports-banner--empty">
          {t('analysis.mesh_issues.empty', 'No mesh issues detected.')}
        </div>
      )}

      {data && !error && groups.length > 0 && (
        <div className="reports-node-list">
          {groups.map(({ severity, issues: groupIssues, fullCount }) => (
            <SeverityGroupSection
              key={severity}
              severity={severity}
              issues={groupIssues}
              fullCount={fullCount}
              showDismissedCounts={includeDismissed}
              sourceNames={sourceNames}
              canAct={canAct}
              onDismiss={handleDismiss}
              onRestore={handleRestore}
              dismissPendingId={dismissMutation.isPending ? dismissMutation.variables : null}
              restorePendingId={restoreMutation.isPending ? restoreMutation.variables : null}
            />
          ))}
        </div>
      )}

      {data && !error && remaining > 0 && (
        <div className={styles.loadMoreRow}>
          <button
            type="button"
            className={`reports-btn reports-btn--ghost ${styles.loadMoreButton}`}
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage
              ? t('analysis.mesh_issues.loading_more', 'Loading…')
              : t('analysis.mesh_issues.load_more', 'Load more ({{remaining}} remaining)', { remaining })}
          </button>
        </div>
      )}
    </>
  );
};

interface SeverityGroupSectionProps {
  severity: MeshIssueSeverity;
  issues: MeshIssueRow[];
  /** Full-set count for this severity, from the server's `counts` (not the
   *  loaded slice). Equal to `issues.length` once every finding of this
   *  severity has been loaded via "Load more"; greater than it otherwise. */
  fullCount: number;
  showDismissedCounts: boolean;
  sourceNames: Record<string, string>;
  canAct: boolean;
  onDismiss: (id: number) => void;
  onRestore: (id: number) => void;
  dismissPendingId: number | null;
  restorePendingId: number | null;
}

/** One severity group. `info` renders collapsed by default with a per-type
 * tally and incremental "show more" rendering (spec §5.6, P3-D5); `critical`
 * and `warning` always render fully expanded. */
const SeverityGroupSection: React.FC<SeverityGroupSectionProps> = ({
  severity,
  issues,
  fullCount,
  showDismissedCounts,
  sourceNames,
  canAct,
  onDismiss,
  onRestore,
  dismissPendingId,
  restorePendingId,
}) => {
  const { t } = useTranslation();
  const isInfo = severity === 'info';
  const [expanded, setExpanded] = useState(!isInfo);
  const [visibleCount, setVisibleCount] = useState(INFO_PAGE_SIZE);

  const dismissedCount = useMemo(() => issues.filter((i) => i.dismissed).length, [issues]);

  const tally = useMemo(() => {
    if (!isInfo) return null;
    const counts = new Map<string, number>();
    for (const issue of issues) counts.set(issue.issueType, (counts.get(issue.issueType) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([type, count]) => `${ISSUE_TYPE_LABELS[type] ?? type} ${count}`)
      .join(', ');
  }, [issues, isInfo]);

  const visibleIssues = isInfo ? issues.slice(0, visibleCount) : issues;
  const remaining = issues.length - visibleIssues.length;

  // A group whose loaded count is short of the server-reported full count is
  // only PARTIALLY loaded (more pages remain, via the report-level "Load
  // more" control) — label it clearly rather than understating how many
  // findings of this severity actually exist (spec: #4964 post-epic
  // follow-ups).
  const countLabel =
    issues.length >= fullCount
      ? String(fullCount)
      : t('analysis.mesh_issues.count_partial', '{{loaded}} of {{total}} loaded', {
          loaded: issues.length,
          total: fullCount,
        });

  const headingText = `${SEVERITY_LABEL[severity]} (${countLabel}${
    showDismissedCounts && dismissedCount > 0
      ? t('analysis.mesh_issues.dismissed_suffix', ', {{count}} dismissed', { count: dismissedCount })
      : ''
  })`;

  const headingContent = (
    <>
      <UiIcon
        name={SEVERITY_ICON[severity]}
        size={16}
        className={styles[`severityHeadingIcon--${severity}`]}
      />
      {headingText}
    </>
  );

  return (
    <section className={styles.severityGroup}>
      <h3 className={styles.severityHeading}>
        {isInfo ? (
          <button
            type="button"
            className={styles.severityHeadingToggle}
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            <UiIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
            {headingContent}
          </button>
        ) : (
          headingContent
        )}
      </h3>
      {isInfo && tally && <div className={styles.infoTally}>{tally}</div>}
      {expanded && (
        <div className="reports-node-list">
          {visibleIssues.map((issue) => (
            <FindingCard
              key={issue.id}
              issue={issue}
              sourceNames={sourceNames}
              canAct={canAct}
              onDismiss={onDismiss}
              onRestore={onRestore}
              dismissPending={dismissPendingId === issue.id}
              restorePending={restorePendingId === issue.id}
            />
          ))}
          {isInfo && remaining > 0 && (
            <button
              type="button"
              className={`reports-btn reports-btn--ghost ${styles.showMoreButton}`}
              onClick={() => setVisibleCount((v) => v + INFO_PAGE_SIZE)}
            >
              {t('analysis.mesh_issues.show_more', 'Show {{page}} more ({{remaining}} remaining)', {
                page: Math.min(INFO_PAGE_SIZE, remaining),
                remaining,
              })}
            </button>
          )}
        </div>
      )}
    </section>
  );
};

interface FindingCardProps {
  issue: MeshIssueRow;
  sourceNames: Record<string, string>;
  canAct: boolean;
  onDismiss: (id: number) => void;
  onRestore: (id: number) => void;
  dismissPending: boolean;
  restorePending: boolean;
}

const FindingCard: React.FC<FindingCardProps> = ({
  issue,
  sourceNames,
  canAct,
  onDismiss,
  onRestore,
  dismissPending,
  restorePending,
}) => {
  const { t } = useTranslation();
  const title = ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType;
  const blurb = ISSUE_TYPE_BLURBS[issue.issueType];
  const subtitle = issue.nodeName ?? issue.subjectKey;

  return (
    <div className={`reports-node ${issue.dismissed ? styles.dismissedCard : ''}`}>
      <div className="reports-node__header">
        <div>
          <div className="reports-node__name">
            {title}
            <span className={`${styles.badge} ${styles[`badge--${issue.severity}`]}`}>
              {SEVERITY_LABEL[issue.severity]}
            </span>
            <span className={`${styles.badge} ${styles.confidenceBadge}`}>
              {CONFIDENCE_LABEL[issue.confidence]}
            </span>
            {issue.dismissed && (
              <span className={`${styles.badge} ${styles.dismissedBadge}`}>
                {t('analysis.mesh_issues.dismissed_badge', 'Dismissed')}
              </span>
            )}
          </div>
          <div className="reports-node__meta">
            {subtitle}
            {blurb ? ` — ${blurb}` : ''}
          </div>
          {issue.sourceIds.length > 0 && (
            <div className={styles.sourcesRow}>
              {t('analysis.mesh_issues.sources', 'Sources:')} {formatSourceIds(issue.sourceIds, sourceNames)}
            </div>
          )}
        </div>
        {canAct && (
          <div className={styles.cardActions}>
            {issue.dismissed ? (
              <button
                type="button"
                className={`reports-btn reports-btn--ghost ${styles.iconButton}`}
                onClick={() => onRestore(issue.id)}
                disabled={restorePending}
                aria-label={t('analysis.mesh_issues.restore', 'Restore')}
                title={t('analysis.mesh_issues.restore', 'Restore')}
              >
                <UiIcon name="refresh" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className={`reports-btn reports-btn--ghost ${styles.iconButton}`}
                onClick={() => onDismiss(issue.id)}
                disabled={dismissPending}
                aria-label={t('analysis.mesh_issues.dismiss', 'Dismiss')}
                title={t('analysis.mesh_issues.dismiss', 'Dismiss')}
              >
                <UiIcon name="close" size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <FindingDetail issue={issue} sourceNames={sourceNames} />
    </div>
  );
};

export default MeshIssuesReport;
