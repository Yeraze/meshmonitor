import React from 'react';
import { useTranslation } from 'react-i18next';

interface StoreForwardConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  heartbeat: boolean;
  setHeartbeat: (value: boolean) => void;
  records: number;
  setRecords: (value: number) => void;
  historyReturnMax: number;
  setHistoryReturnMax: (value: number) => void;
  historyReturnWindow: number;
  setHistoryReturnWindow: (value: number) => void;
  isServer: boolean;
  setIsServer: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const StoreForwardConfigSection: React.FC<StoreForwardConfigSectionProps> = ({
  enabled,
  setEnabled,
  heartbeat,
  setHeartbeat,
  records,
  setRecords,
  historyReturnMax,
  setHistoryReturnMax,
  historyReturnWindow,
  setHistoryReturnWindow,
  isServer,
  setIsServer,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('storeforward_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/store-and-forward/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('storeforward_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="storeforwardEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="storeforwardEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('storeforward_config.enabled')}</div>
            <span className="setting-description">{t('storeforward_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Is Server */}
          <div className="setting-item">
            <label htmlFor="storeforwardIsServer" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="storeforwardIsServer"
                type="checkbox"
                checked={isServer}
                onChange={(e) => setIsServer(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('storeforward_config.is_server')}</div>
                <span className="setting-description">{t('storeforward_config.is_server_description')}</span>
              </div>
            </label>
          </div>

          {/* Heartbeat */}
          <div className="setting-item">
            <label htmlFor="storeforwardHeartbeat" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="storeforwardHeartbeat"
                type="checkbox"
                checked={heartbeat}
                onChange={(e) => setHeartbeat(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('storeforward_config.heartbeat')}</div>
                <span className="setting-description">{t('storeforward_config.heartbeat_description')}</span>
              </div>
            </label>
          </div>

          {/* Records */}
          <div className="setting-item">
            <label htmlFor="storeforwardRecords">
              {t('storeforward_config.records')}
              <span className="setting-description">{t('storeforward_config.records_description')}</span>
            </label>
            <input
              id="storeforwardRecords"
              type="number"
              min="0"
              max="65535"
              value={records}
              onChange={(e) => setRecords(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="0"
            />
          </div>

          {/* History Return Max */}
          <div className="setting-item">
            <label htmlFor="storeforwardHistoryReturnMax">
              {t('storeforward_config.history_return_max')}
              <span className="setting-description">{t('storeforward_config.history_return_max_description')}</span>
            </label>
            <input
              id="storeforwardHistoryReturnMax"
              type="number"
              min="0"
              max="255"
              value={historyReturnMax}
              onChange={(e) => setHistoryReturnMax(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="0"
            />
          </div>

          {/* History Return Window */}
          <div className="setting-item">
            <label htmlFor="storeforwardHistoryReturnWindow">
              {t('storeforward_config.history_return_window')}
              <span className="setting-description">{t('storeforward_config.history_return_window_description')}</span>
            </label>
            <input
              id="storeforwardHistoryReturnWindow"
              type="number"
              min="0"
              max="86400"
              value={historyReturnWindow}
              onChange={(e) => setHistoryReturnWindow(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="0"
            />
          </div>
        </>
      )}

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('storeforward_config.save_button')}
      </button>
    </div>
  );
};

export default StoreForwardConfigSection;
