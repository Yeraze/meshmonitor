/**
 * CoverageImportDialog (#5891 P3, spec §2.10): pick a Coverage Report CSV or
 * GeoJSON file and a target source, upload it, show what came of it. The size
 * pre-check uses the server's own cap so a huge file never leaves the browser.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { useImportCoverageFile } from '../../hooks/useCoverageImports';
import { CoverageImportUploadError } from '../../services/coverageImportApi';
import { COVERAGE_IMPORT_MAX_BYTES, COVERAGE_IMPORT_MAX_ERRORS } from '../../utils/coverageImport';
import type { CoverageImportResult, CoverageImportRowError } from '../../types/coverageImport';
import styles from './CoverageImport.module.css';

export interface CoverageImportDialogSource {
  id: string;
  name: string;
  type?: string;
}

export interface CoverageImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Sources the viewer may write, already filtered by the caller. */
  sources: CoverageImportDialogSource[];
  /** The source the report is filtered to, if any; the default target when it is in `sources`. */
  defaultSourceId?: string;
  /** `walkabout` (#6573): copy for a walkabout session export (JSON only). Same upload route. */
  variant?: 'coverage' | 'walkabout';
}

const MAX_MB = Math.round(COVERAGE_IMPORT_MAX_BYTES / (1024 * 1024));

export function CoverageImportDialog({ isOpen, onClose, sources, defaultSourceId, variant = 'coverage' }: CoverageImportDialogProps) {
  const walkabout = variant === 'walkabout';
  const { t } = useTranslation();
  const importFile = useImportCoverageFile();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickedSource, setPickedSource] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<CoverageImportRowError[]>([]);
  const [errorCount, setErrorCount] = useState(0);
  const [result, setResult] = useState<CoverageImportResult | null>(null);

  const fallbackId = sources.some((s) => s.id === defaultSourceId) ? (defaultSourceId as string) : (sources[0]?.id ?? '');
  const sourceId = sources.some((s) => s.id === pickedSource) ? pickedSource : fallbackId;
  const uploading = importFile.isPending;

  const clearOutcome = () => {
    setMessage(null);
    setRowErrors([]);
    setErrorCount(0);
    setResult(null);
  };

  const handleFile = (next: File | null) => {
    clearOutcome();
    if (next && next.size > COVERAGE_IMPORT_MAX_BYTES) {
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setMessage(
        t('analysis.coverage.import_too_large', 'This file is over {{max}} MB. Split it and import the parts.', {
          max: MAX_MB,
        }),
      );
      return;
    }
    setFile(next);
  };

  const handleImport = async () => {
    if (!file || !sourceId || uploading) return;
    clearOutcome();
    try {
      setResult(await importFile.mutateAsync({ sourceId, file }));
    } catch (err) {
      if (err instanceof CoverageImportUploadError) {
        setMessage(err.message);
        setRowErrors(err.errors.slice(0, COVERAGE_IMPORT_MAX_ERRORS));
        setErrorCount(err.errorCount);
      } else {
        setMessage(err instanceof Error ? err.message : t('analysis.coverage.import_failed', 'The import failed.'));
      }
    }
  };

  const handleClose = () => {
    if (uploading) return;
    setFile(null);
    clearOutcome();
    onClose();
  };

  const imp = result?.import;
  const hiddenErrors = Math.max(0, errorCount - rowErrors.length);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={
        walkabout
          ? t('analysis.walkabout.import_title', 'Import walkabout sessions')
          : t('analysis.coverage.import_title', 'Import coverage data')
      }
      maxWidth="560px"
    >
      <div className={styles.dialogBody} data-testid="coverage-import-dialog">
        <p className={styles.note}>
          {walkabout
            ? t(
                'analysis.walkabout.import_intro',
                'Import a JSON file exported from a walkabout session. Each session in it becomes a new, finished session on the source you pick and stays until you delete the import.',
              )
            : t(
                'analysis.coverage.import_intro',
                'Import a CSV or GeoJSON file exported from the Coverage Report. The rows join the report for the source you pick and stay until you delete the import.',
              )}
        </p>

        <label className={styles.field}>
          <span>{t('analysis.coverage.import_source', 'Target source')}</span>
          <select
            value={sourceId}
            onChange={(e) => setPickedSource(e.target.value)}
            disabled={uploading}
            data-testid="coverage-import-source"
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span>{t('analysis.coverage.import_file', 'File')}</span>
          <input
            ref={fileRef}
            type="file"
            accept={walkabout ? '.json' : '.csv,.geojson,.json'}
            disabled={uploading}
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            data-testid="coverage-import-file"
          />
        </label>

        {!walkabout && <p className={styles.note}>
          {t(
            'analysis.coverage.import_same_instance_note',
            'Rows this instance still holds live are skipped, because they are already in the report. Importing into the instance that made the export therefore adds nothing for recent data. Save a survey to keep live data.',
          )}
        </p>}

        {message && (
          <div className={styles.error} role="alert" data-testid="coverage-import-error">
            {message}
            {rowErrors.length > 0 && (
              <ul className={styles.errorList}>
                {rowErrors.map((e, i) => (
                  <li key={`${e.row}-${e.field ?? ''}-${i}`}>
                    {e.field
                      ? t('analysis.coverage.import_row_error_field', 'Row {{row}}, {{field}}: {{message}}', {
                          row: e.row,
                          field: e.field,
                          message: e.message,
                        })
                      : t('analysis.coverage.import_row_error', 'Row {{row}}: {{message}}', {
                          row: e.row,
                          message: e.message,
                        })}
                  </li>
                ))}
              </ul>
            )}
            {hiddenErrors > 0 && (
              <div>{t('analysis.coverage.import_more_errors', '{{count}} more errors not shown.', { count: hiddenErrors })}</div>
            )}
          </div>
        )}

        {imp && result && (
          <div className={styles.success} role="status" data-testid="coverage-import-success">
            {t('analysis.coverage.import_done', 'Imported {{filename}}.', { filename: imp.filename })}
            <ul className={styles.successList}>
              {result.sessionIds && (
                <li data-testid="coverage-import-sessions">
                  {t('analysis.walkabout.import_sessions', { count: result.sessionIds.length, defaultValue: '{{count}} sessions added' })}
                </li>
              )}
              <li>{t('analysis.coverage.import_inserted', '{{count}} rows added', { count: imp.insertedCount })}</li>
              <li>
                {t('analysis.coverage.import_duplicates', '{{count}} rows already here, skipped', {
                  count: imp.duplicateCount,
                })}
              </li>
              {imp.skippedCount > 0 && (
                <li>
                  {t('analysis.coverage.import_skipped', '{{count}} rows skipped (wrong protocol or gap lines)', {
                    count: imp.skippedCount,
                  })}
                </li>
              )}
              {imp.sourceTruncated && (
                <li data-testid="coverage-import-truncated">
                  {t(
                    'analysis.coverage.import_truncated',
                    'The source report was cut at its row limit, so the file holds only part of the data.',
                  )}
                </li>
              )}
            </ul>
          </div>
        )}

        <div className={styles.buttons}>
          <button type="button" className="reports-btn reports-btn--ghost" onClick={handleClose} disabled={uploading}>
            {imp ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="reports-btn"
            onClick={() => void handleImport()}
            disabled={!file || !sourceId || uploading}
            data-testid="coverage-import-submit"
          >
            {uploading ? t('analysis.coverage.import_uploading', 'Importing…') : t('analysis.coverage.import_submit', 'Import')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
