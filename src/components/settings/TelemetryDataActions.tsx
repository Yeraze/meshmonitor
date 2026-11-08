/**
 * Telemetry danger actions: Purge telemetry + Clean outliers (#6258).
 *
 * One implementation for SettingsTab (Meshtastic, global or source scope) and
 * the MeshCore Settings view. `sourceId` null/undefined purges every source;
 * a set value touches that source only and uses the source-scoped confirm copy.
 * Renders `danger-action` rows; the caller supplies the surrounding section.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ToastContainer';
import apiService from '../../services/api';
import { logger } from '../../utils/logger';
import TelemetryOutlierDialog from '../TelemetryOutlierDialog/TelemetryOutlierDialog';
import { getTelemetryLabel } from '../TelemetryChart';

export interface TelemetryDataActionsProps {
  /** null/undefined = all sources; set = that source only. */
  sourceId?: string | null;
  /** Sources offered by the outlier dialog. */
  sources: Array<{ id: string; name: string }>;
}

export const TelemetryDataActions: React.FC<TelemetryDataActionsProps> = ({ sourceId, sources }) => {
  const { t } = useTranslation();
  const { authStatus } = useAuth();
  const { showToast } = useToast();
  const [outlierOpen, setOutlierOpen] = useState(false);
  const isAdmin = authStatus?.user?.isAdmin ?? false;

  const handlePurgeTelemetry = async () => {
    const confirmed = window.confirm(
      t(sourceId ? 'settings.confirm_purge_telemetry_title_source' : 'settings.confirm_purge_telemetry_title') + '\n\n' +
      t('settings.confirm_purge_nodes_impact') + '\n' +
      '• ' + t(sourceId ? 'settings.confirm_purge_telemetry_item1_source' : 'settings.confirm_purge_telemetry_item1') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item2') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item3') + '\n' +
      '• ' + t('settings.confirm_purge_telemetry_item4') + '\n\n' +
      t('settings.confirm_cannot_undo')
    );

    if (!confirmed) return;

    try {
      await apiService.purgeTelemetry(0, sourceId ?? undefined);
      showToast(t('toast.telemetry_purged'), 'success');
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      logger.error('Error purging telemetry:', error);
      showToast(t('toast.telemetry_purge_failed'), 'error');
    }
  };

  return (
    <>
      <div className="danger-action">
        <div className="danger-action-info">
          <h4>{t('settings.purge_telemetry_title')}</h4>
          <p>{t(sourceId ? 'settings.purge_telemetry_description_source' : 'settings.purge_telemetry_description')}</p>
        </div>
        <button className="danger-button" onClick={handlePurgeTelemetry}>
          {t('settings.purge_telemetry_button')}
        </button>
      </div>

      {isAdmin && (
        <div className="danger-action">
          <div className="danger-action-info">
            <h4>{t('settings.clean_outliers_title')}</h4>
            <p>{t('settings.clean_outliers_description')}</p>
          </div>
          <button className="danger-button" onClick={() => setOutlierOpen(true)}>
            {t('settings.clean_outliers_button')}
          </button>
        </div>
      )}
      {isAdmin && (
        <TelemetryOutlierDialog
          isOpen={outlierOpen}
          onClose={() => setOutlierOpen(false)}
          sourceId={sourceId ?? null}
          sources={sources}
          getTypeLabel={getTelemetryLabel}
        />
      )}
    </>
  );
};

export default TelemetryDataActions;
