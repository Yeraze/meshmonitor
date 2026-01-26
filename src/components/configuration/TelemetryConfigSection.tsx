import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface TelemetryConfigSectionProps {
  // Device Telemetry
  deviceUpdateInterval: number;
  setDeviceUpdateInterval: (value: number) => void;
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
  // UI state
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const TelemetryConfigSection: React.FC<TelemetryConfigSectionProps> = ({
  deviceUpdateInterval,
  setDeviceUpdateInterval,
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
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Track initial values for change detection
  const initialValuesRef = useRef({
    deviceUpdateInterval, environmentUpdateInterval, environmentMeasurementEnabled,
    environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
    airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      deviceUpdateInterval !== initial.deviceUpdateInterval ||
      environmentUpdateInterval !== initial.environmentUpdateInterval ||
      environmentMeasurementEnabled !== initial.environmentMeasurementEnabled ||
      environmentScreenEnabled !== initial.environmentScreenEnabled ||
      environmentDisplayFahrenheit !== initial.environmentDisplayFahrenheit ||
      airQualityEnabled !== initial.airQualityEnabled ||
      airQualityInterval !== initial.airQualityInterval ||
      powerMeasurementEnabled !== initial.powerMeasurementEnabled ||
      powerUpdateInterval !== initial.powerUpdateInterval ||
      powerScreenEnabled !== initial.powerScreenEnabled
    );
  }, [deviceUpdateInterval, environmentUpdateInterval, environmentMeasurementEnabled,
      environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
      airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setDeviceUpdateInterval(initial.deviceUpdateInterval);
    setEnvironmentUpdateInterval(initial.environmentUpdateInterval);
    setEnvironmentMeasurementEnabled(initial.environmentMeasurementEnabled);
    setEnvironmentScreenEnabled(initial.environmentScreenEnabled);
    setEnvironmentDisplayFahrenheit(initial.environmentDisplayFahrenheit);
    setAirQualityEnabled(initial.airQualityEnabled);
    setAirQualityInterval(initial.airQualityInterval);
    setPowerMeasurementEnabled(initial.powerMeasurementEnabled);
    setPowerUpdateInterval(initial.powerUpdateInterval);
    setPowerScreenEnabled(initial.powerScreenEnabled);
  }, [setDeviceUpdateInterval, setEnvironmentUpdateInterval, setEnvironmentMeasurementEnabled,
      setEnvironmentScreenEnabled, setEnvironmentDisplayFahrenheit, setAirQualityEnabled,
      setAirQualityInterval, setPowerMeasurementEnabled, setPowerUpdateInterval, setPowerScreenEnabled]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      deviceUpdateInterval, environmentUpdateInterval, environmentMeasurementEnabled,
      environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
      airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled
    };
  }, [onSave, deviceUpdateInterval, environmentUpdateInterval, environmentMeasurementEnabled,
      environmentScreenEnabled, environmentDisplayFahrenheit, airQualityEnabled,
      airQualityInterval, powerMeasurementEnabled, powerUpdateInterval, powerScreenEnabled]);

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

      {/* Device Update Interval */}
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
        </div>
      )}
    </div>
  );
};

export default TelemetryConfigSection;
