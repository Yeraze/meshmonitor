import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Audio bitrate options matching protobuf enum
const AUDIO_BAUD_OPTIONS = [
  { value: 0, name: 'CODEC2_DEFAULT', description: 'Default codec setting' },
  { value: 1, name: 'CODEC2_3200', description: '3200 bps' },
  { value: 2, name: 'CODEC2_2400', description: '2400 bps' },
  { value: 3, name: 'CODEC2_1600', description: '1600 bps' },
  { value: 4, name: 'CODEC2_1400', description: '1400 bps' },
  { value: 5, name: 'CODEC2_1300', description: '1300 bps' },
  { value: 6, name: 'CODEC2_1200', description: '1200 bps' },
  { value: 7, name: 'CODEC2_700', description: '700 bps' },
  { value: 8, name: 'CODEC2_700B', description: '700B bps' }
];

interface AudioConfigSectionProps {
  codec2Enabled: boolean;
  setCodec2Enabled: (value: boolean) => void;
  pttPin: number;
  setPttPin: (value: number) => void;
  bitrate: number;
  setBitrate: (value: number) => void;
  i2sWs: number;
  setI2sWs: (value: number) => void;
  i2sSd: number;
  setI2sSd: (value: number) => void;
  i2sDin: number;
  setI2sDin: (value: number) => void;
  i2sSck: number;
  setI2sSck: (value: number) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const AudioConfigSection: React.FC<AudioConfigSectionProps> = ({
  codec2Enabled,
  setCodec2Enabled,
  pttPin,
  setPttPin,
  bitrate,
  setBitrate,
  i2sWs,
  setI2sWs,
  i2sSd,
  setI2sSd,
  i2sDin,
  setI2sDin,
  i2sSck,
  setI2sSck,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('audio_config.title')}
        <a
          href="https://meshtastic.org/docs/configuration/module/audio/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('audio_config.view_docs')}
        >
          ?
        </a>
      </h3>

      {/* Enable Codec2 */}
      <div className="setting-item">
        <label htmlFor="audioCodec2Enabled" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="audioCodec2Enabled"
            type="checkbox"
            checked={codec2Enabled}
            onChange={(e) => setCodec2Enabled(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('audio_config.codec2_enabled')}</div>
            <span className="setting-description">{t('audio_config.codec2_enabled_description')}</span>
          </div>
        </label>
      </div>

      {codec2Enabled && (
        <>
          {/* Bitrate */}
          <div className="setting-item">
            <label htmlFor="audioBitrate">
              {t('audio_config.bitrate')}
              <span className="setting-description">{t('audio_config.bitrate_description')}</span>
            </label>
            <select
              id="audioBitrate"
              value={bitrate}
              onChange={(e) => setBitrate(parseInt(e.target.value))}
              className="setting-input"
            >
              {AUDIO_BAUD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name} - {option.description}
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
              {t('audio_config.advanced_settings')}
            </button>
          </div>

          {/* Advanced Settings */}
          {showAdvanced && (
            <div className="advanced-section" style={{
              marginLeft: '1rem',
              paddingLeft: '1rem',
              borderLeft: '2px solid var(--ctp-surface2)'
            }}>
              {/* PTT Pin */}
              <div className="setting-item">
                <label htmlFor="audioPttPin">
                  {t('audio_config.ptt_pin')}
                  <span className="setting-description">{t('audio_config.ptt_pin_description')}</span>
                </label>
                <input
                  id="audioPttPin"
                  type="number"
                  min="0"
                  max="255"
                  value={pttPin}
                  onChange={(e) => setPttPin(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* I2S Pins */}
              <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', color: 'var(--ctp-subtext0)' }}>
                {t('audio_config.i2s_section')}
              </h4>

              {/* I2S WS */}
              <div className="setting-item">
                <label htmlFor="audioI2sWs">
                  {t('audio_config.i2s_ws')}
                  <span className="setting-description">{t('audio_config.i2s_ws_description')}</span>
                </label>
                <input
                  id="audioI2sWs"
                  type="number"
                  min="0"
                  max="255"
                  value={i2sWs}
                  onChange={(e) => setI2sWs(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* I2S SD */}
              <div className="setting-item">
                <label htmlFor="audioI2sSd">
                  {t('audio_config.i2s_sd')}
                  <span className="setting-description">{t('audio_config.i2s_sd_description')}</span>
                </label>
                <input
                  id="audioI2sSd"
                  type="number"
                  min="0"
                  max="255"
                  value={i2sSd}
                  onChange={(e) => setI2sSd(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* I2S DIN */}
              <div className="setting-item">
                <label htmlFor="audioI2sDin">
                  {t('audio_config.i2s_din')}
                  <span className="setting-description">{t('audio_config.i2s_din_description')}</span>
                </label>
                <input
                  id="audioI2sDin"
                  type="number"
                  min="0"
                  max="255"
                  value={i2sDin}
                  onChange={(e) => setI2sDin(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
              </div>

              {/* I2S SCK */}
              <div className="setting-item">
                <label htmlFor="audioI2sSck">
                  {t('audio_config.i2s_sck')}
                  <span className="setting-description">{t('audio_config.i2s_sck_description')}</span>
                </label>
                <input
                  id="audioI2sSck"
                  type="number"
                  min="0"
                  max="255"
                  value={i2sSck}
                  onChange={(e) => setI2sSck(parseInt(e.target.value) || 0)}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
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
        {isSaving ? t('common.saving') : t('audio_config.save_button')}
      </button>
    </div>
  );
};

export default AudioConfigSection;
