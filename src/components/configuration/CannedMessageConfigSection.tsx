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

// Input event character options matching protobuf enum
const INPUT_EVENT_OPTIONS = [
  { value: 0, name: 'NONE' },
  { value: 17, name: 'UP' },
  { value: 18, name: 'DOWN' },
  { value: 19, name: 'LEFT' },
  { value: 20, name: 'RIGHT' },
  { value: 10, name: 'SELECT' },
  { value: 27, name: 'BACK' },
  { value: 24, name: 'CANCEL' }
];

interface CannedMessageConfigSectionProps {
  /** False disables every control: no configuration:write on this source (#5830). */
  canWrite?: boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  rotary1Enabled: boolean;
  setRotary1Enabled: (value: boolean) => void;
  inputbrokerPinA: number;
  setInputbrokerPinA: (value: number) => void;
  inputbrokerPinB: number;
  setInputbrokerPinB: (value: number) => void;
  inputbrokerPinPress: number;
  setInputbrokerPinPress: (value: number) => void;
  inputbrokerEventCw: number;
  setInputbrokerEventCw: (value: number) => void;
  inputbrokerEventCcw: number;
  setInputbrokerEventCcw: (value: number) => void;
  inputbrokerEventPress: number;
  setInputbrokerEventPress: (value: number) => void;
  updown1Enabled: boolean;
  setUpdown1Enabled: (value: boolean) => void;
  sendBell: boolean;
  setSendBell: (value: boolean) => void;
  allowInputSource: number;
  setAllowInputSource: (value: number) => void;
  isSaving: boolean;
  /** Resolves true when the node accepted the save. */
  onSave: () => Promise<boolean>;
}

