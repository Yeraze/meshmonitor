import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';

interface ImportConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess: () => void;
  nodeNum?: number; // Optional node number for remote nodes
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

export const ImportConfigModal: React.FC<ImportConfigModalProps> = ({ isOpen, onClose, onImportSuccess, nodeNum }) => {
  const { t } = useTranslation();
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
      setError(t('import_config.error_enter_url'));
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
      setError(err.message || t('import_config.error_decode_failed'));
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
      setImportStatus(t('import_config.status_sending'));
      const result = await apiService.importConfig(url, nodeNum);

      console.log('Import result:', result);

      // If reboot is required, wait for device to reconnect and sync
      if (result.requiresReboot) {
        setImportStatus(t('import_config.status_rebooting'));
        await waitForDeviceReconnect();
      } else {
        setImportStatus(t('import_config.status_syncing'));
        // Even without reboot, give device time to process and sync
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Poll for updated channel data
      setImportStatus(t('import_config.status_verifying'));
      await pollForChannelUpdates();

      setImportStatus(t('import_config.status_complete'));
      await new Promise(resolve => setTimeout(resolve, 1000));

      onImportSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || t('import_config.error_import_failed'));
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
      setImportStatus(t('import_config.status_rebooting_elapsed', { elapsed }));
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(t('import_config.error_reconnect_timeout'));
  };

  const pollForChannelUpdates = async (): Promise<void> => {
    // Poll for configuration updates from device for up to 45 seconds
    // IMPORTANT: Use /api/poll (not /api/channels) to get live device state including LoRa config
    const maxWaitTime = 45000; // 45 seconds
    const pollInterval = 2000; // 2 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Fetch live device data from /api/poll (includes channels AND LoRa config)
        const response = await fetch('/api/poll', { credentials: 'include' });
        if (!response.ok) {
          throw new Error('Poll failed');
        }
        const pollData = await response.json();

        // Check if we have channel data with PSKs (indicates channel sync)
        const hasChannels = pollData?.channels && pollData.channels.length > 0;
        const channelsWithPSKs = pollData?.channels?.filter((ch: any) => ch.psk && ch.psk !== '').length || 0;

        // Check if LoRa config is synced (if we're importing LoRa config)
        // LoRa config is nested in deviceConfig.lora (requires configuration:read permission)
        const hasLoraConfig = includeLoraConfig ? pollData?.deviceConfig?.lora?.modemPreset !== undefined : true;

        if (hasChannels && channelsWithPSKs > 0 && hasLoraConfig) {
          // Give it a bit more time to ensure all data is fully synced
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
        <h2>{t('import_config.title')}</h2>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            {t('import_config.url_label')}
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('import_config.url_placeholder')}
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
            {loading ? t('import_config.decoding') : t('import_config.decode_button')}
          </button>
        </div>

        {error && (
          <div style={{ color: 'var(--ctp-red)', marginBottom: '1rem', padding: '0.5rem', background: 'var(--ctp-surface0)', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {decoded && (
          <div style={{ marginTop: '1rem', maxHeight: '400px', overflowY: 'auto' }}>
            <h3>{t('import_config.config_preview')}</h3>

            {decoded.channels.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <h4>{t('import_config.channels_count', { count: decoded.channels.length })}</h4>
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
                          {t('import_config.channel_label', { idx, name: channel.name || t('import_config.channel_unnamed') })}
                        </div>
                        <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                          {channel.psk ? t('import_config.psk_label', { psk: channel.psk }) : t('import_config.psk_none')}
                          {channel.positionPrecision !== undefined && ` | ${t('import_config.position_precision', { bits: channel.positionPrecision })}`}
                          {channel.uplinkEnabled !== undefined && ` | ${channel.uplinkEnabled ? t('import_config.uplink_enabled') : t('import_config.uplink_disabled')}`}
                          {channel.downlinkEnabled !== undefined && ` | ${channel.downlinkEnabled ? t('import_config.downlink_enabled') : t('import_config.downlink_disabled')}`}
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
                        {t('import_config.lora_settings')}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                        {t('import_config.preset', { preset: modemPresetNames[decoded.loraConfig.modemPreset ?? 0] || decoded.loraConfig.modemPreset })}
                        {decoded.loraConfig.region !== undefined && ` | ${t('import_config.region', { region: regionNames[decoded.loraConfig.region] || decoded.loraConfig.region })}`}
                        {decoded.loraConfig.hopLimit !== undefined && ` | ${t('import_config.hop_limit', { limit: decoded.loraConfig.hopLimit })}`}
                        {decoded.loraConfig.txPower !== undefined && ` | ${t('import_config.tx_power', { power: decoded.loraConfig.txPower })}`}
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
                  {t('import_config.import_in_progress')}
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
                {t('import_config.cancel')}
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
                {loading ? t('import_config.decoding') : importing ? t('import_config.importing') : t('import_config.import_selected')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
