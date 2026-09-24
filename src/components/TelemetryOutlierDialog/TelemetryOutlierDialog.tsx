/**
 * Telemetry outlier purge dialog (#5333).
 *
 * Two entry points share it:
 * - **node** (a telemetry chart's ⋯ menu): source, metric and node are fixed.
 * - **sweep** (Settings → Danger Zone): pick a source and a metric; every node
 *   on the source is checked against its own series.
 *
 * Flow: configure → preview (dry run, nothing deleted) → explicit confirm →
 * delete. The delete sends back the preview's cutoffId + fingerprint, so the
 * server removes exactly the previewed rows or refuses (PREVIEW_STALE).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import apiService, { ApiError, type TelemetryOutlierRequest } from '../../services/api';
import {
  OUTLIER_K_DEFAULT,
  OUTLIER_K_MAX,
  OUTLIER_K_MIN,
  OUTLIER_MIN_SAMPLES,
  validateOutlierCriteria,
  type OutlierPreview,
} from '../../utils/telemetryOutliers';
import styles from './TelemetryOutlierDialog.module.css';

export interface TelemetryOutlierDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fixed source (node mode) or the initial selection (sweep mode). */
  sourceId?: string | null;
  /** Fixed metric (node mode). */
  telemetryType?: string;
  /** Present ⇒ node mode: only this node's series is analysed. */
  nodeId?: string;
  /** Display name for the node in node mode. */
  nodeLabel?: string;
  /** Sweep mode: the sources the admin may pick from. */
  sources?: Array<{ id: string; name: string }>;
  /** Human label for a telemetry type. */
  getTypeLabel?: (type: string) => string;
  /** Called after a successful delete with the number of rows removed. */
  onPurged?: (deletedCount: number) => void;
}

type Step = 'configure' | 'preview' | 'confirm' | 'done';

function formatValue(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '–';
  return String(Number(v.toPrecision(6)));
}

