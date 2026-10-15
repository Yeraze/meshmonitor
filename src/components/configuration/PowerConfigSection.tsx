import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { ConfigSection } from '../shared/config/ConfigSection';

interface PowerConfigSectionProps {
  /** False disables every control: no configuration:write on this source (#5830). */
  canWrite?: boolean;
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
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
  /** Bumped when the page reloads config from the node (#5797). */
  configVersion?: number;
}

const PowerConfigSection: React.FC<PowerConfigSectionProps> = ({
  canWrite = true,
  configVersion,
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

  // What the node holds; moves on a successful save or a reload (#5797)
  const values = {
    isPowerSaving, onBatteryShutdownAfterSecs, adcMultiplierOverride,
    waitBluetoothSecs, sdsSecs, lsSecs, minWakeSecs, deviceBatteryInaAddress
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values, { reseedKey: configVersion });

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setIsPowerSaving(baseline.isPowerSaving);
    setOnBatteryShutdownAfterSecs(baseline.onBatteryShutdownAfterSecs);
    setAdcMultiplierOverride(baseline.adcMultiplierOverride);
    setWaitBluetoothSecs(baseline.waitBluetoothSecs);
    setSdsSecs(baseline.sdsSecs);
    setLsSecs(baseline.lsSecs);
    setMinWakeSecs(baseline.minWakeSecs);
    setDeviceBatteryInaAddress(baseline.deviceBatteryInaAddress);
  }, [baseline, setIsPowerSaving, setOnBatteryShutdownAfterSecs, setAdcMultiplierOverride,
      setWaitBluetoothSecs, setSdsSecs, setLsSecs, setMinWakeSecs, setDeviceBatteryInaAddress]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'power-config',
    sectionName: t('power_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  // Convert seconds to human-readable format
  const formatDuration = (seconds: number): string => {
    if (seconds === 0) return t('power_config.disabled');
    if (seconds < 60) return `${seconds} ${t('common.seconds')}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} ${t('common.minutes')}`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ${t('common.hours')}`;
    return `${Math.floor(seconds / 86400)} ${t('common.days')}`;
  };

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection canWrite={canWrite} title={t('power_config.title')} docsUrl="https://meshmonitor.org/features/device#power-configuration">

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
        <NumberInput
          id="onBatteryShutdownAfterSecs"
          min={0}
          max={4294967295}
          integer
          value={onBatteryShutdownAfterSecs}
          onChange={setOnBatteryShutdownAfterSecs}
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
        <NumberInput
          id="adcMultiplierOverride"
          min={0}
          max={10}
          step={0.01}
          value={adcMultiplierOverride}
          onChange={setAdcMultiplierOverride}
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
        <NumberInput
          id="waitBluetoothSecs"
          min={0}
          max={4294967295}
          integer
          value={waitBluetoothSecs}
          onChange={setWaitBluetoothSecs}
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
        <NumberInput
          id="sdsSecs"
          min={0}
          max={4294967295}
          integer
          value={sdsSecs}
          onChange={setSdsSecs}
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
        <NumberInput
          id="lsSecs"
          min={0}
          max={4294967295}
          integer
          value={lsSecs}
          onChange={setLsSecs}
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
        <NumberInput
          id="minWakeSecs"
          min={0}
          max={4294967295}
          integer
          value={minWakeSecs}
          onChange={setMinWakeSecs}
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
            border: '1px solid var(--color-surface-active)',
            color: 'var(--color-text-subtle)',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          <span><UiIcon name={showAdvanced ? 'chevronDown' : 'forward'} /></span>
          {t('power_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--color-surface-active)'
        }}>
          {/* INA Battery Address */}
          <div className="setting-item">
            <label htmlFor="deviceBatteryInaAddress">
              {t('power_config.ina_address')}
              <span className="setting-description">{t('power_config.ina_address_description')}</span>
            </label>
            <NumberInput
              id="deviceBatteryInaAddress"
              min={0}
              max={127}
              integer
              value={deviceBatteryInaAddress}
              onChange={setDeviceBatteryInaAddress}
              className="setting-input"
              placeholder="0"
            />
          </div>
        </div>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default PowerConfigSection;
