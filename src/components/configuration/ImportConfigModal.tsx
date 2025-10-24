import React, { useState } from 'react';
import apiService from '../../services/api';

interface ImportConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess: () => void;
}

interface DecodedChannel {
  psk?: string;
  name?: string;
  uplinkEnabled?: boolean;
  downlinkEnabled?: boolean;
  positionPrecision?: number;
}

interface DecodedConfig {
  channels: DecodedChannel[];
  loraConfig?: any;
}

const modemPresetNames: { [key: number]: string } = {
  0: 'LONG_FAST',
  1: 'LONG_SLOW',
  2: 'VERY_LONG_SLOW',
  3: 'MEDIUM_SLOW',
  4: 'MEDIUM_FAST',
  5: 'SHORT_SLOW',
  6: 'SHORT_FAST',
  7: 'LONG_MODERATE'
};

const regionNames: { [key: number]: string } = {
  0: 'UNSET',
  1: 'US',
  2: 'EU_433',
  3: 'EU_868',
  4: 'CN',
  5: 'JP',
  6: 'ANZ',
  7: 'KR',
  8: 'TW',
  9: 'RU',
  10: 'IN',
  11: 'NZ_865',
  12: 'TH',
  13: 'UA_433',
  14: 'UA_868',
  15: 'MY_433',
  16: 'MY_919',
  17: 'SG_923',
  18: 'LORA_24'
};

