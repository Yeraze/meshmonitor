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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { UiIcon, type UiIconName } from '../icons';
import {
  ISSUE_TYPE_BLURBS,
  ISSUE_TYPE_LABELS,
  SEVERITY_ORDER,
  STRUCTURED_EVIDENCE_KEYS,
  coverageNotes,
  formatDurationMs,
  formatEvidenceKey,
  formatEvidenceValue,
  formatSnrDirection,
  formatSourceIds,
  hexNodeId,
  isEvidenceDirectionalSnr,
  isEvidenceNodeRefArray,
  type CoverageNote,
  type EvidenceDirectionalSnr,
  type EvidenceNodeRef,
  type MeshIssueConfidence,
  type MeshIssueRow,
  type MeshIssueSeverity,
  type MeshIssuesLastRunResult,
  type MeshIssuesResponse,
  type MeshIssuesRunNowResult,
  type MeshIssuesStatus,
} from './meshIssueTypes';
import styles from './MeshIssuesReport.module.css';

const ISSUES_BASE_KEY = 'mesh-issues';
const STATUS_KEY = ['mesh-issues-status'] as const;

/** Cards rendered on first expand of the `info` severity group, and per
 * "show more" click (spec §5.6, P3-D5). */
const INFO_PAGE_SIZE = 25;

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

async function fetchIssues(includeDismissed: boolean): Promise<MeshIssuesResponse> {
  const qs = includeDismissed ? '?includeDismissed=true' : '';
  const body = await apiService.get<{ success: boolean; data: MeshIssuesResponse }>(
    `/api/analysis/mesh-issues${qs}`,
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

  const { data, isLoading, error } = useQuery<MeshIssuesResponse>({
    queryKey: issuesKey(includeDismissed),
    queryFn: () => fetchIssues(includeDismissed),
    retry: false,
  });

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

      {data && !error && data.issues.length === 0 && (
        <div className="reports-banner reports-banner--empty">
          {t('analysis.mesh_issues.empty', 'No mesh issues detected.')}
        </div>
      )}

      {data && !error && groups.length > 0 && (
        <div className="reports-node-list">
          {groups.map(({ severity, issues }) => (
            <SeverityGroupSection
              key={severity}
              severity={severity}
              issues={issues}
              showDismissedCounts={includeDismissed}
              sourceNames={data.sourceNames}
              canAct={canAct}
              onDismiss={handleDismiss}
              onRestore={handleRestore}
              dismissPendingId={dismissMutation.isPending ? dismissMutation.variables : null}
              restorePendingId={restoreMutation.isPending ? restoreMutation.variables : null}
            />
          ))}
        </div>
      )}
    </>
  );
};

/** Corpus funnel, evidence-class pills, and degradation notes rendered above
 * the severity groups (spec §5.1, C3). Renders nothing — not a broken shell
 * — when there is no last-run result to summarize (e.g. right after a fresh
 * install with a scheduler that hasn't completed a run yet). */
const CoveragePreface: React.FC<{ result: MeshIssuesLastRunResult | null }> = ({ result }) => {
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

/** Node-list evidence keys (§2.12/§2.13, WP5b) rendered as member chips via
 * `MemberList` rather than the generic pill grid. Some carry `EvidenceNodeRef`
 * objects (`members`, `otherCoveringRouters`); others carry plain nodeNums
 * (`sharedNeighbors`, `clusterMembers`) — `normalizeMemberList` handles both. */
const NODE_LIST_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  'members',
  'sharedNeighbors',
  'otherCoveringRouters',
  'clusterMembers',
]);

interface SeverityGroupSectionProps {
  severity: MeshIssueSeverity;
  issues: MeshIssueRow[];
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