const CannedMessageConfigSection: React.FC<CannedMessageConfigSectionProps> = ({
  canWrite = true,
  enabled,
  setEnabled,
  rotary1Enabled,
  setRotary1Enabled,
  inputbrokerPinA,
  setInputbrokerPinA,
  inputbrokerPinB,
  setInputbrokerPinB,
  inputbrokerPinPress,
  setInputbrokerPinPress,
  inputbrokerEventCw,
  setInputbrokerEventCw,
  inputbrokerEventCcw,
  setInputbrokerEventCcw,
  inputbrokerEventPress,
  setInputbrokerEventPress,
  updown1Enabled,
  setUpdown1Enabled,
  sendBell,
  setSendBell,
  allowInputSource,
  setAllowInputSource,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  // What the node holds; moves on a successful save (#5797)
  const values = {
    enabled, rotary1Enabled, inputbrokerPinA, inputbrokerPinB, inputbrokerPinPress,
    inputbrokerEventCw, inputbrokerEventCcw, inputbrokerEventPress, updown1Enabled,
    sendBell, allowInputSource
  };
  const { baseline, hasChanges, commit } = useSectionBaseline(values);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setEnabled(baseline.enabled);
    setRotary1Enabled(baseline.rotary1Enabled);
    setInputbrokerPinA(baseline.inputbrokerPinA);
    setInputbrokerPinB(baseline.inputbrokerPinB);
    setInputbrokerPinPress(baseline.inputbrokerPinPress);
    setInputbrokerEventCw(baseline.inputbrokerEventCw);
    setInputbrokerEventCcw(baseline.inputbrokerEventCcw);
    setInputbrokerEventPress(baseline.inputbrokerEventPress);
    setUpdown1Enabled(baseline.updown1Enabled);
    setSendBell(baseline.sendBell);
    setAllowInputSource(baseline.allowInputSource);
  }, [baseline, setEnabled, setRotary1Enabled, setInputbrokerPinA, setInputbrokerPinB,
      setInputbrokerPinPress, setInputbrokerEventCw, setInputbrokerEventCcw,
      setInputbrokerEventPress, setUpdown1Enabled, setSendBell, setAllowInputSource]);

  // Move the baseline only when the node took the save
  const handleSave = async () => {
    if (await onSave()) commit(values);
  };

  // Register with SaveBar
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'cannedmsg-config',
    sectionName: t('cannedmsg_config.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
    numberScope
  });

  return (
    <NumberInputScope scope={numberScope}>
    <ConfigSection canWrite={canWrite} title={t('cannedmsg_config.title')} docsUrl="https://meshmonitor.org/features/device#canned-message-configuration" notice={<ModuleAvailabilityNotice />}>

      {/* Enable Module */}
      <div className="setting-item">
        <label htmlFor="cannedmsgEnabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="cannedmsgEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('cannedmsg_config.enabled')}</div>
            <span className="setting-description">{t('cannedmsg_config.enabled_description')}</span>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* Rotary Encoder Enabled */}
          <div className="setting-item">
            <label htmlFor="cannedmsgRotary1" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="cannedmsgRotary1"
                type="checkbox"
                checked={rotary1Enabled}
                onChange={(e) => setRotary1Enabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('cannedmsg_config.rotary1_enabled')}</div>
                <span className="setting-description">{t('cannedmsg_config.rotary1_enabled_description')}</span>
              </div>
            </label>
          </div>

          {/* Up/Down Enabled */}
          <div className="setting-item">
            <label htmlFor="cannedmsgUpdown1" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="cannedmsgUpdown1"
                type="checkbox"
                checked={updown1Enabled}
                onChange={(e) => setUpdown1Enabled(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('cannedmsg_config.updown1_enabled')}</div>
                <span className="setting-description">{t('cannedmsg_config.updown1_enabled_description')}</span>
              </div>
            </label>
          </div>

          {/* Send Bell */}
          <div className="setting-item">
            <label htmlFor="cannedmsgSendBell" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
              <input
                id="cannedmsgSendBell"
                type="checkbox"
                checked={sendBell}
                onChange={(e) => setSendBell(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <div style={{ flex: 1 }}>
                <div>{t('cannedmsg_config.send_bell')}</div>
                <span className="setting-description">{t('cannedmsg_config.send_bell_description')}</span>
              </div>
            </label>
          </div>

          {/* Allow Input Source */}
          <div className="setting-item">
            <label htmlFor="cannedmsgAllowInputSource">
              {t('cannedmsg_config.allow_input_source')}
              <span className="setting-description">{t('cannedmsg_config.allow_input_source_description')}</span>
            </label>
            <select
              id="cannedmsgAllowInputSource"
              value={allowInputSource}
              onChange={(e) => setAllowInputSource(parseInt(e.target.value))}
              className="setting-input"
            >
              {INPUT_EVENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name}
                </option>
              ))}
            </select>
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
              {t('cannedmsg_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--color-surface-active)'
            }}>
          {/* GPIO Settings */}
          <h4 style={{ marginTop: '0.5rem', marginBottom: '0.5rem', color: 'var(--color-text-subtle)' }}>
            {t('cannedmsg_config.gpio_section')}
          </h4>

          {/* Pin A */}
          <div className="setting-item">
            <label htmlFor="cannedmsgPinA">
              {t('cannedmsg_config.pin_a')}
              <span className="setting-description">{t('cannedmsg_config.pin_a_description')}</span>
            </label>
            <NumberInput
              id="cannedmsgPinA"
              min={0}
              max={255}
              value={inputbrokerPinA}
              integer
              onChange={setInputbrokerPinA}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* Pin B */}
          <div className="setting-item">
            <label htmlFor="cannedmsgPinB">
              {t('cannedmsg_config.pin_b')}
              <span className="setting-description">{t('cannedmsg_config.pin_b_description')}</span>
            </label>
            <NumberInput
              id="cannedmsgPinB"
              min={0}
              max={255}
              value={inputbrokerPinB}
              integer
              onChange={setInputbrokerPinB}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* Pin Press */}
          <div className="setting-item">
            <label htmlFor="cannedmsgPinPress">
              {t('cannedmsg_config.pin_press')}
              <span className="setting-description">{t('cannedmsg_config.pin_press_description')}</span>
            </label>
            <NumberInput
              id="cannedmsgPinPress"
              min={0}
              max={255}
              value={inputbrokerPinPress}
              integer
              onChange={setInputbrokerPinPress}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* Event Mappings */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--color-text-subtle)' }}>
            {t('cannedmsg_config.events_section')}
          </h4>

          {/* Event CW */}
          <div className="setting-item">
            <label htmlFor="cannedmsgEventCw">
              {t('cannedmsg_config.event_cw')}
              <span className="setting-description">{t('cannedmsg_config.event_cw_description')}</span>
            </label>
            <select
              id="cannedmsgEventCw"
              value={inputbrokerEventCw}
              onChange={(e) => setInputbrokerEventCw(parseInt(e.target.value))}
              className="setting-input"
            >
              {INPUT_EVENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>

          {/* Event CCW */}
          <div className="setting-item">
            <label htmlFor="cannedmsgEventCcw">
              {t('cannedmsg_config.event_ccw')}
              <span className="setting-description">{t('cannedmsg_config.event_ccw_description')}</span>
            </label>
            <select
              id="cannedmsgEventCcw"
              value={inputbrokerEventCcw}
              onChange={(e) => setInputbrokerEventCcw(parseInt(e.target.value))}
              className="setting-input"
            >
              {INPUT_EVENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>

          {/* Event Press */}
          <div className="setting-item">
            <label htmlFor="cannedmsgEventPress">
              {t('cannedmsg_config.event_press')}
              <span className="setting-description">{t('cannedmsg_config.event_press_description')}</span>
            </label>
            <select
              id="cannedmsgEventPress"
              value={inputbrokerEventPress}
              onChange={(e) => setInputbrokerEventPress(parseInt(e.target.value))}
              className="setting-input"
            >
              {INPUT_EVENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name}
                </option>
              ))}
              </select>
            </div>
          </div>
        )}
        </>
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default CannedMessageConfigSection;
