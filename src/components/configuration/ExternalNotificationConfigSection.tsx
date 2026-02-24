import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';

interface ExternalNotificationConfigSectionProps {
  // Main settings
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  outputMs: number;
  setOutputMs: (value: number) => void;
  output: number;
  setOutput: (value: number) => void;
  active: boolean;
  setActive: (value: boolean) => void;
  // Alert settings
  alertMessage: boolean;
  setAlertMessage: (value: boolean) => void;
  alertMessageVibra: boolean;
  setAlertMessageVibra: (value: boolean) => void;
  alertMessageBuzzer: boolean;
  setAlertMessageBuzzer: (value: boolean) => void;
  alertBell: boolean;
  setAlertBell: (value: boolean) => void;
  alertBellVibra: boolean;
  setAlertBellVibra: (value: boolean) => void;
  alertBellBuzzer: boolean;
  setAlertBellBuzzer: (value: boolean) => void;
  // Advanced settings
  usePwm: boolean;
  setUsePwm: (value: boolean) => void;
  nagTimeout: number;
  setNagTimeout: (value: number) => void;
  useI2sAsBuzzer: boolean;
  setUseI2sAsBuzzer: (value: boolean) => void;
  outputVibra: number;
  setOutputVibra: (value: number) => void;
  outputBuzzer: number;
  setOutputBuzzer: (value: number) => void;
  // UI state
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const ExternalNotificationConfigSection: React.FC<ExternalNotificationConfigSectionProps> = ({
  enabled,
  setEnabled,
  outputMs,
  setOutputMs,
  output,
  setOutput,
  active,
  setActive,
  alertMessage,
  setAlertMessage,
  alertMessageVibra,
  setAlertMessageVibra,
  alertMessageBuzzer,
  setAlertMessageBuzzer,
  alertBell,
  setAlertBell,
  alertBellVibra,
  setAlertBellVibra,
  alertBellBuzzer,
  setAlertBellBuzzer,
  usePwm,
  setUsePwm,
  nagTimeout,
  setNagTimeout,
  useI2sAsBuzzer,
  setUseI2sAsBuzzer,
  outputVibra,
  setOutputVibra,
  outputBuzzer,
  setOutputBuzzer,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Track initial values for change detection
  const initialValuesRef = useRef({
    enabled, outputMs, output, active, alertMessage, alertMessageVibra, alertMessageBuzzer,
    alertBell, alertBellVibra, alertBellBuzzer, usePwm, nagTimeout,
    useI2sAsBuzzer, outputVibra, outputBuzzer
  });

  // Calculate if there are unsaved changes
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      outputMs !== initial.outputMs ||
      output !== initial.output ||
      active !== initial.active ||
      alertMessage !== initial.alertMessage ||
      alertMessageVibra !== initial.alertMessageVibra ||
      alertMessageBuzzer !== initial.alertMessageBuzzer ||
      alertBell !== initial.alertBell ||
      alertBellVibra !== initial.alertBellVibra ||
      alertBellBuzzer !== initial.alertBellBuzzer ||
      usePwm !== initial.usePwm ||
      nagTimeout !== initial.nagTimeout ||
      useI2sAsBuzzer !== initial.useI2sAsBuzzer ||
      outputVibra !== initial.outputVibra ||
      outputBuzzer !== initial.outputBuzzer
    );
  }, [enabled, outputMs, output, active, alertMessage, alertMessageVibra, alertMessageBuzzer,
      alertBell, alertBellVibra, alertBellBuzzer, usePwm, nagTimeout,
      useI2sAsBuzzer, outputVibra, outputBuzzer]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setOutputMs(initial.outputMs);
    setOutput(initial.output);
    setActive(initial.active);
    setAlertMessage(initial.alertMessage);
    setAlertMessageVibra(initial.alertMessageVibra);
    setAlertMessageBuzzer(initial.alertMessageBuzzer);
    setAlertBell(initial.alertBell);
    setAlertBellVibra(initial.alertBellVibra);
    setAlertBellBuzzer(initial.alertBellBuzzer);
    setUsePwm(initial.usePwm);
    setNagTimeout(initial.nagTimeout);
    setUseI2sAsBuzzer(initial.useI2sAsBuzzer);
    setOutputVibra(initial.outputVibra);
    setOutputBuzzer(initial.outputBuzzer);
  }, [setEnabled, setOutputMs, setOutput, setActive, setAlertMessage, setAlertMessageVibra,
      setAlertMessageBuzzer, setAlertBell, setAlertBellVibra, setAlertBellBuzzer,
      setUsePwm, setNagTimeout, setUseI2sAsBuzzer, setOutputVibra, setOutputBuzzer]);

  // Update initial values after successful save
  const handleSave = useCallback(async () => {
    await onSave();
    initialValuesRef.current = {
      enabled, outputMs, output, active, alertMessage, alertMessageVibra, alertMessageBuzzer,
      alertBell, alertBellVibra, alertBellBuzzer, usePwm, nagTimeout,
      useI2sAsBuzzer, outputVibra, outputBuzzer
    };
  }, [onSave, enabled, outputMs, output, active, alertMessage, alertMessageVibra, alertMessageBuzzer,
      alertBell, alertBellVibra, alertBellBuzzer, usePwm, nagTimeout,
      useI2sAsBuzzer, outputVibra, outputBuzzer]);

  // Register with SaveBar
  useSaveBar({
    id: 'extnotif-config',
    sectionName: t('extnotif_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges
  });

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('extnotif_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/external-notification/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('extnotif_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="extnotifEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="extnotifEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('extnotif_config.enabled')}</div>
            <span className="setting-description">{t('extnotif_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Output Duration */}
          <div className="setting-item">
            <label htmlFor="extnotifOutputMs">
              {t('extnotif_config.output_ms')}
              <span className="setting-description">{t('extnotif_config.output_ms_description')}</span>
            </label>
            <input
              id="extnotifOutputMs"
              type="number"
              min="0"
              max="60000"
              value={outputMs}
              onChange={(e) => setOutputMs(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="1000"
            />
          </div>

          {/* Active High/Low */}
          <div className="setting-item">
            <label htmlFor="extnotifActive" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifActive"
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.active_high')}</div>
                <span className="setting-description">{t('extnotif_config.active_high_description')}</span>
              </div>
            </label>
          </div>

          {/* Alert Settings Section */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
            {t('extnotif_config.alert_section')}
          </h4>

          {/* Alert on Message - LED */}
          <div className="setting-item">
            <label htmlFor="extnotifAlertMessage" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifAlertMessage"
                type="checkbox"
                checked={alertMessage}
                onChange={(e) => setAlertMessage(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.alert_message')}</div>
                <span className="setting-description">{t('extnotif_config.alert_message_description')}</span>
              </div>
            </label>
          </div>

          {/* Alert on Message - Vibration */}
          <div className="setting-item">
            <label htmlFor="extnotifAlertMessageVibra" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifAlertMessageVibra"
                type="checkbox"
                checked={alertMessageVibra}
                onChange={(e) => setAlertMessageVibra(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.alert_message_vibra')}</div>
                <span className="setting-description">{t('extnotif_config.alert_message_vibra_description')}</span>
              </div>
            </label>
          </div>

          {/* Alert on Message - Buzzer */}
          <div className="setting-item">
            <label htmlFor="extnotifAlertMessageBuzzer" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifAlertMessageBuzzer"
                type="checkbox"
                checked={alertMessageBuzzer}
                onChange={(e) => setAlertMessageBuzzer(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.alert_message_buzzer')}</div>
                <span className="setting-description">{t('extnotif_config.alert_message_buzzer_description')}</span>
              </div>
            </label>
          </div>

          {/* Alert on Bell - LED */}
          <div className="setting-item">
            <label htmlFor="extnotifAlertBell" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifAlertBell"
                type="checkbox"
                checked={alertBell}
                onChange={(e) => setAlertBell(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.alert_bell')}</div>
                <span className="setting-description">{t('extnotif_config.alert_bell_description')}</span>
              </div>
            </label>
          </div>

          {/* Alert on Bell - Vibration */}
          <div className="setting-item">
            <label htmlFor="extnotifAlertBellVibra" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifAlertBellVibra"
                type="checkbox"
                checked={alertBellVibra}
                onChange={(e) => setAlertBellVibra(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.alert_bell_vibra')}</div>
                <span className="setting-description">{t('extnotif_config.alert_bell_vibra_description')}</span>
              </div>
            </label>
          </div>

          {/* Alert on Bell - Buzzer */}
          <div className="setting-item">
            <label htmlFor="extnotifAlertBellBuzzer" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="extnotifAlertBellBuzzer"
                type="checkbox"
                checked={alertBellBuzzer}
                onChange={(e) => setAlertBellBuzzer(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('extnotif_config.alert_bell_buzzer')}</div>
                <span className="setting-description">{t('extnotif_config.alert_bell_buzzer_description')}</span>
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
              {t('extnotif_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)'
            }}>
              {/* Use PWM */}
              <div className="setting-item">
                <label htmlFor="extnotifUsePwm" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="extnotifUsePwm"
                    type="checkbox"
                    checked={usePwm}
                    onChange={(e) => setUsePwm(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('extnotif_config.use_pwm')}</div>
                    <span className="setting-description">{t('extnotif_config.use_pwm_description')}</span>
                  </div>
                </label>
              </div>

              {/* Use I2S as Buzzer */}
              <div className="setting-item">
                <label htmlFor="extnotifUseI2s" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                  <input
                    id="extnotifUseI2s"
                    type="checkbox"
                    checked={useI2sAsBuzzer}
                    onChange={(e) => setUseI2sAsBuzzer(e.target.checked)}
                    style={{ marginTop: '0.2rem', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div>{t('extnotif_config.use_i2s')}</div>
                    <span className="setting-description">{t('extnotif_config.use_i2s_description')}</span>
                  </div>
                </label>
              </div>

              {/* Nag Timeout */}
              <div className="setting-item">
                <label htmlFor="extnotifNagTimeout">
                  {t('extnotif_config.nag_timeout')}
                  <span className="setting-description">{t('extnotif_config.nag_timeout_description')}</span>
                </label>
                <input
                  id="extnotifNagTimeout"
                  type="number"
                  min="0"
                  max="3600"
                  value={nagTimeout}
                  onChange={(e) => setNagTimeout(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  placeholder="0"
                />
              </div>

              {/* GPIO Settings */}
              <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
                {t('extnotif_config.gpio_section')}
              </h4>

              {/* Output GPIO (LED) */}
              <div className="setting-item">
                <label htmlFor="extnotifOutput">
                  {t('extnotif_config.output_gpio')}
                  <span className="setting-description">{t('extnotif_config.output_gpio_description')}</span>
                </label>
                <input
                  id="extnotifOutput"
                  type="number"
                  min="0"
                  max="255"
                  value={output}
                  onChange={(e) => setOutput(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* Vibra GPIO */}
              <div className="setting-item">
                <label htmlFor="extnotifOutputVibra">
                  {t('extnotif_config.output_vibra_gpio')}
                  <span className="setting-description">{t('extnotif_config.output_vibra_gpio_description')}</span>
                </label>
                <input
                  id="extnotifOutputVibra"
                  type="number"
                  min="0"
                  max="255"
                  value={outputVibra}
                  onChange={(e) => setOutputVibra(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* Buzzer GPIO */}
              <div className="setting-item">
                <label htmlFor="extnotifOutputBuzzer">
                  {t('extnotif_config.output_buzzer_gpio')}
                  <span className="setting-description">{t('extnotif_config.output_buzzer_gpio_description')}</span>
                </label>
                <input
                  id="extnotifOutputBuzzer"
                  type="number"
                  min="0"
                  max="255"
                  value={outputBuzzer}
                  onChange={(e) => setOutputBuzzer(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ExternalNotificationConfigSection;
