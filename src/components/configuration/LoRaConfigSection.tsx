import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './constants';

interface LoRaConfigSectionProps {
  usePreset: boolean;
  modemPreset: number;
  bandwidth: number;
  spreadFactor: number;
  codingRate: number;
  frequencyOffset: number;
  overrideFrequency: number;
  region: number;
  hopLimit: number;
  txPower: number;
  channelNum: number;
  sx126xRxBoostedGain: boolean;
  ignoreMqtt: boolean;
  configOkToMqtt: boolean;
  setUsePreset: (value: boolean) => void;
  setModemPreset: (value: number) => void;
  setBandwidth: (value: number) => void;
  setSpreadFactor: (value: number) => void;
  setCodingRate: (value: number) => void;
  setFrequencyOffset: (value: number) => void;
  setOverrideFrequency: (value: number) => void;
  setRegion: (value: number) => void;
  setHopLimit: (value: number) => void;
  setTxPower: (value: number) => void;
  setChannelNum: (value: number) => void;
  setSx126xRxBoostedGain: (value: boolean) => void;
  setIgnoreMqtt: (value: boolean) => void;
  setConfigOkToMqtt: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const LoRaConfigSection: React.FC<LoRaConfigSectionProps> = ({
  usePreset,
  modemPreset,
  bandwidth,
  spreadFactor,
  codingRate,
  frequencyOffset,
  overrideFrequency,
  region,
  hopLimit,
  txPower,
  channelNum,
  sx126xRxBoostedGain,
  ignoreMqtt,
  configOkToMqtt,
  setUsePreset,
  setModemPreset,
  setBandwidth,
  setSpreadFactor,
  setCodingRate,
  setFrequencyOffset,
  setOverrideFrequency,
  setRegion,
  setHopLimit,
  setTxPower,
  setChannelNum,
  setSx126xRxBoostedGain,
  setIgnoreMqtt,
  setConfigOkToMqtt,
  isSaving,
  onSave
}) => {
  const { t } = useTranslation();
  const [isPresetDropdownOpen, setIsPresetDropdownOpen] = useState(false);

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {t('lora_config.title')}
        <a
          href="https://meshmonitor.org/features/device#lora-radio-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title={t('lora_config.view_docs')}
        >
          ❓
        </a>
      </h3>
      <div className="setting-item">
        <label htmlFor="usePreset" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="usePreset"
            type="checkbox"
            checked={usePreset}
            onChange={(e) => setUsePreset(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('lora_config.use_preset')}</div>
            <span className="setting-description">{t('lora_config.use_preset_description')}</span>
          </div>
        </label>
      </div>
      {usePreset && (
        <div className="setting-item">
          <label htmlFor="modemPreset">
            {t('lora_config.modem_preset')}
            <span className="setting-description">{t('lora_config.modem_preset_description')}</span>
          </label>
          <div style={{ position: 'relative' }}>
            <div
              onClick={() => setIsPresetDropdownOpen(!isPresetDropdownOpen)}
              className="setting-input config-custom-dropdown"
              style={{
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.75rem',
                minHeight: '60px',
                width: '800px'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.1em', color: '#fff', marginBottom: '0.4rem' }}>
                  {MODEM_PRESET_OPTIONS.find(opt => opt.value === modemPreset)?.name || 'LONG_FAST'}
                </div>
                <div style={{ fontSize: '0.9em', color: '#ddd', marginBottom: '0.2rem', lineHeight: '1.4' }}>
                  {MODEM_PRESET_OPTIONS.find(opt => opt.value === modemPreset)?.description || ''}
                </div>
                <div style={{ fontSize: '0.85em', color: '#bbb', fontStyle: 'italic', lineHeight: '1.4' }}>
                  {MODEM_PRESET_OPTIONS.find(opt => opt.value === modemPreset)?.params || ''}
                </div>
              </div>
              <span style={{ fontSize: '1.2em', marginLeft: '1rem', flexShrink: 0 }}>{isPresetDropdownOpen ? '▲' : '▼'}</span>
            </div>
            {isPresetDropdownOpen && (
              <div
                className="config-custom-dropdown-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  width: '800px',
                  backgroundColor: 'white',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  maxHeight: '400px',
                  overflowY: 'auto',
                  zIndex: 1000,
                  boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                }}
              >
                {MODEM_PRESET_OPTIONS.map(option => (
                  <div
                    key={option.value}
                    onClick={() => {
                      setModemPreset(option.value);
                      setIsPresetDropdownOpen(false);
                    }}
                    style={{
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid #eee',
                      backgroundColor: option.value === modemPreset ? '#e3f2fd' : 'white',
                      transition: 'background-color 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      if (option.value !== modemPreset) {
                        e.currentTarget.style.backgroundColor = '#f5f5f5';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (option.value !== modemPreset) {
                        e.currentTarget.style.backgroundColor = 'white';
                      }
                    }}
                  >
                    <div style={{ fontWeight: 'bold', fontSize: '1em', color: '#000', marginBottom: '0.3rem' }}>
                      {option.name}
                    </div>
                    <div style={{ fontSize: '0.9em', color: '#333', marginBottom: '0.2rem', lineHeight: '1.4' }}>
                      {option.description}
                    </div>
                    <div style={{ fontSize: '0.85em', color: '#555', fontStyle: 'italic', lineHeight: '1.4' }}>
                      {option.params}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {!usePreset && (
        <>
          <div className="setting-item">
            <label htmlFor="bandwidth">
              {t('lora_config.bandwidth')}
              <span className="setting-description">{t('lora_config.bandwidth_description')}</span>
            </label>
            <input
              id="bandwidth"
              type="number"
              min="1"
              max="500"
              value={bandwidth}
              onChange={(e) => setBandwidth(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="spreadFactor">
              {t('lora_config.spread_factor')}
              <span className="setting-description">{t('lora_config.spread_factor_description')}</span>
            </label>
            <input
              id="spreadFactor"
              type="number"
              min="7"
              max="12"
              value={spreadFactor}
              onChange={(e) => setSpreadFactor(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="codingRate">
              {t('lora_config.coding_rate')}
              <span className="setting-description">{t('lora_config.coding_rate_description')}</span>
            </label>
            <input
              id="codingRate"
              type="number"
              min="5"
              max="8"
              value={codingRate}
              onChange={(e) => setCodingRate(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="frequencyOffset">
              {t('lora_config.frequency_offset')}
              <span className="setting-description">{t('lora_config.frequency_offset_description')}</span>
            </label>
            <input
              id="frequencyOffset"
              type="number"
              step="0.001"
              value={frequencyOffset}
              onChange={(e) => setFrequencyOffset(parseFloat(e.target.value))}
              className="setting-input"
            />
          </div>
        </>
      )}
      <div className="setting-item">
        <label htmlFor="overrideFrequency">
          {t('lora_config.override_frequency')}
          <span className="setting-description">{t('lora_config.override_frequency_description')}</span>
        </label>
        <input
          id="overrideFrequency"
          type="number"
          step="0.001"
          value={overrideFrequency}
          onChange={(e) => setOverrideFrequency(parseFloat(e.target.value))}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="region">
          {t('lora_config.region')}
          <span className="setting-description">{t('lora_config.region_description')}</span>
        </label>
        <select
          id="region"
          value={region}
          onChange={(e) => setRegion(parseInt(e.target.value))}
          className="setting-input"
        >
          {REGION_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-item">
        <label htmlFor="hopLimit">
          {t('lora_config.hop_limit')}
          <span className="setting-description">{t('lora_config.hop_limit_description')}</span>
        </label>
        <input
          id="hopLimit"
          type="number"
          min="1"
          max="7"
          value={hopLimit}
          onChange={(e) => setHopLimit(parseInt(e.target.value))}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="txPower">
          {t('lora_config.tx_power')}
          <span className="setting-description">{t('lora_config.tx_power_description')}</span>
        </label>
        <input
          id="txPower"
          type="number"
          value={txPower}
          onChange={(e) => setTxPower(parseInt(e.target.value))}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="channelNum">
          {t('lora_config.channel_num')}
          <span className="setting-description">{t('lora_config.channel_num_description')}</span>
        </label>
        <input
          id="channelNum"
          type="number"
          min="0"
          max="255"
          value={channelNum}
          onChange={(e) => setChannelNum(parseInt(e.target.value))}
          className="setting-input"
        />
      </div>
      <div className="setting-item">
        <label htmlFor="sx126xRxBoostedGain" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="sx126xRxBoostedGain"
            type="checkbox"
            checked={sx126xRxBoostedGain}
            onChange={(e) => setSx126xRxBoostedGain(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('lora_config.rx_boosted_gain')}</div>
            <span className="setting-description">{t('lora_config.rx_boosted_gain_description')}</span>
          </div>
        </label>
      </div>
      <div className="setting-item">
        <label htmlFor="ignoreMqtt" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="ignoreMqtt"
            type="checkbox"
            checked={ignoreMqtt}
            onChange={(e) => setIgnoreMqtt(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('lora_config.ignore_mqtt')}</div>
            <span className="setting-description">{t('lora_config.ignore_mqtt_description')}</span>
          </div>
        </label>
      </div>
      <div className="setting-item">
        <label htmlFor="configOkToMqtt" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
          <input
            id="configOkToMqtt"
            type="checkbox"
            checked={configOkToMqtt}
            onChange={(e) => setConfigOkToMqtt(e.target.checked)}
            style={{ marginTop: '0.2rem', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div>{t('lora_config.ok_to_mqtt')}</div>
            <span className="setting-description">{t('lora_config.ok_to_mqtt_description')}</span>
          </div>
        </label>
      </div>
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? t('common.saving') : t('lora_config.save_button')}
      </button>
    </div>
  );
};

export default LoRaConfigSection;
