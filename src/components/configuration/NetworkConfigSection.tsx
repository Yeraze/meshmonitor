import React from 'react';
import { useTranslation } from 'react-i18next';

interface NetworkConfigSectionProps {
  wifiEnabled: boolean;
  ntpServer: string;
  setNtpServer: (value: string) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const NetworkConfigSection: React.FC<NetworkConfigSectionProps> = ({
  wifiEnabled,
  ntpServer,
  setNtpServer,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // Only show this section if WiFi is enabled on the device
  if (!wifiEnabled) {
    return null;
  }

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('network_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/radio/network/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('network_config.view_docs')}
        >
          ?
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="ntpServer">
          {t('network_config.ntp_server')}
          <span className="setting-description">{t('network_config.ntp_server_description')}</span>
        </label>
        <input
          id="ntpServer"
          type="text"
          value={ntpServer}
          onChange={(e) => setNtpServer(e.target.value)}
          placeholder="meshtastic.pool.ntp.org"
          maxLength={33}
          className="setting-input"
          style={{ width: '400px' }}
        />
      </div>
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('network_config.save_button')}
      </button>
    </div>
  );
};

export default NetworkConfigSection;
