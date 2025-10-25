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
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string>('');

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
    if (!decoded || !url) return;

    setImporting(true);
    setError(null);

    try {
      // Call the import API which will:
      // - Decode the URL
      // - Write selected channels to the device
      // - Write LoRa config to the device if selected
      setImportStatus('Sending configuration to device...');
      const result = await apiService.importConfig(url);

      console.log('Import result:', result);

      // If reboot is required, wait for device to reconnect and sync
      if (result.requiresReboot) {
        setImportStatus('Device rebooting... Please wait');
        await waitForDeviceReconnect();
      } else {
        setImportStatus('Configuration sent, waiting for device sync...');
        // Even without reboot, give device time to process and sync
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Poll for updated channel data
      setImportStatus('Verifying configuration...');
      await pollForChannelUpdates();

      setImportStatus('Import complete!');
      await new Promise(resolve => setTimeout(resolve, 1000));

      onImportSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || 'Failed to import configuration');
      setImporting(false);
    }
  };

  const waitForDeviceReconnect = async (): Promise<void> => {
    // Wait up to 60 seconds for device to reboot and reconnect
    const maxWaitTime = 60000; // 60 seconds
    const pollInterval = 2000; // 2 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Check connection status to see if device is back online
        const statusData = await apiService.getConnectionStatus();
        if (statusData.connected === true) {
          // Device is back online - request fresh config from device
          await apiService.refreshNodes();
          return;
        }
      } catch (err) {
        // Device still offline, continue waiting
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setImportStatus(`Device rebooting... (${elapsed}s)`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error('Device did not reconnect within 60 seconds');
  };

  const pollForChannelUpdates = async (): Promise<void> => {
    // Poll for channel updates from device for up to 30 seconds
    const maxWaitTime = 30000; // 30 seconds
    const pollInterval = 2000; // 2 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Fetch channels to see if they've been updated
        const channels = await apiService.getChannels();

        // Check if we have the expected number of channels
        // (This is a simple check - could be more sophisticated)
        if (channels && channels.length > 0) {
          // Give it a bit more time to ensure all data is synced
          await new Promise(resolve => setTimeout(resolve, 1000));
          return;
        }
      } catch (err) {
        // Continue polling
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Even if we timeout, consider it successful
    // (the data will eventually sync)
  };

  const handleClose = () => {
    // Don't allow closing while import is in progress
    if (importing) return;

    setUrl('');
    setDecoded(null);
    setSelectedChannels(new Set());
    setIncludeLoraConfig(false);
    setError(null);
    setImporting(false);
    setImportStatus('');
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

            {importing && (
              <div
                style={{
                  marginTop: '1rem',
                  padding: '1rem',
                  background: 'var(--ctp-surface0)',
                  borderRadius: '8px',
                  border: '2px solid var(--ctp-blue)',
                  textAlign: 'center'
                }}
              >
                <div style={{ fontSize: '1rem', fontWeight: 'bold', color: 'var(--ctp-blue)', marginBottom: '0.5rem' }}>
                  Import in Progress
                </div>
                <div style={{ fontSize: '0.875rem', color: 'var(--ctp-text)', marginBottom: '0.75rem' }}>
                  {importStatus}
                </div>
                <div
                  style={{
                    width: '100%',
                    height: '4px',
                    background: 'var(--ctp-surface1)',
                    borderRadius: '2px',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      background: 'var(--ctp-blue)',
                      animation: 'progress-bar 2s ease-in-out infinite',
                      width: '30%'
                    }}
                  />
                </div>
                <style>{`
                  @keyframes progress-bar {
                    0% { transform: translateX(-100%); }
                    50% { transform: translateX(300%); }
                    100% { transform: translateX(-100%); }
                  }
                `}</style>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--ctp-surface0)' }}>
              <button
                onClick={handleClose}
                disabled={importing}
                style={{
                  background: 'var(--ctp-surface1)',
                  color: 'var(--ctp-text)',
                  border: '1px solid var(--ctp-surface2)',
                  borderRadius: '4px',
                  padding: '0.5rem 1rem',
                  cursor: importing ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  opacity: importing ? 0.5 : 1,
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => {
                  if (!importing) {
                    e.currentTarget.style.background = 'var(--ctp-surface2)';
                  }
                }}
                onMouseOut={(e) => {
                  if (!importing) {
                    e.currentTarget.style.background = 'var(--ctp-surface1)';
                  }
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={loading || importing || (selectedChannels.size === 0 && !includeLoraConfig)}
                style={{
                  background: 'var(--ctp-blue)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '0.5rem 1rem',
                  cursor: (loading || importing || (selectedChannels.size === 0 && !includeLoraConfig)) ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  opacity: (loading || importing || (selectedChannels.size === 0 && !includeLoraConfig)) ? 0.5 : 1,
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => {
                  if (!loading && !importing && (selectedChannels.size > 0 || includeLoraConfig)) {
                    e.currentTarget.style.opacity = '0.9';
                  }
                }}
                onMouseOut={(e) => {
                  if (!loading && !importing && (selectedChannels.size > 0 || includeLoraConfig)) {
                    e.currentTarget.style.opacity = '1';
                  }
                }}
              >
                {loading ? 'Decoding...' : importing ? 'Importing...' : 'Import Selected'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
