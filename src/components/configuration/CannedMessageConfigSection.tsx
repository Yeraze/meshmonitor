import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  onSave: () => Promise<void>;
}

const CannedMessageConfigSection: React.FC<CannedMessageConfigSectionProps> = ({
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

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('cannedmsg_config.title')}
        <a
          href="https://meshmonitor.org/features/device#canned-message-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('cannedmsg_config.view_docs')}
        >
          ❓
        </a>
      </h3>

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
              {t('cannedmsg_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)'
            }}>
          {/* GPIO Settings */}
          <h4 style={{ marginTop: '0.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
            {t('cannedmsg_config.gpio_section')}
          </h4>

          {/* Pin A */}
          <div className="setting-item">
            <label htmlFor="cannedmsgPinA">
              {t('cannedmsg_config.pin_a')}
              <span className="setting-description">{t('cannedmsg_config.pin_a_description')}</span>
            </label>
            <input
              id="cannedmsgPinA"
              type="number"
              min="0"
              max="255"
              value={inputbrokerPinA}
              onChange={(e) => setInputbrokerPinA(parseInt(e.target.value) || 0)}
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
            <input
              id="cannedmsgPinB"
              type="number"
              min="0"
              max="255"
              value={inputbrokerPinB}
              onChange={(e) => setInputbrokerPinB(parseInt(e.target.value) || 0)}
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
            <input
              id="cannedmsgPinPress"
              type="number"
              min="0"
              max="255"
              value={inputbrokerPinPress}
              onChange={(e) => setInputbrokerPinPress(parseInt(e.target.value) || 0)}
              className="setting-input"
              style={{ width: '100px' }}
            />
          </div>

          {/* Event Mappings */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
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

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('cannedmsg_config.save_button')}
      </button>
    </div>
  );
};

export default CannedMessageConfigSection;
