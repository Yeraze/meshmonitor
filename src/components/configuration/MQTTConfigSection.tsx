import React from 'react';
import { useTranslation } from 'react-i18next';

interface MQTTConfigSectionProps {
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttJsonEnabled: boolean;
  mqttRoot: string;
  setMqttEnabled: (value: boolean) => void;
  setMqttAddress: (value: string) => void;
  setMqttUsername: (value: string) => void;
  setMqttPassword: (value: string) => void;
  setMqttEncryptionEnabled: (value: boolean) => void;
  setMqttJsonEnabled: (value: boolean) => void;
  setMqttRoot: (value: string) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const MQTTConfigSection: React.FC<MQTTConfigSectionProps> = ({
  mqttEnabled,
  mqttAddress,
  mqttUsername,
  mqttPassword,
  mqttEncryptionEnabled,
  mqttJsonEnabled,
  mqttRoot,
  setMqttEnabled,
  setMqttAddress,
  setMqttUsername,
  setMqttPassword,
  setMqttEncryptionEnabled,
  setMqttJsonEnabled,
  setMqttRoot,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('mqtt_config.title')}
        <a
          href="https://meshmonitor.org/features/device#mqtt-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('mqtt_config.view_docs')}
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="mqttEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="mqttEnabled"
            type="checkbox"
            checked={mqttEnabled}
            onChange={(e) => setMqttEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('mqtt_config.enable')}</div>
            <span className="setting-description">{t('mqtt_config.enable_description')}</span>
          </div>
        </label>
      </div>
      {mqttEnabled && (
        <>
          <div className="setting-item">
            <label htmlFor="mqttAddress">
              {t('mqtt_config.server_address')}
              <span className="setting-description">{t('mqtt_config.server_address_description')}</span>
            </label>
            <input
              id="mqttAddress"
              type="text"
              value={mqttAddress}
              onChange={(e) => setMqttAddress(e.target.value)}
              className="setting-input"
              placeholder="mqtt.meshtastic.org"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttUsername">
              {t('mqtt_config.username')}
              <span className="setting-description">{t('mqtt_config.username_description')}</span>
            </label>
            <input
              id="mqttUsername"
              type="text"
              value={mqttUsername}
              onChange={(e) => setMqttUsername(e.target.value)}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttPassword">
              {t('mqtt_config.password')}
              <span className="setting-description">{t('mqtt_config.password_description')}</span>
            </label>
            <input
              id="mqttPassword"
              type="password"
              value={mqttPassword}
              onChange={(e) => setMqttPassword(e.target.value)}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttRoot">
              {t('mqtt_config.root_topic')}
              <span className="setting-description">{t('mqtt_config.root_topic_description')}</span>
            </label>
            <input
              id="mqttRoot"
              type="text"
              value={mqttRoot}
              onChange={(e) => setMqttRoot(e.target.value)}
              className="setting-input"
              placeholder="msh/US"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="mqttEncryption" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttEncryption"
                type="checkbox"
                checked={mqttEncryptionEnabled}
                onChange={(e) => setMqttEncryptionEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.encryption_enabled')}</div>
                <span className="setting-description">{t('mqtt_config.encryption_description')}</span>
              </div>
            </label>
          </div>
          <div className="setting-item">
            <label htmlFor="mqttJson" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="mqttJson"
                type="checkbox"
                checked={mqttJsonEnabled}
                onChange={(e) => setMqttJsonEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('mqtt_config.json_enabled')}</div>
                <span className="setting-description">{t('mqtt_config.json_description')}</span>
              </div>
            </label>
          </div>
        </>
      )}
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('mqtt_config.save_button')}
      </button>
    </div>
  );
};

export default MQTTConfigSection;
