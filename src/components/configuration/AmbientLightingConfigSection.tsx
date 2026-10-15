import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSectionBaseline } from '../../hooks/useSectionBaseline';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import ModuleAvailabilityNotice from './ModuleAvailabilityNotice';
import { ConfigSection } from '../shared/config/ConfigSection';

interface AmbientLightingConfigSectionProps {
  /** False disables every control: no configuration:write on this source (#5830). */
  canWrite?: boolean;
  ledState: boolean;
  setLedState: (value: boolean) => void;
  current: number;
  setCurrent: (value: number) => void;
  red: number;
  setRed: (value: number) => void;
  green: number;
  setGreen: (value: number) => void;
  blue: number;
  setBlue: (value: number) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const AmbientLightingConfigSection: React.FC<AmbientLightingConfigSectionProps> = ({
  canWrite = true,
  ledState,
  setLedState,
  current,
  setCurrent,
  red,
  setRed,
  green,
  setGreen,
  blue,
  setBlue,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();

  // What the node holds; moves on a successful save (#5797)
  const values = {
    ledState, current, red, green, blue
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLedState(baseline.ledState);
    setCurrent(baseline.current);
    setRed(baseline.red);
    setGreen(baseline.green);
    setBlue(baseline.blue);
  }, [baseline, setLedState, setCurrent, setRed, setGreen, setBlue]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'ambientlighting-config',
    sectionName: t('ambientlighting_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  // Generate preview color
  const previewColor = `rgb(${red}, ${green}, ${blue})`;

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection canWrite={canWrite} title={t('ambientlighting_config.title')} docsUrl="https://meshtastic.org/docs/configuration/module/ambient-lighting/" notice={<ModuleAvailabilityNotice />}>

      {/* Enable LED */}
      <div className="setting-item">
        <label htmlFor="ambientLedState" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="ambientLedState"
            type="checkbox"
            checked={ledState}
            onChange={(e) => setLedState(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('ambientlighting_config.led_state')}</div>
            <span className="setting-description">{t('ambientlighting_config.led_state_description')}</span>
          </div>
        </label>
      </div>

      {ledState && (
        <>
          {/* Current */}
          <div className="setting-item">
            <label htmlFor="ambientCurrent">
              {t('ambientlighting_config.current')}
              <span className="setting-description">{t('ambientlighting_config.current_description')}</span>
            </label>
            <NumberInput
              id="ambientCurrent"
              min={0}
              max={255}
              value={current}
              integer
              onChange={setCurrent}
              className="setting-input"
              placeholder="10"
              style={{ width: '100px' }}
            />
          </div>

          {/* Color Controls */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--color-text-subtle)' }}>
            {t('ambientlighting_config.color_section')}
          </h4>

          {/* Color Preview */}
          <div className="setting-item" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
              style={{
                width: '60px',
                height: '60px',
                backgroundColor: previewColor,
                borderRadius: '8px',
                border: '2px solid var(--color-surface-active)',
                boxShadow: ledState ? `0 0 20px ${previewColor}` : 'none'
              }}
              title={t('ambientlighting_config.preview')}
            />
            <div style={{ flex: 1, color: 'var(--color-text-subtle)', fontSize: '0.9rem' }}>
              {t('ambientlighting_config.preview')}: {previewColor}
            </div>
          </div>

          {/* Red */}
          <div className="setting-item">
            <label htmlFor="ambientRed" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ minWidth: '60px', color: '#f38ba8' }}>{t('ambientlighting_config.red')}</span>
              <input
                id="ambientRed"
                type="range"
                min="0"
                max="255"
                value={red}
                onChange={(e) => setRed(parseInt(e.target.value))}
                style={{ flex: 1 }}
              />
              <NumberInput
                min={0}
                max={255}
                value={red}
                integer
                onChange={setRed}
                className="setting-input"
                style={{ width: '70px' }}
              />
            </label>
          </div>

          {/* Green */}
          <div className="setting-item">
            <label htmlFor="ambientGreen" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ minWidth: '60px', color: '#a6e3a1' }}>{t('ambientlighting_config.green')}</span>
              <input
                id="ambientGreen"
                type="range"
                min="0"
                max="255"
                value={green}
                onChange={(e) => setGreen(parseInt(e.target.value))}
                style={{ flex: 1 }}
              />
              <NumberInput
                min={0}
                max={255}
                value={green}
                integer
                onChange={setGreen}
                className="setting-input"
                style={{ width: '70px' }}
              />
            </label>
          </div>

          {/* Blue */}
          <div className="setting-item">
            <label htmlFor="ambientBlue" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ minWidth: '60px', color: '#89b4fa' }}>{t('ambientlighting_config.blue')}</span>
              <input
                id="ambientBlue"
                type="range"
                min="0"
                max="255"
                value={blue}
                onChange={(e) => setBlue(parseInt(e.target.value))}
                style={{ flex: 1 }}
              />
              <NumberInput
                min={0}
                max={255}
                value={blue}
                integer
                onChange={setBlue}
                className="setting-input"
                style={{ width: '70px' }}
              />
            </label>
          </div>
        </>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default AmbientLightingConfigSection;
