/**
 * Restart / shutdown of the MeshMonitor process (#6258 D6).
 *
 * It acts on the whole install, not one source, so it lives in Global Settings
 * (admin-only). It used to sit in each source's Danger Zone.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { UiIcon } from '../icons';
import { logger } from '../../utils/logger';

export default function SystemRestartSection(): React.ReactElement | null {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isDocker, setIsDocker] = useState<boolean | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    const fetchSystemStatus = async () => {
      try {
        const data = await apiService.get<{ isDocker?: boolean }>('/api/system/status');
        setIsDocker(!!data.isDocker);
      } catch (error) {
        logger.error('Failed to fetch system status:', error);
      }
    };
    void fetchSystemStatus();
  }, []);

  const handleRestartContainer = async () => {
    const action = isDocker ? t('settings.restart_action') : t('settings.shutdown_action');
    const confirmed = window.confirm(
      t('settings.confirm_restart_title', { action }) + '\n\n' +
      (isDocker
        ? t('settings.confirm_restart_docker')
        : t('settings.confirm_restart_manual'))
    );

    if (!confirmed) return;

    setIsRestarting(true);
    try {
      const result = await apiService.restartContainer();
      showToast(result.message, 'success');

      if (isDocker) {
        // Wait a few seconds, then reload the page
        setTimeout(() => {
          window.location.reload();
        }, 5000);
      }
    } catch (error) {
      logger.error(`Error ${action}ing:`, error);
      showToast(t('settings.restart_failed', { action }), 'error');
      setIsRestarting(false);
    }
  };

  if (isDocker === null) return null;

  return (
    <div id="settings-system" className="settings-section">
      <h3>{t('settings.system_section', 'Restart / Shutdown')}</h3>
      <div className="danger-action">
        <div className="danger-action-info">
          <h4>{isDocker ? t('settings.restart_container_title') : t('settings.shutdown_title')}</h4>
          <p>
            {isDocker
              ? t('settings.restart_container_description')
              : t('settings.shutdown_description')}
          </p>
        </div>
        <button
          className="danger-button"
          onClick={handleRestartContainer}
          disabled={isRestarting}
        >
          {isRestarting
            ? (isDocker ? t('settings.restarting') : t('settings.shutting_down'))
            : <><UiIcon name={isDocker ? 'refresh' : 'power'} /> {isDocker ? t('settings.restart_button') : t('settings.shutdown_button')}</>}
        </button>
      </div>
    </div>
  );
}
