/**
 * BulkActionMenu — a small popover offering "Dismiss all N" / "Restore all N
 * dismissed" / (type scope only) "Mute this rule", rendered on each
 * By-issue-view type-section header and each By-node-view node row header
 * (#4964 report reorganization, WP5, spec §6.4). Hidden entirely when
 * `!canAct` — the same status-succeeded-and-no-prior-403 gate every other
 * mutating control in this report uses.
 *
 * Every destructive item (dismiss/restore) opens an inline confirm dialog
 * first, following the codebase's established accessible-dialog pattern
 * (`ConfirmJoinDialog` in `BeaconOffersPanel.tsx`): a `role="dialog"`
 * `aria-modal="true"` overlay, Cancel + a differently-worded confirm button.
 * Mute is a dedicated `MuteRuleDialog` (richer copy — an unfiltered open
 * count and the auto-close wording) rather than this generic confirm; this
 * component only knows how to open it via the `mute.onMute` callback.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../../icons';
import styles from './meshIssues.module.css';

export type BulkConfirmKind = 'dismiss' | 'restore';

export interface BulkActionMenuMuteProps {
  muted: boolean;
  onMute: () => void;
}

interface BulkActionMenuProps {
  /** Hidden entirely when false (no settings:write, or a prior 401/403 on a
   *  mutating call — the same `canAct` gate every other mutating control in
   *  this report uses). */
  canAct: boolean;
  /** Human label for confirm-dialog wording, e.g. "B7 Coverage shadow" or a
   *  node's display name / "Mesh-wide". */
  subjectLabel: string;
  /** Count of currently open (non-dismissed) findings this scope covers —
   *  drives "Dismiss all {{count}}"; the item is hidden entirely at 0. */
  openCount: number;
  /** Count of dismissed findings this scope covers — drives "Restore all
   *  {{count}} dismissed"; the item is hidden entirely at 0. */
  dismissedCount: number;
  onDismissAll: () => void;
  onRestoreAll: () => void;
  /** True while a bulk dismiss/restore mutation is in flight — disables the
   *  dismiss/restore items so a second bulk call cannot race the first. */
  bulkPending: boolean;
  /** Present only for a type-scope menu; omitted for node-scope menus (spec
   *  §6.4: "Mute this rule" is type-only — a node has no single rule). */
  mute?: BulkActionMenuMuteProps;
}

const BulkActionMenu: React.FC<BulkActionMenuProps> = ({
  canAct,
  subjectLabel,
  openCount,
  dismissedCount,
  onDismissAll,
  onRestoreAll,
  bulkPending,
  mute,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<BulkConfirmKind | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!canAct) return null;

  const hasDismiss = openCount > 0;
  const hasRestore = dismissedCount > 0;
  const hasMute = mute != null && !mute.muted;
  const nothingToDo = !hasDismiss && !hasRestore && !hasMute;

  return (
    <div className={styles.menuWrap} ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      {mute?.muted && (
        <span className={styles.mutedMarker}>
          <UiIcon name="muted" size={11} />
          {t('analysis.mesh_issues.bulk.muted_marker', 'Muted')}
        </span>
      )}

      {!nothingToDo && (
        <button
          type="button"
          className={`reports-btn reports-btn--ghost ${styles.menuTrigger}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('analysis.mesh_issues.bulk.menu_label', 'Bulk actions for {{subject}}', {
            subject: subjectLabel,
          })}
          onClick={() => setOpen((v) => !v)}
        >
          <UiIcon name="more" size={16} />
        </button>
      )}

      {open && (
        <div className={styles.menuPanel} role="menu">
          {hasDismiss && (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={bulkPending}
              onClick={() => {
                setOpen(false);
                setConfirmKind('dismiss');
              }}
            >
              <UiIcon name="close" size={14} />
              {t('analysis.mesh_issues.bulk.dismiss_all', 'Dismiss all {{count}}', { count: openCount })}
            </button>
          )}
          {hasRestore && (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={bulkPending}
              onClick={() => {
                setOpen(false);
                setConfirmKind('restore');
              }}
            >
              <UiIcon name="refresh" size={14} />
              {t('analysis.mesh_issues.bulk.restore_all', 'Restore all {{count}} dismissed', {
                count: dismissedCount,
              })}
            </button>
          )}
          {hasMute && mute && (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                mute.onMute();
              }}
            >
              <UiIcon name="muted" size={14} />
              {t('analysis.mesh_issues.bulk.mute_rule', 'Mute this rule')}
            </button>
          )}
        </div>
      )}

      {confirmKind && (
        <ConfirmBulkDialog
          kind={confirmKind}
          subjectLabel={subjectLabel}
          count={confirmKind === 'dismiss' ? openCount : dismissedCount}
          onCancel={() => setConfirmKind(null)}
          onConfirm={() => {
            setConfirmKind(null);
            if (confirmKind === 'dismiss') onDismissAll();
            else onRestoreAll();
          }}
        />
      )}
    </div>
  );
};

function ConfirmBulkDialog({
  kind,
  subjectLabel,
  count,
  onCancel,
  onConfirm,
}: {
  kind: BulkConfirmKind;
  subjectLabel: string;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const title =
    kind === 'dismiss'
      ? t('analysis.mesh_issues.bulk.confirm_dismiss_title', 'Dismiss all findings?')
      : t('analysis.mesh_issues.bulk.confirm_restore_title', 'Restore all dismissed findings?');
  const body =
    kind === 'dismiss'
      ? t(
          'analysis.mesh_issues.bulk.confirm_dismiss_body',
          'Dismiss all {{count}} open findings for {{subject}}? You can restore them later.',
          { count, subject: subjectLabel },
        )
      : t(
          'analysis.mesh_issues.bulk.confirm_restore_body',
          'Restore all {{count}} dismissed findings for {{subject}}?',
          { count, subject: subjectLabel },
        );

  return (
    <div className={styles.confirmOverlay} onClick={onCancel}>
      <div
        className={styles.confirmDialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="bulk-confirm-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className={styles.confirmTitle}>{title}</h4>
        <p className={styles.confirmBody}>{body}</p>
        <div className={styles.confirmActions}>
          <button type="button" className="reports-btn reports-btn--ghost" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            data-testid="bulk-confirm-go"
            className={`reports-btn ${kind === 'dismiss' ? styles.menuItemDanger : ''}`}
            onClick={onConfirm}
          >
            {kind === 'dismiss'
              ? t('analysis.mesh_issues.bulk.confirm_dismiss_go', 'Dismiss all')
              : t('analysis.mesh_issues.bulk.confirm_restore_go', 'Restore all')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BulkActionMenu;