export const ImportConfigModal: React.FC<ImportConfigModalProps> = ({ isOpen, onClose, onImportSuccess }) => {
  const [url, setUrl] = useState('');
  const [decoded, setDecoded] = useState<DecodedConfig | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [includeLoraConfig, setIncludeLoraConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleDecode = async () => {
    if (!url.trim()) {
      setError('Please enter a URL');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await apiService.decodeChannelUrl(url);
      setDecoded(result);

      // Select all channels by default
      const allChannelIndices: Set<number> = new Set(result.channels.map((_: any, idx: number) => idx));
      setSelectedChannels(allChannelIndices);

      // Select LoRa config if present
      setIncludeLoraConfig(!!result.loraConfig);
    } catch (err: any) {
      setError(err.message || 'Failed to decode URL');
      setDecoded(null);
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!decoded) return;

    setLoading(true);
    setError(null);
    try {
      // Import each selected channel
      // TODO: This should be a bulk import API call
      // For now, we'll just close and notify success

      console.log('Importing channels:', {
        selectedChannels: Array.from(selectedChannels).map(idx => decoded.channels[idx]),
        includeLoraConfig
      });

      // TODO: Implement actual import logic
      // - Import selected channels
      // - Import LoRa config if selected
      // - Push to device

      onImportSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to import configuration');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setUrl('');
    setDecoded(null);
    setSelectedChannels(new Set());
    setIncludeLoraConfig(false);
    setError(null);
    onClose();
  };

  const toggleChannel = (index: number) => {
    const newSelected = new Set(selectedChannels);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedChannels(newSelected);
  };

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={handleClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '600px',
          background: 'var(--ctp-base)',
          borderRadius: '8px',
          padding: '1.5rem',
          maxHeight: '90vh',
          overflowY: 'auto'
        }}
      >
        <h2>Import Meshtastic Configuration</h2>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            Meshtastic Configuration URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://meshtastic.org/e/#..."
            style={{ width: '100%', padding: '0.5rem' }}
            disabled={loading}
          />
          <button
            onClick={handleDecode}
            disabled={loading || !url.trim()}
            style={{
              marginTop: '0.5rem',
              background: 'var(--ctp-blue)',
              color: 'var(--ctp-base)',
              border: 'none',
              borderRadius: '4px',
              padding: '0.5rem 1rem',
              cursor: loading || !url.trim() ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              fontWeight: '500',
              opacity: loading || !url.trim() ? 0.5 : 1,
              transition: 'all 0.2s ease'
            }}
            onMouseOver={(e) => {
              if (!loading && url.trim()) {
                e.currentTarget.style.opacity = '0.9';
              }
            }}
            onMouseOut={(e) => {
              if (!loading && url.trim()) {
                e.currentTarget.style.opacity = '1';
              }
            }}
          >
            {loading ? 'Decoding...' : 'Decode URL'}
          </button>
        </div>

        {error && (
          <div style={{ color: 'var(--ctp-red)', marginBottom: '1rem', padding: '0.5rem', background: 'var(--ctp-surface0)', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {decoded && (
          <div style={{ marginTop: '1rem', maxHeight: '400px', overflowY: 'auto' }}>
            <h3>Configuration Preview</h3>

            {decoded.channels.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <h4>Channels ({decoded.channels.length})</h4>
                {decoded.channels.map((channel, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '0.75rem',
                      background: 'var(--ctp-surface0)',
                      borderRadius: '4px',
                      marginBottom: '0.5rem',
                      border: selectedChannels.has(idx) ? '2px solid var(--ctp-blue)' : '2px solid transparent'
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selectedChannels.has(idx)}
                        onChange={() => toggleChannel(idx)}
                        style={{ marginRight: '0.5rem', marginTop: '0.25rem' }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                          Channel {idx}: {channel.name || '(unnamed)'}
                        </div>
                        <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                          PSK: {channel.psk || 'none'}
                          {channel.positionPrecision !== undefined && ` | Position Precision: ${channel.positionPrecision} bits`}
                          {channel.uplinkEnabled !== undefined && ` | Uplink: ${channel.uplinkEnabled ? 'enabled' : 'disabled'}`}
                          {channel.downlinkEnabled !== undefined && ` | Downlink: ${channel.downlinkEnabled ? 'enabled' : 'disabled'}`}
                        </div>
                      </div>
                    </label>
                  </div>
                ))}
              </div>
            )}

            {decoded.loraConfig && (
              <div style={{ marginBottom: '1rem' }}>
                <div
                  style={{
                    padding: '0.75rem',
                    background: 'var(--ctp-surface0)',
                    borderRadius: '4px',
                    border: includeLoraConfig ? '2px solid var(--ctp-blue)' : '2px solid transparent'
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includeLoraConfig}
                      onChange={(e) => setIncludeLoraConfig(e.target.checked)}
                      style={{ marginRight: '0.5rem', marginTop: '0.25rem' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                        LoRa Device Settings
                      </div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                        Preset: {modemPresetNames[decoded.loraConfig.modemPreset ?? 0] || decoded.loraConfig.modemPreset}
                        {decoded.loraConfig.region !== undefined && ` | Region: ${regionNames[decoded.loraConfig.region] || decoded.loraConfig.region}`}
                        {decoded.loraConfig.hopLimit !== undefined && ` | Hop Limit: ${decoded.loraConfig.hopLimit}`}
                        {decoded.loraConfig.txPower !== undefined && ` | TX Power: ${decoded.loraConfig.txPower} dBm`}
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--ctp-surface0)' }}>
              <button
                onClick={handleClose}
                style={{
                  background: 'var(--ctp-surface1)',
                  color: 'var(--ctp-text)',
                  border: '1px solid var(--ctp-surface2)',
                  borderRadius: '4px',
                  padding: '0.5rem 1rem',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => e.currentTarget.style.background = 'var(--ctp-surface2)'}
                onMouseOut={(e) => e.currentTarget.style.background = 'var(--ctp-surface1)'}
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={loading || (selectedChannels.size === 0 && !includeLoraConfig)}
                style={{
                  background: 'var(--ctp-blue)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '0.5rem 1rem',
                  cursor: (loading || (selectedChannels.size === 0 && !includeLoraConfig)) ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  opacity: (loading || (selectedChannels.size === 0 && !includeLoraConfig)) ? 0.5 : 1,
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => {
                  if (!loading && (selectedChannels.size > 0 || includeLoraConfig)) {
                    e.currentTarget.style.opacity = '0.9';
                  }
                }}
                onMouseOut={(e) => {
                  if (!loading && (selectedChannels.size > 0 || includeLoraConfig)) {
                    e.currentTarget.style.opacity = '1';
                  }
                }}
              >
                {loading ? 'Importing...' : 'Import Selected'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
