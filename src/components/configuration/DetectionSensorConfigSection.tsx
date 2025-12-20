import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Trigger type options matching protobuf enum
const TRIGGER_TYPE_OPTIONS = [
  { value: 0, name: 'LOGIC_LOW', description: 'Trigger when pin goes low' },
  { value: 1, name: 'LOGIC_HIGH', description: 'Trigger when pin goes high' },
  { value: 2, name: 'FALLING_EDGE', description: 'Trigger on falling edge' },
  { value: 3, name: 'RISING_EDGE', description: 'Trigger on rising edge' },
  { value: 4, name: 'EITHER_EDGE_ACTIVE_LOW', description: 'Either edge, active low' },
  { value: 5, name: 'EITHER_EDGE_ACTIVE_HIGH', description: 'Either edge, active high' }
];

interface DetectionSensorConfigSectionProps {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  minimumBroadcastSecs: number;
  setMinimumBroadcastSecs: (value: number) => void;
  stateBroadcastSecs: number;
  setStateBroadcastSecs: (value: number) => void;
  sendBell: boolean;
  setSendBell: (value: boolean) => void;
  name: string;
  setName: (value: string) => void;
  monitorPin: number;
  setMonitorPin: (value: number) => void;
  detectionTriggerType: number;
  setDetectionTriggerType: (value: number) => void;
  usePullup: boolean;
  setUsePullup: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const DetectionSensorConfigSection: React.FC<DetectionSensorConfigSectionProps> = ({
  enabled,
  setEnabled,
  minimumBroadcastSecs,
  setMinimumBroadcastSecs,
  stateBroadcastSecs,
  setStateBroadcastSecs,
  sendBell,
  setSendBell,
  name,
  setName,
  monitorPin,
  setMonitorPin,
  detectionTriggerType,
  setDetectionTriggerType,
  usePullup,
  setUsePullup,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('detectionsensor_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/detection-sensor/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('detectionsensor_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="detectionsensorEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="detectionsensorEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('detectionsensor_config.enabled')}</div>
            <span className="setting-description">{t('detectionsensor_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Sensor Name */}
          <div className="setting-item">
            <label htmlFor="detectionsensorName">
              {t('detectionsensor_config.name')}
              <span className="setting-description">{t('detectionsensor_config.name_description')}</span>
            </label>
            <input
              id="detectionsensorName"
              type="text"
              maxLength={20}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="setting-input"
              placeholder="Motion Sensor"
            />
          </div>

          {/* Monitor Pin */}
          <div className="setting-item">
            <label htmlFor="detectionsensorPin">
              {t('detectionsensor_config.monitor_pin')}
              <span className="setting-description">{t('detectionsensor_config.monitor_pin_description')}</span>
            </label>
            <input
              id="detectionsensorPin"
              type="number"
              min="0"
              max="255"
              value={monitorPin}
              onChange={(e) => setMonitorPin(parseInt(e.target.value) || 0)}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* Trigger Type */}
          <div className="setting-item">
            <label htmlFor="detectionsensorTriggerType">
              {t('detectionsensor_config.trigger_type')}
              <span className="setting-description">{t('detectionsensor_config.trigger_type_description')}</span>
            </label>
            <select
              id="detectionsensorTriggerType"
              value={detectionTriggerType}
              onChange={(e) => setDetectionTriggerType(parseInt(e.target.value))}
              className="setting-input"
            >
              {TRIGGER_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name} - {option.description}
                </option>
              ))}
            </select>
          </div>

          {/* Use Pullup */}
          <div className="setting-item">
            <label htmlFor="detectionsensorPullup" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="detectionsensorPullup"
                type="checkbox"
                checked={usePullup}
                onChange={(e) => setUsePullup(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('detectionsensor_config.use_pullup')}</div>
                <span className="setting-description">{t('detectionsensor_config.use_pullup_description')}</span>
              </div>
            </label>
          </div>

          {/* Send Bell */}
          <div className="setting-item">
            <label htmlFor="detectionsensorSendBell" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="detectionsensorSendBell"
                type="checkbox"
                checked={sendBell}
                onChange={(e) => setSendBell(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('detectionsensor_config.send_bell')}</div>
                <span className="setting-description">{t('detectionsensor_config.send_bell_description')}</span>
              </div>
            </label>
          </div>

          {/* Advanced Section Toggle */}
          <div className="setting-item">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="advanced-toggle-btn"
              style={{
                background: 'transparent',
                border: '1px solid var(--ctp-surface2)',
                color: 'var(--ctp-subtext0)',
                padding: '0.5rem 1rem',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <span>{showAdvanced ? '▼' : '▶'}</span>
              {t('detectionsensor_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)'
            }}>
              {/* Minimum Broadcast Interval */}
              <div className="setting-item">
                <label htmlFor="detectionsensorMinBroadcast">
                  {t('detectionsensor_config.min_broadcast_secs')}
                  <span className="setting-description">{t('detectionsensor_config.min_broadcast_secs_description')}</span>
                </label>
                <input
                  id="detectionsensorMinBroadcast"
                  type="number"
                  min="0"
                  max="86400"
                  value={minimumBroadcastSecs}
                  onChange={(e) => setMinimumBroadcastSecs(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  placeholder="0"
                />
              </div>

              {/* State Broadcast Interval */}
              <div className="setting-item">
                <label htmlFor="detectionsensorStateBroadcast">
                  {t('detectionsensor_config.state_broadcast_secs')}
                  <span className="setting-description">{t('detectionsensor_config.state_broadcast_secs_description')}</span>
                </label>
                <input
                  id="detectionsensorStateBroadcast"
                  type="number"
                  min="0"
                  max="86400"
                  value={stateBroadcastSecs}
                  onChange={(e) => setStateBroadcastSecs(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  placeholder="0"
                />
              </div>
            </div>
          )}
        </>
      )}

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('detectionsensor_config.save_button')}
      </button>
    </div>
  );
};

export default DetectionSensorConfigSection;
