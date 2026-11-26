/**
 * CoverageImportsPanel (#5891 P3, spec §2.10): the imports of every source the
 * viewer can read, newest first. Show points the report at that import's date
 * span; Delete (write grant only) asks first. Signed-in viewers only: the list
 * route needs a login.
 */
import { useCallback, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../contexts/authContextObject';
import { UiIcon } from '../icons';
import Modal from '../common/Modal';
import {
  useCoverageImportSources,
  useCoverageImports,
  useDeleteCoverageImport,
  type SourcedCoverageImport,
} from '../../hooks/useCoverageImports';
import type { HasSourcePermission } from '../../hooks/useWalkaboutSources';
import { COVERAGE_IMPORT_WRITE_GRANT } from '../../utils/coverageImport';
import styles from './CoverageImport.module.css';

export interface CoverageImportsPanelProps {
  selectedImportId: string | null;
  /** Show: the report adopts this import's window and filter. */
  onShow: (imp: SourcedCoverageImport) => void;
  /** An import the viewer deleted, so the report can drop a selection on it. */
  onDeleted: (importId: string) => void;
}

function PanelInner({ selectedImportId, onShow, onDeleted }: CoverageImportsPanelProps) {
  const { t } = useTranslation();
  const auth = useContext(AuthContext);
  const hasPermission = useCallback<HasSourcePermission>(
    (resource, action, opts) => !!auth?.hasPermission(resource, action, opts),
    [auth],
  );
  const sources = useCoverageImportSources(hasPermission, 'read');
  const { imports: allImports } = useCoverageImports(sources);
  // Walkabout imports (#6573) are listed and deleted on the Walkabout page, beside their sessions.
  const imports = allImports.filter((imp) => imp.kind !== 'walkabout');
  const deleteImport = useDeleteCoverageImport();
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<SourcedCoverageImport | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (sources.length === 0) return null;

  const canDelete = (sourceId: string) =>
    hasPermission(COVERAGE_IMPORT_WRITE_GRANT.resource, COVERAGE_IMPORT_WRITE_GRANT.action, { sourceId });
  const fmt = (ms: number) => new Date(ms).toLocaleDateString();

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleteError(null);
    try {
      await deleteImport.mutateAsync({ sourceId: toDelete.sourceId, importId: toDelete.id });
      onDeleted(toDelete.id);
      setToDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('analysis.coverage.imports_delete_failed', 'Delete failed.'));
    }
  };

  return (
    <div className={styles.panel} data-testid="coverage-imports-panel">
      <div className={styles.panelHeader}>
        <button
          type="button"
          className="reports-btn reports-btn--ghost"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <UiIcon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
          {t('analysis.coverage.imports_title', 'Imports')}
        </button>
        <span className={styles.count}>{t('analysis.coverage.imports_count', '{{count}} imported', { count: imports.length })}</span>
      </div>

      {open &&
        (imports.length === 0 ? (
          <p className={styles.empty}>{t('analysis.coverage.imports_empty', 'No imports yet.')}</p>
        ) : (
          <ul className={styles.list}>
            {imports.map((imp) => {
              const hasSpan = imp.firstReceivedAt != null && imp.lastReceivedAt != null;
              return (
                <li
                  key={imp.id}
                  className={`${styles.row}${imp.id === selectedImportId ? ` ${styles.rowSelected}` : ''}`}
                  data-testid="coverage-import-row"
                >
                  <div className={styles.rowMain}>
                    <div className={styles.filename}>{imp.filename}</div>
                    <div className={styles.meta}>
                      {t('analysis.coverage.imports_meta', '{{source}} · imported {{date}}', {
                        source: imp.sourceName,
                        date: new Date(imp.importedAt).toLocaleString(),
                      })}
                    </div>
                    <div className={styles.meta}>
                      {hasSpan
                        ? t('analysis.coverage.imports_span', 'Data from {{from}} to {{to}}', {
                            from: fmt(imp.firstReceivedAt as number),
                            to: fmt(imp.lastReceivedAt as number),
                          })
                        : t('analysis.coverage.imports_no_span', 'No rows added')}
                      {' · '}
                      {t('analysis.coverage.imports_counts', '{{inserted}} added, {{duplicates}} already here', {
                        inserted: imp.insertedCount,
                        duplicates: imp.duplicateCount,
                      })}
                    </div>
                    {imp.status !== 'complete' && (
                      <div className={`${styles.meta} ${styles.pending}`}>
                        {t('analysis.coverage.imports_importing', 'Still importing')}
                      </div>
                    )}
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className="reports-btn reports-btn--ghost"
                      disabled={!hasSpan}
                      aria-label={t('analysis.coverage.imports_show_aria', 'Show {{filename}} on the map', { filename: imp.filename })}
                      onClick={() => onShow(imp)}
                    >
                      {t('analysis.coverage.imports_show', 'Show')}
                    </button>
                    {canDelete(imp.sourceId) && (
                      <button
                        type="button"
                        className="reports-btn reports-btn--ghost"
                        onClick={() => {
                          setDeleteError(null);
                          setToDelete(imp);
                        }}
                      >
                        <UiIcon name="delete" size={14} />
                        {t('analysis.coverage.imports_delete', 'Delete')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ))}

      <Modal
        isOpen={toDelete != null}
        onClose={() => setToDelete(null)}
        title={t('analysis.coverage.imports_delete_title', 'Delete import')}
        maxWidth="440px"
      >
        <div className={styles.dialogBody} data-testid="coverage-import-delete-confirm">
          <p className={styles.note}>
            {t('analysis.coverage.imports_delete_confirm', 'Delete {{filename}} and its {{count}} rows? This cannot be undone.', {
              filename: toDelete?.filename ?? '',
              count: toDelete?.insertedCount ?? 0,
            })}
          </p>
          {deleteError && <div className={styles.error} role="alert">{deleteError}</div>}
          <div className={styles.buttons}>
            <button type="button" className="reports-btn reports-btn--ghost" onClick={() => setToDelete(null)}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              className="reports-btn"
              onClick={() => void confirmDelete()}
              disabled={deleteImport.isPending}
              data-testid="coverage-import-delete-confirm-button"
            >
              {t('analysis.coverage.imports_delete', 'Delete')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function CoverageImportsPanel(props: CoverageImportsPanelProps) {
  const auth = useContext(AuthContext);
  if (!auth?.authStatus?.authenticated) return null;
  return <PanelInner {...props} />;
}