const TelemetryOutlierDialog: React.FC<TelemetryOutlierDialogProps> = ({
  isOpen,
  onClose,
  sourceId: initialSourceId,
  telemetryType: fixedType,
  nodeId,
  nodeLabel,
  sources = [],
  getTypeLabel = (type: string) => type,
  onPurged,
}) => {
  const { t } = useTranslation();
  const isNodeMode = Boolean(nodeId);

  const [sourceId, setSourceId] = useState<string>(initialSourceId ?? '');
  const [telemetryType, setTelemetryType] = useState<string>(fixedType ?? '');
  const [types, setTypes] = useState<string[] | null>(null);
  const [auto, setAuto] = useState(true);
  const [k, setK] = useState(String(OUTLIER_K_DEFAULT));
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [step, setStep] = useState<Step>('configure');
  const [preview, setPreview] = useState<OutlierPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedCount, setDeletedCount] = useState(0);

  // Fresh state every time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setSourceId(initialSourceId ?? '');
    setTelemetryType(fixedType ?? '');
    setAuto(true);
    setK(String(OUTLIER_K_DEFAULT));
    setMin('');
    setMax('');
    setStep('configure');
    setPreview(null);
    setError(null);
    setBusy(false);
  }, [isOpen, initialSourceId, fixedType]);

  // Sweep mode: load the chosen source's metrics.
  useEffect(() => {
    if (!isOpen || isNodeMode || !sourceId) {
      setTypes(null);
      return;
    }
    let cancelled = false;
    setTypes(null);
    apiService
      .getTelemetryOutlierTypes(sourceId)
      .then(list => {
        if (cancelled) return;
        setTypes(list);
        setTelemetryType(prev => (list.includes(prev) ? prev : ''));
      })
      .catch(err => {
        if (!cancelled) {
          setTypes([]);
          setError(t('telemetry_outliers.error', { message: err instanceof Error ? err.message : String(err) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isNodeMode, sourceId, t]);

  const validation = useMemo(
    () => validateOutlierCriteria({ auto, k: k.trim() === '' ? undefined : Number(k), min, max }),
    [auto, k, min, max],
  );

  const validationMessage = validation.ok
    ? null
    : validation.code === 'INVALID_K'
      ? t('telemetry_outliers.invalid_k', { min: OUTLIER_K_MIN, max: OUTLIER_K_MAX })
      : validation.code === 'NO_CRITERIA'
        ? t('telemetry_outliers.no_criteria')
        : t('telemetry_outliers.invalid_bounds');

  const canPreview = validation.ok && Boolean(sourceId) && Boolean(telemetryType) && !busy;

  const buildRequest = (): TelemetryOutlierRequest | null => {
    if (!validation.ok) return null;
    return {
      sourceId,
      telemetryType,
      ...(nodeId ? { nodeId } : {}),
      ...validation.criteria,
    };
  };

  /** Any edit after a preview invalidates it. */
  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    if (step !== 'configure') {
      setStep('configure');
      setPreview(null);
    }
    setError(null);
  };

  const runPreview = async () => {
    const req = buildRequest();
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiService.previewTelemetryOutliers(req);
      setPreview(result);
      setStep('preview');
    } catch (err) {
      setError(t('telemetry_outliers.error', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const runPurge = async () => {
    const req = buildRequest();
    if (!req || !preview || preview.cutoffId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiService.purgeTelemetryOutliers({
        ...req,
        cutoffId: preview.cutoffId,
        fingerprint: preview.fingerprint,
      });
      setDeletedCount(result.deletedCount);
      setStep('done');
      onPurged?.(result.deletedCount);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t('telemetry_outliers.stale'));
        setStep('configure');
        setPreview(null);
      } else {
        setError(t('telemetry_outliers.error', { message: err instanceof Error ? err.message : String(err) }));
        setStep('preview');
      }
    } finally {
      setBusy(false);
    }
  };

  const title = isNodeMode
    ? t('telemetry_outliers.title_node', { type: getTypeLabel(telemetryType) })
    : t('telemetry_outliers.title_sweep');

  const reasonLabel = (reason: string) => t(`telemetry_outliers.reason_${reason}`);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} maxWidth="640px">
      <div className={styles.body}>
        {step === 'done' ? (
          <>
            <p className={styles.success} role="status">
              {t('telemetry_outliers.done', { count: deletedCount })}
            </p>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={onClose}>
                {t('telemetry_outliers.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.help}>
              {isNodeMode
                ? t('telemetry_outliers.intro_node', {
                    node: nodeLabel ?? nodeId,
                    type: getTypeLabel(telemetryType),
                  })
                : t('telemetry_outliers.intro_sweep')}
            </p>

            {!isNodeMode && (
              <div className={styles.row}>
                <label className={styles.field}>
                  <span>{t('telemetry_outliers.source_label')}</span>
                  <select
                    className={styles.input}
                    value={sourceId}
                    onChange={e => edit(setSourceId)(e.target.value)}
                  >
                    <option value="">{t('telemetry_outliers.select_source')}</option>
                    {sources.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t('telemetry_outliers.metric_label')}</span>
                  <select
                    className={styles.input}
                    value={telemetryType}
                    disabled={!sourceId || types === null || types.length === 0}
                    onChange={e => edit(setTelemetryType)(e.target.value)}
                  >
                    <option value="">
                      {sourceId && types === null
                        ? t('telemetry_outliers.metric_loading')
                        : types && types.length === 0
                          ? t('telemetry_outliers.metric_none')
                          : t('telemetry_outliers.metric_placeholder')}
                    </option>
                    {(types ?? []).map(type => (
                      <option key={type} value={type}>{getTypeLabel(type)}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <fieldset className={styles.group}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={e => edit(setAuto)(e.target.checked)}
                />
                {t('telemetry_outliers.auto_label')}
              </label>
              <label className={styles.field}>
                <span>{t('telemetry_outliers.k_label', { min: OUTLIER_K_MIN, max: OUTLIER_K_MAX })}</span>
                <input
                  className={styles.input}
                  type="number"
                  min={OUTLIER_K_MIN}
                  max={OUTLIER_K_MAX}
                  step={0.5}
                  value={k}
                  disabled={!auto}
                  onChange={e => edit(setK)(e.target.value)}
                />
              </label>
              <p className={styles.hint}>{t('telemetry_outliers.auto_help', { min: OUTLIER_MIN_SAMPLES })}</p>
            </fieldset>

            <fieldset className={styles.group}>
              <div className={styles.row}>
                <label className={styles.field}>
                  <span>{t('telemetry_outliers.min_label')}</span>
                  <input
                    className={styles.input}
                    type="number"
                    value={min}
                    onChange={e => edit(setMin)(e.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('telemetry_outliers.max_label')}</span>
                  <input
                    className={styles.input}
                    type="number"
                    value={max}
                    onChange={e => edit(setMax)(e.target.value)}
                  />
                </label>
              </div>
              <p className={styles.hint}>{t('telemetry_outliers.bounds_help')}</p>
            </fieldset>

            {validationMessage && <p className={styles.error}>{validationMessage}</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}

            {preview && step !== 'configure' && (
              <section className={styles.preview} aria-live="polite" data-testid="outlier-preview">
                <p className={styles.summary}>
                  {isNodeMode
                    ? t('telemetry_outliers.summary_node', {
                        count: preview.affectedCount,
                        total: preview.rowsScanned,
                      })
                    : t('telemetry_outliers.summary_sweep', {
                        count: preview.affectedCount,
                        total: preview.rowsScanned,
                        nodes: preview.nodesAffected,
                        scanned: preview.nodesScanned,
                      })}
                </p>
                {preview.affectedCount > 0 && (
                  <p className={styles.help}>
                    {t('telemetry_outliers.removed_range', {
                      min: formatValue(preview.removedMin),
                      max: formatValue(preview.removedMax),
                    })}
                  </p>
                )}
                {isNodeMode && preview.median !== null && (
                  <p className={styles.help}>
                    {t('telemetry_outliers.median', { value: formatValue(preview.median) })}
                  </p>
                )}
                {isNodeMode && preview.scaleKind === 'too_few' && (
                  <p className={styles.warn}>
                    {t('telemetry_outliers.skipped_too_few', { min: OUTLIER_MIN_SAMPLES })}
                  </p>
                )}
                {isNodeMode && preview.scaleKind === 'flat' && (
                  <p className={styles.warn}>{t('telemetry_outliers.skipped_flat')}</p>
                )}
                {!isNodeMode && auto && (preview.nodesTooFew > 0 || preview.nodesFlat > 0) && (
                  <p className={styles.warn}>
                    {t('telemetry_outliers.sweep_skipped', {
                      tooFew: preview.nodesTooFew,
                      flat: preview.nodesFlat,
                    })}
                  </p>
                )}

                {preview.affectedCount === 0 ? (
                  <p className={styles.help}>{t('telemetry_outliers.none_found')}</p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>{t('telemetry_outliers.col_time')}</th>
                          {!isNodeMode && <th>{t('telemetry_outliers.col_node')}</th>}
                          <th>{t('telemetry_outliers.col_value')}</th>
                          <th>{t('telemetry_outliers.col_reason')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.points.map(p => (
                          <tr key={p.id}>
                            <td>{new Date(p.timestamp).toLocaleString()}</td>
                            {!isNodeMode && <td>{p.nodeId}</td>}
                            <td className={styles.value}>{formatValue(p.value)}</td>
                            <td>{reasonLabel(p.reason)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.pointsTruncated && (
                      <p className={styles.hint}>
                        {t('telemetry_outliers.truncated', {
                          shown: preview.points.length,
                          count: preview.affectedCount,
                        })}
                      </p>
                    )}
                  </div>
                )}
              </section>
            )}

            {step === 'confirm' && preview ? (
              <div className={styles.confirm} role="alertdialog">
                <p>{t('telemetry_outliers.confirm_text', { count: preview.affectedCount })}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => setStep('preview')}
                    disabled={busy}
                  >
                    {t('telemetry_outliers.cancel')}
                  </button>
                  <button type="button" className={styles.danger} onClick={runPurge} disabled={busy}>
                    {busy ? t('telemetry_outliers.deleting') : t('telemetry_outliers.confirm_button')}
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                <button type="button" className={styles.secondary} onClick={onClose}>
                  {t('telemetry_outliers.cancel')}
                </button>
                <button type="button" className={styles.primary} onClick={runPreview} disabled={!canPreview}>
                  {busy ? t('telemetry_outliers.previewing') : t('telemetry_outliers.preview_button')}
                </button>
                {step === 'preview' && preview && preview.affectedCount > 0 && (
                  <button type="button" className={styles.danger} onClick={() => setStep('confirm')}>
                    {t('telemetry_outliers.delete_button', { count: preview.affectedCount })}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};

export default TelemetryOutlierDialog;
