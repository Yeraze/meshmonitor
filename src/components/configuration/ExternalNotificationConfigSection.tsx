import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { ConfigSection } from '../shared/config/ConfigSection';

interface ExternalNotificationConfigSectionProps {
  /** False disables every control: no configuration:write on this source (#5830). */
  canWrite?: boolean;
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
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const ExternalNotificationConfigSection: React.FC<ExternalNotificationConfigSectionProps> = ({
  canWrite = true,
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

  // What the node holds; moves on a successful save (#5797)
  const values = {
    enabled, outputMs, output, active, alertMessage, alertMessageVibra, alertMessageBuzzer,
    alertBell, alertBellVibra, alertBellBuzzer, usePwm, nagTimeout,
    useI2sAsBuzzer, outputVibra, outputBuzzer
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setEnabled(baseline.enabled);
    setOutputMs(baseline.outputMs);
    setOutput(baseline.output);
    setActive(baseline.active);
    setAlertMessage(baseline.alertMessage);
    setAlertMessageVibra(baseline.alertMessageVibra);
    setAlertMessageBuzzer(baseline.alertMessageBuzzer);
    setAlertBell(baseline.alertBell);
    setAlertBellVibra(baseline.alertBellVibra);
    setAlertBellBuzzer(baseline.alertBellBuzzer);
    setUsePwm(baseline.usePwm);
    setNagTimeout(baseline.nagTimeout);
    setUseI2sAsBuzzer(baseline.useI2sAsBuzzer);
    setOutputVibra(baseline.outputVibra);
    setOutputBuzzer(baseline.outputBuzzer);
  }, [baseline, setEnabled, setOutputMs, setOutput, setActive, setAlertMessage, setAlertMessageVibra,
      setAlertMessageBuzzer, setAlertBell, setAlertBellVibra, setAlertBellBuzzer,
      setUsePwm, setNagTimeout, setUseI2sAsBuzzer, setOutputVibra, setOutputBuzzer]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'extnotif-config',
    sectionName: t('extnotif_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection canWrite={canWrite} title={t('extnotif_config.title')} docsUrl="https://meshtastic.org/docs/configuration/module/external-notification/" notice={<ModuleAvailabilityNotice />}>

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
            <NumberInput
              id="extnotifOutputMs"
              min={0}
              max={60000}
              value={outputMs}
              integer
              onChange={setOutputMs}
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
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--color-text-subtle)' }}>
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
              {t('extnotif_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--color-surface-active)'
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
                <NumberInput
                  id="extnotifNagTimeout"
                  min={0}
                  max={3600}
                  value={nagTimeout}
                  integer
                  onChange={setNagTimeout}
                  className="setting-input"
                  placeholder="0"
                />
              </div>

              {/* GPIO Settings */}
              <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--color-text-subtle)' }}>
                {t('extnotif_config.gpio_section')}
              </h4>

              {/* Output GPIO (LED) */}
              <div className="setting-item">
                <label htmlFor="extnotifOutput">
                  {t('extnotif_config.output_gpio')}
                  <span className="setting-description">{t('extnotif_config.output_gpio_description')}</span>
                </label>
                <NumberInput
                  id="extnotifOutput"
                  min={0}
                  max={255}
                  value={output}
                  integer
                  onChange={setOutput}
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
                <NumberInput
                  id="extnotifOutputVibra"
                  min={0}
                  max={255}
                  value={outputVibra}
                  integer
                  onChange={setOutputVibra}
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
                <NumberInput
                  id="extnotifOutputBuzzer"
                  min={0}
                  max={255}
                  value={outputBuzzer}
                  integer
                  onChange={setOutputBuzzer}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default ExternalNotificationConfigSection;