  const headingText = `${SEVERITY_LABEL[severity]} (${issues.length}${
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

/** Evidence keys ending in this suffix hold an elapsed-milliseconds duration
 * (spec §5.3) and render through `formatDurationMs`. */
const AGE_MS_KEY_PATTERN = /AgeMs$/;

function formatFieldValue(key: string, value: unknown, sourceNames: Record<string, string>): string {
  if (key === 'sources') return formatSourceIds(value, sourceNames);
  if (AGE_MS_KEY_PATTERN.test(key) && typeof value === 'number') return formatDurationMs(value);
  return formatEvidenceValue(value);
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
  const recommendation =
    typeof issue.evidence.recommendation === 'string' ? issue.evidence.recommendation : null;

  const entries = Object.entries(issue.evidence).filter(([key]) => key !== 'recommendation');
  // `<field>Truncated`/`<field>Total` sibling flags are surfaced as the
  // "+ more" note inside the matching structured component, never as a raw
  // pill of their own.
  const plainEntries = entries.filter(
    ([key]) =>
      !STRUCTURED_EVIDENCE_KEYS.has(key) && !key.endsWith('Truncated') && !key.endsWith('Total'),
  );
  const structuredEntries = entries.filter(([key]) => STRUCTURED_EVIDENCE_KEYS.has(key));

  const showSnrDirections =
    isEvidenceDirectionalSnr(issue.evidence.snrToA) && isEvidenceDirectionalSnr(issue.evidence.snrToB);

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

      <div className="reports-node__body">
        {recommendation && (
          <p className={styles.recommendation}>
            <UiIcon name="sparkles" size={14} className={styles.recommendationIcon} />
            {recommendation}
          </p>
        )}

        {showSnrDirections && <SnrDirections issue={issue} />}

        {structuredEntries.map(([key, value]) => {
          // nodeA/nodeB/snrToA/snrToB/weakerDirection are consumed together
          // by SnrDirections above, not rendered as their own pills/lists.
          if (['nodeA', 'nodeB', 'snrToA', 'snrToB', 'weakerDirection'].includes(key)) return null;
          const truncated = issue.evidence[`${key}Truncated`] === true;
          const totalRaw = issue.evidence[`${key}Total`];
          const total = typeof totalRaw === 'number' ? totalRaw : undefined;
          if (key === 'edges') {
            return (
              <EdgeList key={key} label={formatEvidenceKey(key)} value={value} truncated={truncated} total={total} />
            );
          }
          if (NODE_LIST_EVIDENCE_KEYS.has(key)) {
            return (
              <MemberList
                key={key}
                label={formatEvidenceKey(key)}
                value={value}
                truncated={truncated}
                total={total}
              />
            );
          }
          return null;
        })}

        {plainEntries.length > 0 && (
          <div className="reports-node__fields">
            {plainEntries.map(([key, value]) => (
              <Field key={key} label={formatEvidenceKey(key)} value={formatFieldValue(key, value, sourceNames)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/** `{ nodeNum: number }` items, either plain numbers (`sharedNeighbors`,
 * `clusterMembers`) normalized to a bare node ref, or full `EvidenceNodeRef`
 * objects. Returns null for anything else so the caller can fall back to the
 * generic pill instead of throwing on malformed evidence. */
function normalizeMemberList(value: unknown): EvidenceNodeRef[] | null {
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return (value as number[]).map((nodeNum) => ({ nodeNum }));
  }
  if (isEvidenceNodeRefArray(value)) return value;
  return null;
}

/** `+{total - items.length} more not shown` when a pre-cap `total` is known
 * (spec §4.2); falls back to the pre-Phase-3 wording for a row persisted
 * before the `*Total` field existed. */
function truncationLabel(itemsShown: number, total: number | undefined): string {
  if (total != null) {
    const remainder = total - itemsShown;
    return `+${remainder} more not shown`;
  }
  return '+ more not shown (list truncated)';
}

const MemberList: React.FC<{ label: string; value: unknown; truncated: boolean; total?: number }> = ({
  label,
  value,
  truncated,
  total,
}) => {
  const items = normalizeMemberList(value);
  if (items === null) {
    return <Field label={label} value={formatEvidenceValue(value)} />;
  }
  return (
    <div>
      <div className="reports-node__field-label">{label}</div>
      <div className={styles.memberList}>
        {items.length === 0 && <span className="reports-node__field-value">—</span>}
        {items.map((item, i) => (
          <span key={`${item.nodeNum}-${i}`} className={styles.memberChip}>
            {item.name ?? hexNodeId(item.nodeNum)}
            {item.roleName && <span className={styles.memberChipRole}>{item.roleName}</span>}
          </span>
        ))}
      </div>
      {truncated && <div className={styles.truncationNote}>{truncationLabel(items.length, total)}</div>}
    </div>
  );
};

interface EvidenceEdgeRef {
  a: number;
  b: number;
  evidenceClasses?: unknown;
}

function isEvidenceEdgeRefArray(v: unknown): v is EvidenceEdgeRef[] {
  return (
    Array.isArray(v) &&
    v.every((item) => {
      if (item === null || typeof item !== 'object') return false;
      const o = item as Record<string, unknown>;
      return typeof o.a === 'number' && typeof o.b === 'number';
    })
  );
}

const EdgeList: React.FC<{ label: string; value: unknown; truncated: boolean; total?: number }> = ({
  label,
  value,
  truncated,
  total,
}) => {
  if (!isEvidenceEdgeRefArray(value)) {
    return <Field label={label} value={formatEvidenceValue(value)} />;
  }
  return (
    <div>
      <div className="reports-node__field-label">{label}</div>
      <div className={styles.memberList}>
        {value.length === 0 && <span className="reports-node__field-value">—</span>}
        {value.map((edge, i) => (
          <span key={`${edge.a}-${edge.b}-${i}`} className={styles.memberChip}>
            {hexNodeId(edge.a)} ↔ {hexNodeId(edge.b)}
            {Array.isArray(edge.evidenceClasses) && edge.evidenceClasses.length > 0 && (
              <span className={styles.memberChipRole}>{edge.evidenceClasses.join(', ')}</span>
            )}
          </span>
        ))}
      </div>
      {truncated && <div className={styles.truncationNote}>{truncationLabel(value.length, total)}</div>}
    </div>
  );
};

/** Reads `nodeA`/`nodeB`/`snrToA`/`snrToB`/`weakerDirection` off the issue's
 * evidence directly (rather than taking them as props) since the first four
 * must agree to render at all — see the `showSnrDirections` guard in
 * `FindingCard`. `weakerDirection` is optional; when absent or malformed the
 * table renders exactly as before (spec §5.5).
 *
 * DIRECTION CONVENTION (rfGraph.ts §2.5, load-bearing): `snrToA` is SNR
 * measured AT `a` (i.e. the b -> a direction); `snrToB` is measured AT `b`
 * (i.e. a -> b). So the "A -> B" row displays `snrToB` and the "B -> A" row
 * displays `snrToA`. */
const SnrDirections: React.FC<{ issue: MeshIssueRow }> = ({ issue }) => {
  const { t } = useTranslation();
  const nodeA = asNodeRef(issue.evidence.nodeA);
  const nodeB = asNodeRef(issue.evidence.nodeB);
  const snrToA = issue.evidence.snrToA as EvidenceDirectionalSnr;
  const snrToB = issue.evidence.snrToB as EvidenceDirectionalSnr;
  const nameA = nodeA ? (nodeA.name ?? hexNodeId(nodeA.nodeNum)) : '?';
  const nameB = nodeB ? (nodeB.name ?? hexNodeId(nodeB.nodeNum)) : '?';
  const weakerDirection = issue.evidence.weakerDirection;
  const weakerTag = () => (
    <span className={styles.weakerTag}> {t('analysis.mesh_issues.weaker', '(weaker)')}</span>
  );

  return (
    <div>
      <div className="reports-node__field-label">SNR by direction</div>
      <table className={styles.snrTable}>
        <tbody>
          <tr className={styles.snrRow}>
            {/* ASCII "->", not the unicode arrow glyph — no-hardcoded-ui-glyph
             * flags a leading unicode arrow, and the codebase's own directional
             * convention (RfEdge.weakerDirection: 'a->b' | 'b->a') already uses
             * ASCII here. */}
            <td className={styles.snrLabel}>
              {`${nameA} -> ${nameB}`}
              {weakerDirection === 'a->b' && weakerTag()}
            </td>
            <td className={styles.snrValue}>{formatSnrDirection(snrToB)}</td>
          </tr>
          <tr className={styles.snrRow}>
            <td className={styles.snrLabel}>
              {`${nameB} -> ${nameA}`}
              {weakerDirection === 'b->a' && weakerTag()}
            </td>
            <td className={styles.snrValue}>{formatSnrDirection(snrToA)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

function asNodeRef(v: unknown): EvidenceNodeRef | null {
  if (v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>).nodeNum === 'number') {
    return v as EvidenceNodeRef;
  }
  return null;
}

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="reports-node__field-label">{label}</div>
    <div className="reports-node__field-value">{value}</div>
  </div>
);

export default MeshIssuesReport;
