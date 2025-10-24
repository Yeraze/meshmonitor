import React, { useState } from 'react';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './constants';

interface LoRaConfigSectionProps {
  usePreset: boolean;
  modemPreset: number;
  region: number;
  hopLimit: number;
  channelNum: number;
  sx126xRxBoostedGain: boolean;
  setUsePreset: (value: boolean) => void;
  setModemPreset: (value: number) => void;
  setRegion: (value: number) => void;
  setHopLimit: (value: number) => void;
  setChannelNum: (value: number) => void;
  setSx126xRxBoostedGain: (value: boolean) => void;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

const LoRaConfigSection: React.FC<LoRaConfigSectionProps> = ({
  usePreset,
  modemPreset,
  region,
  hopLimit,
  channelNum,
  sx126xRxBoostedGain,
  setUsePreset,
  setModemPreset,
  setRegion,
  setHopLimit,
  setChannelNum,
  setSx126xRxBoostedGain,
  isSaving,
  onSave
}) => {
  const [isPresetDropdownOpen, setIsPresetDropdownOpen] = useState(false);

  return (
    <div className="settings-section">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        LoRa Radio Configuration
        <a
          href="https://meshmonitor.org/features/device#lora-radio-configuration"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '1.2rem',
            color: '#89b4fa',
            textDecoration: 'none'
          }}
          title="View LoRa Configuration Documentation"
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
            <div>Use Preset</div>
            <span className="setting-description">Use predefined modem settings (recommended)</span>
          </div>
        </label>
      </div>
      {usePreset && (
        <div className="setting-item">
          <label htmlFor="modemPreset">
            Modem Preset
            <span className="setting-description">Predefined radio settings balancing range and speed</span>
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
      <div className="setting-item">
        <label htmlFor="region">
          Region Code
          <span className="setting-description">Select your regulatory region for frequency/power limits</span>
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
          Hop Limit
          <span className="setting-description">Maximum number of hops for mesh packets. Range: 1-7 (default: 3)</span>
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
        <label htmlFor="channelNum">
          Channel Number
          <span className="setting-description">LoRa channel number for frequency hopping. Range: 0-255 (default: 0)</span>
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
            <div>RX Boosted Gain (SX126x)</div>
            <span className="setting-description">Enable boosted receive gain for SX126x radios (improves sensitivity but increases power consumption)</span>
          </div>
        </label>
      </div>
      <button
        className="save-button"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? 'Saving...' : 'Save LoRa Config'}
      </button>
    </div>
  );
};

export default LoRaConfigSection;
