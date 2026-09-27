/**
 * "Asset tracking" section in Node Details (#5354, Phase 1).
 *
 * Visible to everyone; editable only with `settings:write` (the flag is global
 * and extends storage on every source). Turning it on saves with the chosen
 * retention; turning it off clears the flag. Mesh impact: none — storage and
 * UI only.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './AssetTrackingSection.module.css';
import { useAssetEstimate, useClearAsset, useSetAsset } from '../hooks/useAssetTracking';
import {
  ASSET_RETENTION_DAYS_DEFAULT,
  ASSET_RETENTION_DAYS_RANGE,
  parseAssetRetentionDays,
} from '../utils/assetTracking';

interface AssetTrackingSectionProps {
  nodeNum: number;
  /** The node's current flag from the payload overlay; undefined = not an asset. */
  asset?: { retentionDays: number } | null;
  canEdit: boolean;
}

const AssetTrackingSection: React.FC<AssetTrackingSectionProps> = ({ nodeNum, asset, canEdit }) => {
  const { t } = useTranslation();
  const storedDays = asset?.retentionDays ?? null;
  const [enabled, setEnabled] = useState<boolean>(storedDays != null);
  const [daysDraft, setDaysDraft] = useState<string>(String(storedDays ?? ASSET_RETENTION_DAYS_DEFAULT));
  const [error, setError] = useState<string | null>(null);
  const setAsset = useSetAsset();
  const clearAsset = useClearAsset();
  const saving = setAsset.isPending || clearAsset.isPending;

  // Re-sync when the selected node, or its stored flag, changes.
  useEffect(() => {
    setEnabled(storedDays != null);
    setDaysDraft(String(storedDays ?? ASSET_RETENTION_DAYS_DEFAULT));
    setError(null);
  }, [nodeNum, storedDays]);

  const parsedDays = parseAssetRetentionDays(daysDraft);
  // The estimate is only shown to editors; read-only viewers don't fetch it.
  const showEstimate = canEdit && enabled;
  const estimate = useAssetEstimate(showEstimate ? nodeNum : null, showEstimate ? parsedDays : null);
  const dirty = enabled && parsedDays != null && parsedDays !== storedDays;

  const saveError = (err: unknown) =>
    setError(err instanceof Error ? err.message : t('node_details.asset_save_error', 'Failed to save asset tracking'));

  const handleToggle = (next: boolean) => {
    setError(null);
    if (next) {
      const days = parsedDays ?? ASSET_RETENTION_DAYS_DEFAULT;
      setEnabled(true);
      setAsset.mutate({ nodeNum, retentionDays: days }, { onError: (e) => { setEnabled(false); saveError(e); } });
    } else {
      setEnabled(false);
      clearAsset.mutate(nodeNum, { onError: (e) => { setEnabled(true); saveError(e); } });
    }
  };

  const handleSaveDays = () => {
    if (parsedDays == null || !dirty) return;
    setError(null);
    setAsset.mutate({ nodeNum, retentionDays: parsedDays }, { onError: saveError });
  };

  const estimateText = (() => {
    if (!enabled) return null;
    if (parsedDays == null || estimate.isLoading) return null;
    const rows = estimate.data?.estimatedRows;
    return rows == null
      ? t('node_details.asset_estimate_unknown', 'Estimated rows kept: unknown')
      : t('node_details.asset_estimate', { count: rows, rows: rows.toLocaleString(), defaultValue: 'About {{rows}} rows kept' });
  })();

  const helpText = t(
    'node_details.asset_help',
    "Keeps all of this node's telemetry for the chosen number of days on every source, and always draws its trail on the map. Cleanups that run automatically won't delete it.",
  );

  return (
    <section className={styles.section} aria-label={t('node_details.asset_title', 'Asset tracking')}>
      <h4 className={styles.title}>
        <UiIcon name="location" /> {t('node_details.asset_title', 'Asset tracking')}
      </h4>
      {canEdit ? (
        <>
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={saving}
              onChange={(e) => handleToggle(e.target.checked)}
            />
            {t('node_details.asset_enable', 'Track this node as an asset')}
          </label>
          {enabled && (
            <div className={styles.retentionRow}>
              <label htmlFor={`asset-days-${nodeNum}`}>
                {t('node_details.asset_retention_days', 'Keep history for (days)')}
              </label>
              <input
                id={`asset-days-${nodeNum}`}
                className={styles.daysInput}
                type="number"
                min={ASSET_RETENTION_DAYS_RANGE.min}
                max={ASSET_RETENTION_DAYS_RANGE.max}
                step={1}
                value={daysDraft}
                disabled={saving}
                onChange={(e) => setDaysDraft(e.target.value)}
              />
              <button type="button" className={styles.save} onClick={handleSaveDays} disabled={saving || !dirty}>
                {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
            </div>
          )}
          {enabled && parsedDays == null && (
            <span className={styles.error}>
              {t('node_details.asset_retention_invalid', {
                min: ASSET_RETENTION_DAYS_RANGE.min,
                max: ASSET_RETENTION_DAYS_RANGE.max,
                defaultValue: 'Enter a whole number from {{min}} to {{max}}',
              })}
            </span>
          )}
          <p className={styles.help}>{helpText}</p>
          {estimateText && <p className={styles.estimate}>{estimateText}</p>}
        </>
      ) : (
        <>
          <p className={styles.status}>
            {storedDays != null
              ? t('node_details.asset_readonly_on', {
                  days: storedDays,
                  defaultValue: 'Tracked as an asset. Keeps {{days}} days of telemetry.',
                })
              : t('node_details.asset_readonly_off', 'Not tracked as an asset.')}
          </p>
          <p className={styles.help}>{helpText}</p>
        </>
      )}
      {error && <span className={styles.error} role="alert">{error}</span>}
    </section>
  );
};

export default AssetTrackingSection;
