import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useSource } from '../../contexts/SourceContext';
import { useToast } from '../ToastContainer';
import apiService from '../../services/api';
import { UiIcon } from '../icons';
import TelemetryOutlierDialog from '../TelemetryOutlierDialog/TelemetryOutlierDialog';
import { getTelemetryLabel } from '../TelemetryChart';
import styles from './MeshCoreTelemetryDataSection.module.css';

interface MeshCoreTelemetryDataSectionProps {
  sourceId: string;
}

/**
 * Admin-only telemetry danger actions for one MeshCore source (#6258 WP3).
 * Purge telemetry sends `sourceId`, so other sources keep their history.
 */
export const MeshCoreTelemetryDataSection: React.FC<MeshCoreTelemetryDataSectionProps> = ({ sourceId }) => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const { sourceName } = useSource();
  const { showToast } = useToast();
  const [purging, setPurging] = useState(false);
  const [outlierOpen, setOutlierOpen] = useState(false);
  const isAdmin = authStatus?.user?.isAdmin ?? false;

  const handlePurge = useCallback(async () => {
    if (!window.confirm(t(
      'meshcore.settings.confirm_purge_telemetry_source',
      'Delete ALL stored telemetry for this source only? Other sources are not touched. This cannot be undone.',
    ))) return;
    setPurging(true);
    try {
      await apiService.purgeTelemetry(0, sourceId);
      showToast(t('meshcore.settings.purge_telemetry_done', 'Telemetry for this source purged'), 'success');
    } catch (err) {
      console.error('Error purging MeshCore telemetry:', err);
      showToast(t('toast.telemetry_purge_failed', 'Error purging telemetry. Please try again.'), 'error');
    } finally {
      setPurging(false);
    }
  }, [sourceId, showToast, t]);

  if (!isAdmin) return null;

  return (
    <div className="form-section">
      <h3>{t('meshcore.settings.telemetry_data', 'Telemetry data')}</h3>
      <p className={styles.description}>
        {t(
          'meshcore.settings.telemetry_data_desc',
          'Delete stored telemetry for this source only, or find and remove bad readings for one metric.',
        )}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className="meshcore-purge-all-btn"
          onClick={() => void handlePurge()}
          disabled={purging}
        >
          <UiIcon name="delete" size={15} /> {purging
            ? t('meshcore.settings.purging', 'Purging…')
            : t('meshcore.settings.purge_telemetry', 'Purge telemetry (this source)')}
        </button>
        <button
          type="button"
          className="meshcore-purge-all-btn"
          onClick={() => setOutlierOpen(true)}
        >
          <UiIcon name="delete" size={15} /> {t('settings.clean_outliers_button', 'Clean outliers…')}
        </button>
      </div>
      <TelemetryOutlierDialog
        isOpen={outlierOpen}
        onClose={() => setOutlierOpen(false)}
        sourceId={sourceId}
        sources={[{ id: sourceId, name: sourceName ?? sourceId }]}
        getTypeLabel={getTelemetryLabel}
      />
    </div>
  );
};

export default MeshCoreTelemetryDataSection;
