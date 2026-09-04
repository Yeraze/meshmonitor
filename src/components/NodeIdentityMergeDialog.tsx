import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { UiIcon } from './icons';
import apiService from '../services/api';
import type { MergePreview, MergeResult } from '../types/nodeIdentityChange';
import styles from './NodeIdentityMergeDialog.module.css';

/**
 * The confirmation flow for merging a Meshtastic 2.8 renumbered node's history
 * onto its new node number (issue #5032).
 *
 * The shape of this dialog is the safety design, not decoration:
 *
 * - **It opens on a dry run, not on the merge.** Nothing is written until the
 *   operator presses the confirm button, and what they press it on is a
 *   per-table row count produced by the same server code that will perform the
 *   merge. There is no separate estimate to drift.
 * - **It says what will be LOST, not only what will move.** Dropped rows get
 *   their own colour, and the "not re-keyed" list is right there rather than in
 *   a document nobody reads.
 * - **It refuses to hide an unreversible merge.** When the server reports that
 *   the change is too large to journal, the confirm button stays disabled until
 *   the operator ticks an explicit acknowledgement.
 * - **It never guesses the pairing.** The two node numbers come from the
 *   caller; the server's detector only supplies the `basis` label, and a
 *   `manual` label is shown as the warning it is.
 *
 * Merging is admin-only server-side. The caller is responsible for not
 * rendering the launch button to a non-admin — but a non-admin who reaches the
 * endpoint anyway gets a 403, which surfaces here as an error rather than a
 * silent no-op.
 */
