import React, { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface TelemetryConfigSectionProps {
  // Config version - increment when config is loaded from device to sync saved state
  configVersion?: number;
  // Device Telemetry
  deviceUpdateInterval: number;
  setDeviceUpdateInterval: (value: number) => void;
  deviceTelemetryEnabled: boolean;
  setDeviceTelemetryEnabled: (value: boolean) => void;
  // Environment Telemetry
  environmentUpdateInterval: number;
  setEnvironmentUpdateInterval: (value: number) => void;
  environmentMeasurementEnabled: boolean;
  setEnvironmentMeasurementEnabled: (value: boolean) => void;
  environmentScreenEnabled: boolean;
  setEnvironmentScreenEnabled: (value: boolean) => void;
  environmentDisplayFahrenheit: boolean;
  setEnvironmentDisplayFahrenheit: (value: boolean) => void;
  // Air Quality
  airQualityEnabled: boolean;
  setAirQualityEnabled: (value: boolean) => void;
  airQualityInterval: number;
  setAirQualityInterval: (value: number) => void;
  // Power Metrics
  powerMeasurementEnabled: boolean;
  setPowerMeasurementEnabled: (value: boolean) => void;
  powerUpdateInterval: number;
  setPowerUpdateInterval: (value: number) => void;
  powerScreenEnabled: boolean;
  setPowerScreenEnabled: (value: boolean) => void;
  // Health Metrics
  healthMeasurementEnabled: boolean;
  setHealthMeasurementEnabled: (value: boolean) => void;
  healthUpdateInterval: number;
  setHealthUpdateInterval: (value: number) => void;
  healthScreenEnabled: boolean;
  setHealthScreenEnabled: (value: boolean) => void;
  // UI state
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const TelemetryConfigSection: React.FC<TelemetryConfigSectionProps> = ({
  configVersion,
  deviceUpdateInterval,
  setDeviceUpdateInterval,
  deviceTelemetryEnabled,
  setDeviceTelemetryEnabled,
  environmentUpdateInterval,
  setEnvironmentUpdateInterval,
  environmentMeasurementEnabled,
  setEnvironmentMeasurementEnabled,
  environmentScreenEnabled,
  setEnvironmentScreenEnabled,
  environmentDisplayFahrenheit,
  setEnvironmentDisplayFahrenheit,
  airQualityEnabled,
  setAirQualityEnabled,
  airQualityInterval,
  setAirQualityInterval,
  powerMeasurementEnabled,
  setPowerMeasurementEnabled,
  powerUpdateInterval,
  setPowerUpdateInterval,
  powerScreenEnabled,
  setPowerScreenEnabled,
  healthMeasurementEnabled,
  setHealthMeasurementEnabled,
  healthUpdateInterval,
  setHealthUpdateInterval,
  healthScreenEnabled,
  setHealthScreenEnabled,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Store "saved" values as state - these represent what's on the device
  const [savedValues, setSavedValues] = useState({
    deviceUpdateInterval, deviceTelemetryEnabled, environmentUpdateInterval, environmentMeasurementEnabled,
    environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
    airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled,
    healthMeasurementEnabled, healthUpdateInterval, healthScreenEnabled
  });

  // Sync savedValues when config is loaded from device (configVersion changes)
  useEffect(() => {
    if (configVersion !== undefined) {
      setSavedValues({
        deviceUpdateInterval, deviceTelemetryEnabled, environmentUpdateInterval, environmentMeasurementEnabled,
        environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
        airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled,
        healthMeasurementEnabled, healthUpdateInterval, healthScreenEnabled
      });
    }
  }, [configVersion]); // Only trigger on configVersion change, not on prop changes

  // Calculate if there are unsaved changes by comparing current props to saved values
  const hasChanges =
    deviceUpdateInterval !== savedValues.deviceUpdateInterval ||
    deviceTelemetryEnabled !== savedValues.deviceTelemetryEnabled ||
    environmentUpdateInterval !== savedValues.environmentUpdateInterval ||
    environmentMeasurementEnabled !== savedValues.environmentMeasurementEnabled ||
    environmentScreenEnabled !== savedValues.environmentScreenEnabled ||
    environmentDisplayFahrenheit !== savedValues.environmentDisplayFahrenheit ||
    airQualityEnabled !== savedValues.airQualityEnabled ||
    airQualityInterval !== savedValues.airQualityInterval ||
    powerMeasurementEnabled !== savedValues.powerMeasurementEnabled ||
    powerUpdateInterval !== savedValues.powerUpdateInterval ||
    powerScreenEnabled !== savedValues.powerScreenEnabled ||
    healthMeasurementEnabled !== savedValues.healthMeasurementEnabled ||
    healthUpdateInterval !== savedValues.healthUpdateInterval ||
    healthScreenEnabled !== savedValues.healthScreenEnabled;

  // Reset to saved values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setDeviceUpdateInterval(savedValues.deviceUpdateInterval);
    setDeviceTelemetryEnabled(savedValues.deviceTelemetryEnabled);
    setEnvironmentUpdateInterval(savedValues.environmentUpdateInterval);
    setEnvironmentMeasurementEnabled(savedValues.environmentMeasurementEnabled);
    setEnvironmentScreenEnabled(savedValues.environmentScreenEnabled);
    setEnvironmentDisplayFahrenheit(savedValues.environmentDisplayFahrenheit);
    setAirQualityEnabled(savedValues.airQualityEnabled);
    setAirQualityInterval(savedValues.airQualityInterval);
    setPowerMeasurementEnabled(savedValues.powerMeasurementEnabled);
    setPowerUpdateInterval(savedValues.powerUpdateInterval);
    setPowerScreenEnabled(savedValues.powerScreenEnabled);
    setHealthMeasurementEnabled(savedValues.healthMeasurementEnabled);
    setHealthUpdateInterval(savedValues.healthUpdateInterval);
    setHealthScreenEnabled(savedValues.healthScreenEnabled);
  }, [savedValues, setDeviceUpdateInterval, setDeviceTelemetryEnabled, setEnvironmentUpdateInterval, setEnvironmentMeasurementEnabled,
      setEnvironmentScreenEnabled, setEnvironmentDisplayFahrenheit, setAirQualityEnabled,
      setAirQualityInterval, setPowerMeasurementEnabled, setPowerUpdateInterval, setPowerScreenEnabled,
      setHealthMeasurementEnabled, setHealthUpdateInterval, setHealthScreenEnabled]);

  // Update saved values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    // Update savedValues to match current props - this clears hasChanges
    setSavedValues({
      deviceUpdateInterval, deviceTelemetryEnabled, environmentUpdateInterval, environmentMeasurementEnabled,
      environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
      airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled,
      healthMeasurementEnabled, healthUpdateInterval, healthScreenEnabled
    });
  }, [onSave, deviceUpdateInterval, deviceTelemetryEnabled, environmentUpdateInterval, environmentMeasurementEnabled,
      environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
      airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled,
      healthMeasurementEnabled, healthUpdateInterval, healthScreenEnabled]);

  // Register with SaveBar
  useSaveBar({
    id: 'telemetry-config',
    sectionName: t('telemetry_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  // Convert seconds to human-readable format
  const formatDuration = (seconds: number): string => {
    if (seconds === 0) return t('telemetry_config.disabled');
    if (seconds < 60) return `${seconds} ${t('common.seconds')}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} ${t('common.minutes')}`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ${t('common.hours')}`;
    return `${Math.floor(seconds / 86400)} ${t('common.days')}`;
  };

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('telemetry_config.title')}
        <a
          href="https://meshmonitor.org/features/device#telemetry-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('telemetry_config.view_docs')}
        >
          ❓
        </a>
      </h3>

      {/* Device Telemetry Section */}
      <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
        {t('telemetry_config.device_section')}
      </h4>

      {/* Device Telemetry Enabled */}
      <div className="setting-item">
        <label htmlFor="deviceTelemetryEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="deviceTelemetryEnabled"
            type="checkbox"
            checked={deviceTelemetryEnabled}
            onChange={(e) => setDeviceTelemetryEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('telemetry_config.device_enabled')}</div>
            <span className="setting-description">{t('telemetry_config.device_enabled_description')}</span>
          </div>
        </label>
      </div>

      {/* Device Update Interval */}
      {deviceTelemetryEnabled && (
        <div className="setting-item">
          <label htmlFor="deviceUpdateInterval">
            {t('telemetry_config.device_interval')}
            <span className="setting-description">
              {t('telemetry_config.device_interval_description')}
              {deviceUpdateInterval > 0 && (
                <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                  ({formatDuration(deviceUpdateInterval)})
                </span>
              )}
            </span>
          </label>
          <input
            id="deviceUpdateInterval"
            type="number"
            min="0"
            max="4294967295"
            value={deviceUpdateInterval}
            onChange={(e) => setDeviceUpdateInterval(parseInt(e.target.value) || 0)}
            className="setting-input"
            placeholder="900"
          />
        </div>
      )}

      {/* Environment Telemetry Section */}
      <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
        {t('telemetry_config.environment_section')}
      </h4>

      {/* Environment Measurement Enabled */}
      <div className="setting-item">
        <label htmlFor="environmentMeasurementEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="environmentMeasurementEnabled"
            type="checkbox"
            checked={environmentMeasurementEnabled}
            onChange={(e) => setEnvironmentMeasurementEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('telemetry_config.environment_enabled')}</div>
            <span className="setting-description">{t('telemetry_config.environment_enabled_description')}</span>
          </div>
        </label>
      </div>

      {/* Environment Update Interval */}
      <div className="setting-item">
        <label htmlFor="environmentUpdateInterval">
          {t('telemetry_config.environment_interval')}
          <span className="setting-description">
            {t('telemetry_config.environment_interval_description')}
            {environmentUpdateInterval > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                ({formatDuration(environmentUpdateInterval)})
              </span>
            )}
          </span>
        </label>
        <input
          id="environmentUpdateInterval"
          type="number"
          min="0"
          max="4294967295"
          value={environmentUpdateInterval}
          onChange={(e) => setEnvironmentUpdateInterval(parseInt(e.target.value) || 0)}
          className="setting-input"
          placeholder="900"
        />
      </div>

      {/* Environment Screen Enabled */}
      <div className="setting-item">
        <label htmlFor="environmentScreenEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="environmentScreenEnabled"
            type="checkbox"
            checked={environmentScreenEnabled}
            onChange={(e) => setEnvironmentScreenEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('telemetry_config.environment_screen')}</div>
            <span className="setting-description">{t('telemetry_config.environment_screen_description')}</span>
          </div>
        </label>
      </div>

      {/* Environment Display Fahrenheit */}
      <div className="setting-item">
        <label htmlFor="environmentDisplayFahrenheit" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="environmentDisplayFahrenheit"
            type="checkbox"
            checked={environmentDisplayFahrenheit}
            onChange={(e) => setEnvironmentDisplayFahrenheit(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('telemetry_config.environment_fahrenheit')}</div>
            <span className="setting-description">{t('telemetry_config.environment_fahrenheit_description')}</span>
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
          {t('telemetry_config.advanced_settings')}
        </button>
      </div>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="advanced-section" style={{
          marginLeft: '1rem',
          paddingLeft: '1rem',
          borderLeft: '2px solid var(--ctp-surface2)'
        }}>
          {/* Air Quality Section */}
          <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
            {t('telemetry_config.air_quality_section')}
          </h4>

          {/* Air Quality Enabled */}
          <div className="setting-item">
            <label htmlFor="airQualityEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="airQualityEnabled"
                type="checkbox"
                checked={airQualityEnabled}
                onChange={(e) => setAirQualityEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.air_quality_enabled')}</div>
                <span className="setting-description">{t('telemetry_config.air_quality_enabled_description')}</span>
              </div>
            </label>
          </div>

          {/* Air Quality Interval */}
          <div className="setting-item">
            <label htmlFor="airQualityInterval">
              {t('telemetry_config.air_quality_interval')}
              <span className="setting-description">
                {t('telemetry_config.air_quality_interval_description')}
                {airQualityInterval > 0 && (
                  <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                    ({formatDuration(airQualityInterval)})
                  </span>
                )}
              </span>
            </label>
            <input
              id="airQualityInterval"
              type="number"
              min="0"
              max="4294967295"
              value={airQualityInterval}
              onChange={(e) => setAirQualityInterval(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="900"
            />
          </div>

          {/* Power Metrics Section */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
            {t('telemetry_config.power_section')}
          </h4>

          {/* Power Measurement Enabled */}
          <div className="setting-item">
            <label htmlFor="powerMeasurementEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="powerMeasurementEnabled"
                type="checkbox"
                checked={powerMeasurementEnabled}
                onChange={(e) => setPowerMeasurementEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.power_enabled')}</div>
                <span className="setting-description">{t('telemetry_config.power_enabled_description')}</span>
              </div>
            </label>
          </div>

          {/* Power Update Interval */}
          <div className="setting-item">
            <label htmlFor="powerUpdateInterval">
              {t('telemetry_config.power_interval')}
              <span className="setting-description">
                {t('telemetry_config.power_interval_description')}
                {powerUpdateInterval > 0 && (
                  <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                    ({formatDuration(powerUpdateInterval)})
                  </span>
                )}
              </span>
            </label>
            <input
              id="powerUpdateInterval"
              type="number"
              min="0"
              max="4294967295"
              value={powerUpdateInterval}
              onChange={(e) => setPowerUpdateInterval(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="900"
            />
          </div>

          {/* Power Screen Enabled */}
          <div className="setting-item">
            <label htmlFor="powerScreenEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="powerScreenEnabled"
                type="checkbox"
                checked={powerScreenEnabled}
                onChange={(e) => setPowerScreenEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.power_screen')}</div>
                <span className="setting-description">{t('telemetry_config.power_screen_description')}</span>
              </div>
            </label>
          </div>

          {/* Health Metrics Section */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
            {t('telemetry_config.health_section')}
          </h4>

          {/* Health Measurement Enabled */}
          <div className="setting-item">
            <label htmlFor="healthMeasurementEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="healthMeasurementEnabled"
                type="checkbox"
                checked={healthMeasurementEnabled}
                onChange={(e) => setHealthMeasurementEnabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('telemetry_config.health_enabled')}</div>
                <span className="setting-description">{t('telemetry_config.health_enabled_description')}</span>
              </div>
            </label>
          </div>

          {/* Health Update Interval */}
          {healthMeasurementEnabled && (
            <>
              <div className="setting-item">
                <label htmlFor="healthUpdateInterval">
                  {t('telemetry_config.health_interval')}
                  <span className="setting-description">
                    {t('telemetry_config.health_interval_description')}
                    {healthUpdateInterval > 0 && (
                      <span style={{ marginLeft: '0.5rem', color: '#89b4fa' }}>
                        ({formatDuration(healthUpdateInterval)})
                      </span>
                    )}
                  </span>
                </label>
                <input
                  id="healthUpdateInterval"
                  type="number"
                  min="0"
                  max="4294967295"
                  value={healthUpdateInterval}
                  onChange={(e) => setHealthUpdateInterval(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  placeholder="900"
                />
              </div>

              {/* Health Screen Enabled */}
              <div className="setting-item">
                <label htmlFor="healthScreenEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="healthScreenEnabled"
                    type="checkbox"
                    checked={healthScreenEnabled}
                    onChange={(e) => setHealthScreenEnabled(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('telemetry_config.health_screen')}</div>
                    <span className="setting-description">{t('telemetry_config.health_screen_description')}</span>
                  </div>
                </label>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TelemetryConfigSection;
