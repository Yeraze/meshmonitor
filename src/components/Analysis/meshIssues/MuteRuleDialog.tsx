/**
 * MuteRuleDialog — confirms muting one rule (#4964 report reorganization,
 * WP5, spec §6.4). On open, fetches an UNFILTERED `/summary` (the true open,
 * non-dismissed total for the type — not the current view's filtered count)
 * and shows the auto-close wording computed from the status thresholds
 * already in hand. Confirm writes both settings keys via
 * `buildRuleMuteSettingsPatch` (the §5.2 trap: writing the CSV key alone
 * cannot un-mute B7 while the legacy `mesh_issues_b7_enabled` key still says
 * 'false' — every write of the mute set goes through that helper) and awaits
 * a fresh `/status` before closing, so a rapid second mute never races a
 * stale `disabledRules` list (the read-modify-write hazard spec §6.4 calls
 * out — the confirm button stays disabled for the same reason while the
 * mutation is pending).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../../services/api';
import { ISSUE_TYPE_LABELS, type MeshIssuesSummary } from '../meshIssueTypes';
import { buildRuleMuteSettingsPatch, ruleShortId } from '../meshIssueRuleIds';
import { DEFAULT_MESH_ISSUES_FILTERS } from './grouping';
import { fetchSummary, STATUS_KEY, summaryKey } from './meshIssuesApi';
import styles from './meshIssues.module.css';

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

interface MuteRuleDialogProps {
  issueType: string;
  /** Current mute set — `status.thresholds.disabledRules`. */
  disabledRules: string[];
  autoCloseCleanRuns: number;
  frequencyHours: number;
  onClose: () => void;
  /** Bubbles a 401/403 up to the shell's forbidden-hiding, same as every
   *  other mutating control in this report. */
  onForbidden?: () => void;
}

const MuteRuleDialog: React.FC<MuteRuleDialogProps> = ({
  issueType,
  disabledRules,
  autoCloseCleanRuns,
  frequencyHours,
  onClose,
  onForbidden,
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // Unfiltered — spec §6.4: "reads byType[type].total so the count is the
  // true open, non-dismissed total, not the filtered view's." Shares the
  // SUMMARY_BASE_KEY prefix so `invalidateSummary()` still covers it.
  const summaryQuery = useQuery<MeshIssuesSummary>({
    queryKey: summaryKey(DEFAULT_MESH_ISSUES_FILTERS),
    queryFn: () => fetchSummary(DEFAULT_MESH_ISSUES_FILTERS),
    retry: false,
  });

  const muteMutation = useMutation<void, unknown, void>({
    mutationFn: async () => {
      const patch = buildRuleMuteSettingsPatch([...disabledRules, issueType]);
      await apiService.post('/api/settings', patch);
    },
    onSuccess: async () => {
      // Awaited so a fresh `disabledRules` is in the cache before the dialog
      // can be opened again for another rule (spec §6.4 hazard note).
      await qc.invalidateQueries({ queryKey: STATUS_KEY });
      onClose();
    },
    onError: (err) => {
      if (isForbidden(err)) onForbidden?.();
    },
  });

  const openCount = summaryQuery.data?.byType.find((s) => s.issueType === issueType)?.total ?? 0;
  const label = `${ruleShortId(issueType)} ${ISSUE_TYPE_LABELS[issueType] ?? issueType}`;
  const days = Math.round((autoCloseCleanRuns * frequencyHours) / 24);
  const title = t('analysis.mesh_issues.mute.title', 'Mute {{label}}?', { label });

  return (
    <div className={styles.confirmOverlay} onClick={onClose}>
      <div
        className={styles.confirmDialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="mute-rule-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className={styles.confirmTitle}>{title}</h4>

        {summaryQuery.isLoading ? (
          <p className={styles.confirmBody}>
            {t('analysis.mesh_issues.mute.loading', 'Loading open finding count…')}
          </p>
        ) : (
          <p className={styles.confirmBody}>
            {t(
              'analysis.mesh_issues.mute.body',
              'New findings will stop being detected. The {{count}} open findings will auto-close after {{runs}} analysis runs (about {{days}} days at the current schedule).',
              { count: openCount, runs: autoCloseCleanRuns, days },
            )}
          </p>
        )}

        {muteMutation.isError && !isForbidden(muteMutation.error) && (
          <p className={`${styles.confirmBody} ${styles.menuItemDanger}`}>
            {t('analysis.mesh_issues.mute.error', 'Failed to mute this rule. Try again.')}
          </p>
        )}

        <div className={styles.confirmActions}>
          <button
            type="button"
            className="reports-btn reports-btn--ghost"
            onClick={onClose}
            disabled={muteMutation.isPending}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            data-testid="mute-confirm-go"
            className="reports-btn"
            disabled={muteMutation.isPending}
            onClick={() => muteMutation.mutate()}
          >
            {muteMutation.isPending
              ? t('analysis.mesh_issues.mute.muting', 'Muting…')
              : t('analysis.mesh_issues.mute.confirm', 'Mute rule')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MuteRuleDialog;
