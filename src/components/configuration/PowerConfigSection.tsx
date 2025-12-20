import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface PowerConfigSectionProps {
  // Power saving
  isPowerSaving: boolean;
  setIsPowerSaving: (value: boolean) => void;
  // Shutdown
  onBatteryShutdownAfterSecs: number;
  setOnBatteryShutdownAfterSecs: (value: number) => void;
  // Battery calibration
  adcMultiplierOverride: number;
  setAdcMultiplierOverride: (value: number) => void;
  // ESP32 specific
  waitBluetoothSecs: number;
  setWaitBluetoothSecs: (value: number) => void;
  sdsSecs: number;
  setSdsSecs: (value: number) => void;
  lsSecs: number;
  setLsSecs: (value: number) => void;
  minWakeSecs: number;
  setMinWakeSecs: (value: number) => void;
  // Advanced
  deviceBatteryInaAddress: number;
  setDeviceBatteryInaAddress: (value: number) => void;
  // UI state
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const PowerConfigSection: React.FC<PowerConfigSectionProps> = ({
  isPowerSaving,
  setIsPowerSaving,
  onBatteryShutdownAfterSecs,
  setOnBatteryShutdownAfterSecs,
  adcMultiplierOverride,
  setAdcMultiplierOverride,
  waitBluetoothSecs,
  setWaitBluetoothSecs,
  sdsSecs,
  setSdsSecs,
  lsSecs,
  setLsSecs,
  minWakeSecs,
  setMinWakeSecs,
  deviceBatteryInaAddress,
  setDeviceBatteryInaAddress,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Convert seconds to human-readable format
  const formatDuration = (seconds: number): string => {
    if (seconds === 0) return t('power_config.disabled');
    if (seconds < 60) return `${seconds} ${t('common.seconds')}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} ${t('common.minutes')}`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ${t('common.hours')}`;
    return `${Math.floor(seconds / 86400)} ${t('common.days')}`;
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('power_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/radio/power/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('power_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Power Saving Mode */}
      <div className="setting-item">
        <label htmlFor="isPowerSaving">
          {t('power_config.power_saving')}
          <span className="setting-description">{t('power_config.power_saving_description')}</span>
        </label>
        <input
          id="isPowerSaving"
          type="checkbox"
          checked={isPowerSaving}
          onChange={(e) => setIsPowerSaving(e.target.checked)}
          className="setting-checkbox"
        />
      </div>

      {/* On Battery Shutdown */}
      <div className="setting-item">
        <label htmlFor="onBatteryShutdownAfterSecs">
          {t('power_config.shutdown_on_battery')}
          <span className="setting-description">
            {t('power_config.shutdown_on_battery_description')}
            {onBatteryShutdownAfterSecs > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(onBatteryShutdownAfterSecs)})
              </span>
            )}
          </span>
        </label>
        <input
          id="onBatteryShutdownAfterSecs"
          type="number"
          min="0"
          max="4294967295"
          value={onBatteryShutdownAfterSecs}
          onChange={(e) => setOnBatteryShutdownAfterSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="0"
        />
      </div>

      {/* ADC Multiplier Override */}
      <div className="setting-item">
        <label htmlFor="adcMultiplierOverride">
          {t('power_config.adc_multiplier')}
          <span className="setting-description">{t('power_config.adc_multiplier_description')}</span>
        </label>
        <input
          id="adcMultiplierOverride"
          type="number"
          min="0"
          max="10"
          step="0.01"
          value={adcMultiplierOverride}
          onChange={(e) => setAdcMultiplierOverride(parseFloat(e.target.value) || 0)}
          className="setting-input"
          placeholder="0"
        />
      </div>

      {/* Bluetooth Wait Time (ESP32) */}
      <div className="setting-item">
        <label htmlFor="waitBluetoothSecs">
          {t('power_config.bluetooth_wait')}
          <span className="setting-description">
            {t('power_config.bluetooth_wait_description')}
            {waitBluetoothSecs > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(waitBluetoothSecs)})
              </span>
            )}
          </span>
        </label>
        <input
          id="waitBluetoothSecs"
          type="number"
          min="0"
          max="4294967295"
          value={waitBluetoothSecs}
          onChange={(e) => setWaitBluetoothSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="60"
        />
      </div>

      {/* Super Deep Sleep (ESP32) */}
      <div className="setting-item">
        <label htmlFor="sdsSecs">
          {t('power_config.super_deep_sleep')}
          <span className="setting-description">
            {t('power_config.super_deep_sleep_description')}
            {sdsSecs > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(sdsSecs)})
              </span>
            )}
          </span>
        </label>
        <input
          id="sdsSecs"
          type="number"
          min="0"
          max="4294967295"
          value={sdsSecs}
          onChange={(e) => setSdsSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="31536000"
        />
      </div>

      {/* Light Sleep (ESP32) */}
      <div className="setting-item">
        <label htmlFor="lsSecs">
          {t('power_config.light_sleep')}
          <span className="setting-description">
            {t('power_config.light_sleep_description')}
            {lsSecs > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(lsSecs)})
              </span>
            )}
          </span>
        </label>
        <input
          id="lsSecs"
          type="number"
          min="0"
          max="4294967295"
          value={lsSecs}
          onChange={(e) => setLsSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="300"
        />
      </div>

      {/* Minimum Wake Time (ESP32) */}
      <div className="setting-item">
        <label htmlFor="minWakeSecs">
          {t('power_config.min_wake')}
          <span className="setting-description">{t('power_config.min_wake_description')}</span>
        </label>
        <input
          id="minWakeSecs"
          type="number"
          min="0"
          max="4294967295"
          value={minWakeSecs}
          onChange={(e) => setMinWakeSecs(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="10"
        />
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
          {t('power_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--ctp-surface2)'
        }}>
          {/* INA Battery Address */}
          <div className="setting-item">
            <label htmlFor="deviceBatteryInaAddress">
              {t('power_config.ina_address')}
              <span className="setting-description">{t('power_config.ina_address_description')}</span>
            </label>
            <input
              id="deviceBatteryInaAddress"
              type="number"
              min="0"
              max="127"
              value={deviceBatteryInaAddress}
              onChange={(e) => setDeviceBatteryInaAddress(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="0"
            />
          </div>
        </div>
      )}

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('power_config.save_button')}
      </button>
    </div>
  );
};

export default PowerConfigSection;