export interface NodeIdentityMergeDialogProps {
  sourceId: string;
  /** The node being retired — the old, pre-2.8 number. */
  fromNodeNum: number;
  /** The node that survives — the new, key-derived number. */
  toNodeNum: number;
  fromLabel: string;
  toLabel: string;
  onClose: () => void;
  /** Called after a successful merge, with the server's result. */
  onMerged?: (result: MergeResult) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function NodeIdentityMergeDialog({
  sourceId,
  fromNodeNum,
  toNodeNum,
  fromLabel,
  toLabel,
  onClose,
  onMerged,
}: NodeIdentityMergeDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiService
      .previewNodeIdentityMerge(sourceId, fromNodeNum, toNodeNum)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errorMessage(err, t('nodes.merge_preview_failed', 'Could not preview the merge.')));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, fromNodeNum, toNodeNum, t]);

  const handleMerge = useCallback(async () => {
    setMerging(true);
    setError(null);
    try {
      const result = await apiService.mergeNodeIdentities(sourceId, fromNodeNum, toNodeNum, {
        acknowledgeNoUndo: acknowledged,
      });
      // The node list, the detection report and the merge history are all stale
      // now — a node row has just disappeared.
      await queryClient.invalidateQueries({ queryKey: ['nodeIdentityChanges', sourceId] });
      await queryClient.invalidateQueries({ queryKey: ['nodeIdentityMerges', sourceId] });
      await queryClient.invalidateQueries({ queryKey: ['nodes'] });
      onMerged?.(result);
      onClose();
    } catch (err) {
      setError(errorMessage(err, t('nodes.merge_failed', 'The merge failed. Nothing was changed.')));
    } finally {
      setMerging(false);
    }
  }, [sourceId, fromNodeNum, toNodeNum, acknowledged, queryClient, onMerged, onClose, t]);

  const needsAcknowledgement = preview !== null && !preview.undoable;
  const canMerge = preview !== null && !merging && (!needsAcknowledgement || acknowledged);

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('nodes.merge_title', 'Merge node history')}
        data-testid="node-identity-merge-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <UiIcon name="link" size={16} />
          {t('nodes.merge_title', 'Merge node history')}
          <span className={styles.headerSpacer} />
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            <UiIcon name="close" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.direction}>
            <div className={styles.nodeChip}>
              <span className={styles.roleLabel}>{t('nodes.merge_from', 'Retire')}</span>
              <span className={styles.nodeChipName}>{fromLabel}</span>
              <span className={styles.nodeChipId}>{preview?.fromNodeId ?? ''}</span>
            </div>
            <span className={styles.arrow} aria-hidden="true">
              <UiIcon name="forward" size={16} />
            </span>
            <div className={styles.nodeChip}>
              <span className={styles.roleLabel}>{t('nodes.merge_to', 'Keep')}</span>
              <span className={styles.nodeChipName}>{toLabel}</span>
              <span className={styles.nodeChipId}>{preview?.toNodeId ?? ''}</span>
            </div>
          </div>

          <p>
            {t(
              'nodes.merge_explanation',
              "Everything recorded under the retired node moves to the surviving node's number, and the retired node's entry is removed. This is a dry run until you confirm: the counts below are produced by the same code that performs the merge.",
            )}
          </p>

          {error && (
            <div className={styles.errorBox} role="alert">
              {error}
            </div>
          )}

          {loading && <div className={styles.loading}>{t('nodes.merge_loading', 'Counting affected rows…')}</div>}

          {preview && (
            <>
              {preview.detectionBasis === 'manual' && (
                <div className={styles.warning}>
                  <div className={styles.warningTitle}>
                    <UiIcon name="alert" size={16} />
                    {t('nodes.merge_unverified_title', 'This pairing is not key-verified')}
                  </div>
                  {t(
                    'nodes.merge_unverified_body',
                    "No public-key evidence links these two entries, so MeshMonitor cannot confirm they are the same physical node. Merging on a guess splices two nodes' histories together. Only proceed if you know from outside the app that this is correct.",
                  )}
                </div>
              )}

              <div className={styles.totals}>
                <span>
                  {t('nodes.merge_total_rekeyed', 'Rows moved:')}{' '}
                  <span className={styles.totalValue}>{preview.totalRowsRekeyed.toLocaleString()}</span>
                </span>
                <span>
                  {t('nodes.merge_total_dropped', 'Rows removed:')}{' '}
                  <span className={styles.totalValue}>{preview.totalRowsDropped.toLocaleString()}</span>
                </span>
              </div>

              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{t('nodes.merge_col_table', 'Table')}</th>
                      <th>{t('nodes.merge_col_column', 'Column')}</th>
                      <th>{t('nodes.merge_col_action', 'Action')}</th>
                      <th className={styles.numeric}>{t('nodes.merge_col_rows', 'Rows')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.entries.map((entry, index) => {
                      const drops =
                        entry.action === 'dropCollision' ||
                        entry.action === 'dropSelfLoop' ||
                        entry.action === 'dropRow' ||
                        entry.action === 'deleteNodeRow';
                      return (
                        <tr key={`${entry.table}-${entry.column}-${index}`}>
                          <td className={styles.tableName}>{entry.table}</td>
                          <td className={styles.tableName}>{entry.column}</td>
                          <td className={drops ? styles.actionDrop : undefined}>
                            {mergeActionLabel(entry.action, t)}
                            {entry.note && <div className={styles.note}>{entry.note}</div>}
                          </td>
                          <td className={styles.numeric}>{entry.rows.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {preview.warnings.length > 0 && (
                <div className={styles.warning}>
                  <div className={styles.warningTitle}>
                    <UiIcon name="alert" size={16} />
                    {t('nodes.merge_warnings_title', 'Before you confirm')}
                  </div>
                  <ul className={styles.list}>
                    {preview.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <details className={styles.details}>
                <summary>
                  {t(
                    'nodes.merge_not_rekeyed_summary',
                    '{{count}} things that keep the old node number',
                    { count: preview.notRekeyed.length },
                  )}
                </summary>
                <ul>
                  {preview.notRekeyed.map((entry) => (
                    <li key={entry.table}>
                      <span className={styles.tableName}>{entry.table}</span> — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>

              {needsAcknowledgement ? (
                <>
                  <div className={styles.danger}>
                    <div className={styles.dangerTitle}>
                      <UiIcon name="alert" size={16} />
                      {t('nodes.merge_no_undo_title', 'This merge cannot be undone')}
                    </div>
                    {t(
                      'nodes.merge_no_undo_body',
                      'It touches too many rows to record a complete undo, so there will be no way back. Take a database backup first if you want one.',
                    )}
                  </div>
                  <label className={styles.acknowledge}>
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    {t(
                      'nodes.merge_no_undo_ack',
                      'I understand this merge is permanent and cannot be reversed.',
                    )}
                  </label>
                </>
              ) : (
                <p>
                  {t(
                    'nodes.merge_undo_available',
                    'This merge can be undone afterwards: MeshMonitor records what it moved so it can be put back.',
                  )}
                </p>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={merging}>
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={styles.confirmButton}
            onClick={handleMerge}
            disabled={!canMerge}
            data-testid="node-identity-merge-confirm"
          >
            {merging
              ? t('nodes.merge_running', 'Merging…')
              : t('nodes.merge_confirm', 'Merge history')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Plain-language label for a plan action. Machine names never reach the operator. */
function mergeActionLabel(
  action: MergePreview['entries'][number]['action'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  switch (action) {
    case 'rekey':
      return t('nodes.merge_action_rekey', 'Move to new node number');
    case 'moveRow':
      return t('nodes.merge_action_move_row', 'Move to new node number');
    case 'dropCollision':
      return t('nodes.merge_action_drop_collision', 'Remove duplicate');
    case 'dropSelfLoop':
      return t('nodes.merge_action_drop_self', 'Remove (node would be its own neighbour)');
    case 'dropRow':
      return t('nodes.merge_action_drop_row', 'Remove (the surviving node already has one)');
    case 'deleteNodeRow':
      return t('nodes.merge_action_delete_node', 'Remove the retired node entry');
    case 'patchNodeRow':
      return t('nodes.merge_action_patch_node', 'Carry over to the surviving node');
    default:
      return action;
  }
}

export default NodeIdentityMergeDialog;
