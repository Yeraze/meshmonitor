import React from 'react';
import { useTranslation } from 'react-i18next';

interface AmbientLightingConfigSectionProps {
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
  onSave: () => Promise<void>;
}

const AmbientLightingConfigSection: React.FC<AmbientLightingConfigSectionProps> = ({
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

  // Generate preview color
  const previewColor = `rgb(${red}, ${green}, ${blue})`;

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('ambientlighting_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/ambient-lighting/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('ambientlighting_config.view_docs')}
        >
          ?
        </a>
      </h3>

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
            <input
              id="ambientCurrent"
              type="number"
              min="0"
              max="255"
              value={current}
              onChange={(e) => setCurrent(parseInt(e.target.value) || 0)}
              className="setting-input"
              placeholder="10"
              style={{ width: '100px' }}
            />
          </div>

          {/* Color Controls */}
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
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
                border: '2px solid var(--ctp-surface2)',
                boxShadow: ledState ? `0 0 20px ${previewColor}` : 'none'
              }}
              title={t('ambientlighting_config.preview')}
            />
            <div style={{ flex: 1, color: 'var(--ctp-subtext0)', fontSize: '0.9rem' }}>
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
              <input
                type="number"
                min="0"
                max="255"
                value={red}
                onChange={(e) => setRed(Math.min(255, Math.max(0, parseInt(e.target.value) || 0)))}
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
              <input
                type="number"
                min="0"
                max="255"
                value={green}
                onChange={(e) => setGreen(Math.min(255, Math.max(0, parseInt(e.target.value) || 0)))}
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
              <input
                type="number"
                min="0"
                max="255"
                value={blue}
                onChange={(e) => setBlue(Math.min(255, Math.max(0, parseInt(e.target.value) || 0)))}
                className="setting-input"
                style={{ width: '70px' }}
              />
            </label>
          </div>
        </>
      )}

      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('ambientlighting_config.save_button')}
      </button>
    </div>
  );
};

export default AmbientLightingConfigSection;
