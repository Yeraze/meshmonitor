/**
 * MeshIssuesReport — Mesh Issues Analysis findings report (#4964 Phase 1 WP5).
 *
 * Renders passively-detected findings (deprecated roles, chatty nodes,
 * congested areas, infrastructure nodes on failing power, mobile infra
 * nodes, cosplay routers) grouped by severity. Zero mesh impact: this
 * component only reads already-computed findings and never sends packets.
 *
 * Backend contract (Phase 1, #4964, frozen in MESH_ISSUES_P1_SPEC.md §2.16):
 *  - GET  /api/analysis/mesh-issues         -> { success, data: MeshIssuesResponse }
 *  - GET  /api/analysis/mesh-issues/status  -> { success, data: MeshIssuesStatus }
 *  - POST /api/analysis/mesh-issues/run-now -> { success, data: MeshIssuesRunNowResult }
 * `ApiService.request()` returns the raw envelope and does NOT unwrap `data`
 * (CLAUDE.md gotcha) — every call here reads `body.data` explicitly.
 *
 * The "Run analysis now" button is shown only once the status call has
 * succeeded (a 401/403 there means the caller cannot even read findings, so
 * it certainly cannot trigger a run) and hides itself permanently if a
 * run-now attempt later comes back 401/403 — `settings:write` is a narrower
 * grant than the read permission that gates the list/status endpoints, so
 * the two can disagree.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { UiIcon, type UiIconName } from '../icons';
import {
  ISSUE_TYPE_BLURBS,
  ISSUE_TYPE_LABELS,
  SEVERITY_ORDER,
  formatEvidenceKey,
  formatEvidenceValue,
  type MeshIssueConfidence,
  type MeshIssueRow,
  type MeshIssueSeverity,
  type MeshIssuesResponse,
  type MeshIssuesRunNowResult,
  type MeshIssuesStatus,
} from './meshIssueTypes';
import styles from './MeshIssuesReport.module.css';

const ISSUES_KEY = ['mesh-issues'] as const;
const STATUS_KEY = ['mesh-issues-status'] as const;

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

async function fetchIssues(): Promise<MeshIssuesResponse> {
  const body = await apiService.get<{ success: boolean; data: MeshIssuesResponse }>(
    '/api/analysis/mesh-issues',
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

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

const MeshIssuesReport: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [runNowForbidden, setRunNowForbidden] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<MeshIssuesResponse>({
    queryKey: ISSUES_KEY,
    queryFn: fetchIssues,
    retry: false,
  });

  const statusQuery = useQuery<MeshIssuesStatus>({
    queryKey: STATUS_KEY,
    queryFn: fetchStatus,
    retry: false,
  });

  const runNowMutation = useMutation<MeshIssuesRunNowResult, unknown, void>({
    mutationFn: postRunNow,
    onSuccess: () => {
      setRunError(null);
      void qc.invalidateQueries({ queryKey: ISSUES_KEY });
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

  const canRunNow = statusQuery.isSuccess && !runNowForbidden;

  const groups = useMemo(() => {
    if (!data) return [];
    return SEVERITY_ORDER.map((severity) => ({
      severity,
      issues: data.issues
        .filter((issue) => issue.severity === severity)
        .sort((a, b) => b.lastDetected - a.lastDetected),
    })).filter((g) => g.issues.length > 0);
  }, [data]);

  const handleRunNow = useCallback(() => {
    runNowMutation.mutate();
  }, [runNowMutation]);

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
          {statusQuery.data?.lastRunTime != null && (
            <span className={styles.lastRun}>
              {t('analysis.mesh_issues.last_run', 'Last run:')}{' '}
              {new Date(statusQuery.data.lastRunTime).toLocaleString()}
            </span>
          )}
        </div>
        {runError && (
          <div className={`reports-banner reports-banner--error ${styles.runErrorBanner}`}>
            {runError}
          </div>
        )}
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

      {data && !error && data.issues.length === 0 && (
        <div className="reports-banner reports-banner--empty">
          {t('analysis.mesh_issues.empty', 'No mesh issues detected.')}
        </div>
      )}

      {data && !error && groups.length > 0 && (
        <div className="reports-node-list">
          {groups.map(({ severity, issues }) => (
            <section key={severity} className={styles.severityGroup}>
              <h3 className={styles.severityHeading}>
                <UiIcon
                  name={SEVERITY_ICON[severity]}
                  size={16}
                  className={styles[`severityHeadingIcon--${severity}`]}
                />
                {SEVERITY_LABEL[severity]} ({issues.length})
              </h3>
              <div className="reports-node-list">
                {issues.map((issue) => (
                  <FindingCard key={issue.id} issue={issue} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
};

const FindingCard: React.FC<{ issue: MeshIssueRow }> = ({ issue }) => {
  const title = ISSUE_TYPE_LABELS[issue.issueType] ?? issue.issueType;
  const blurb = ISSUE_TYPE_BLURBS[issue.issueType];
  const subtitle = issue.nodeName ?? issue.subjectKey;
  const recommendation =
    typeof issue.evidence.recommendation === 'string' ? issue.evidence.recommendation : null;
  const fieldEntries = Object.entries(issue.evidence).filter(([key]) => key !== 'recommendation');

  return (
    <div className="reports-node">
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
          </div>
          <div className="reports-node__meta">
            {subtitle}
            {blurb ? ` — ${blurb}` : ''}
          </div>
        </div>
      </div>

      <div className="reports-node__body">
        {recommendation && (
          <p className={styles.recommendation}>
            <UiIcon name="sparkles" size={14} className={styles.recommendationIcon} />
            {recommendation}
          </p>
        )}

        {fieldEntries.length > 0 && (
          <div className="reports-node__fields">
            {fieldEntries.map(([key, value]) => (
              <Field key={key} label={formatEvidenceKey(key)} value={formatEvidenceValue(value)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="reports-node__field-label">{label}</div>
    <div className="reports-node__field-value">{value}</div>
  </div>
);

export default MeshIssuesReport;
