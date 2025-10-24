import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import apiService from '../../services/api';
import type { Channel } from '../../types/device';

interface ExportConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  deviceConfig: any;
}

export const ExportConfigModal: React.FC<ExportConfigModalProps> = ({
  isOpen,
  onClose,
  channels: _channels,
  deviceConfig
}) => {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<Set<number>>(new Set());
  const [includeLoraConfig, setIncludeLoraConfig] = useState(true);
  const [generatedUrl, setGeneratedUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Fetch ALL channels (unfiltered) for export
      apiService.getAllChannels().then(allChannels => {
        setChannels(allChannels);
        // Select only channels that are not disabled (role !== 0)
        const enabledChannelIds = new Set(
          allChannels
            .filter(ch => ch.role !== 0) // Exclude DISABLED channels
            .map(ch => ch.id)
        );
        setSelectedChannels(enabledChannelIds);
      }).catch(err => {
        setError(`Failed to load channels: ${err.message}`);
      });
      setIncludeLoraConfig(true);
      setCopied(false);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    // Generate URL whenever selections change
    if (isOpen && selectedChannels.size > 0) {
      generateUrl();
    }
  }, [selectedChannels, includeLoraConfig, isOpen]);

  useEffect(() => {
    // Generate QR code when URL changes
    if (generatedUrl && qrCanvasRef.current) {
      QRCode.toCanvas(qrCanvasRef.current, generatedUrl, {
        width: 256,
        margin: 2,
        color: {
          dark: '#cdd6f4', // Catppuccin text color
          light: '#1e1e2e' // Catppuccin base color
        }
      }).catch((err: any) => {
        console.error('Failed to generate QR code:', err);
      });
    }
  }, [generatedUrl]);

  const generateUrl = async () => {
    if (selectedChannels.size === 0) {
      setGeneratedUrl('');
      return;
    }

    setError(null);
    try {
      const channelIds = Array.from(selectedChannels).sort((a, b) => a - b);
      const url = await apiService.encodeChannelUrl(channelIds, includeLoraConfig);
      setGeneratedUrl(url);
    } catch (err: any) {
      setError(err.message || 'Failed to generate URL');
      setGeneratedUrl('');
    }
  };

  const toggleChannel = (channelId: number) => {
    const newSelected = new Set(selectedChannels);
    if (newSelected.has(channelId)) {
      newSelected.delete(channelId);
    } else {
      newSelected.add(channelId);
    }
    setSelectedChannels(newSelected);
  };

  const handleCopy = () => {
    if (!generatedUrl) return;

    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(generatedUrl)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch((err) => {
          console.error('Failed to copy with clipboard API:', err);
          fallbackCopy();
        });
    } else {
      // Fallback for older browsers or non-HTTPS
      fallbackCopy();
    }
  };

  const fallbackCopy = () => {
    const textArea = document.createElement('textarea');
    textArea.value = generatedUrl;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setError('Failed to copy to clipboard');
    }
    document.body.removeChild(textArea);
  };

  const handleClose = () => {
    setSelectedChannels(new Set());
    setIncludeLoraConfig(true);
    setGeneratedUrl('');
    setError(null);
    setCopied(false);
    onClose();
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
        <h2>Export Meshtastic Configuration</h2>

        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem' }}>
          Select the channels and settings you want to include in the exported URL.
          The URL will be compatible with the official Meshtastic apps.
        </p>

        <div style={{ marginBottom: '1rem' }}>
          <h3>Select Channels</h3>
          {channels.length === 0 ? (
            <div style={{ padding: '1rem', background: 'var(--ctp-surface0)', borderRadius: '4px', color: 'var(--ctp-subtext0)' }}>
              No channels configured
            </div>
          ) : (
            channels.map((channel) => (
              <div
                key={channel.id}
                style={{
                  padding: '0.75rem',
                  background: 'var(--ctp-surface0)',
                  borderRadius: '4px',
                  marginBottom: '0.5rem',
                  border: selectedChannels.has(channel.id) ? '2px solid var(--ctp-blue)' : '2px solid transparent'
                }}
              >
                <label style={{ display: 'flex', alignItems: 'flex-start', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedChannels.has(channel.id)}
                    onChange={() => toggleChannel(channel.id)}
                    style={{ marginRight: '0.5rem', marginTop: '0.25rem' }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                      Channel {channel.id}: {channel.name}
                    </div>
                    <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                      PSK: {channel.psk ? 'set' : 'none'}
                      {channel.positionPrecision !== undefined && channel.positionPrecision !== null && ` | Position Precision: ${channel.positionPrecision} bits`}
                      {` | Uplink: ${channel.uplinkEnabled ? 'enabled' : 'disabled'}`}
                      {` | Downlink: ${channel.downlinkEnabled ? 'enabled' : 'disabled'}`}
                    </div>
                  </div>
                </label>
              </div>
            ))
          )}

          {deviceConfig?.lora && (
            <div style={{ marginTop: '1rem' }}>
              <h3>Device Settings</h3>
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
                      LoRa Configuration
                    </div>
                    <div style={{ fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                      Include LoRa radio settings (region, preset, hop limit, etc.)
                    </div>
                  </div>
                </label>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ color: 'var(--ctp-red)', marginBottom: '1rem', padding: '0.5rem', background: 'var(--ctp-surface0)', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {generatedUrl && (
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              Generated URL
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                value={generatedUrl}
                readOnly
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  background: 'var(--ctp-surface0)',
                  border: '1px solid var(--ctp-surface2)',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.875rem'
                }}
              />
              <button
                onClick={handleCopy}
                style={{
                  background: copied ? 'var(--ctp-green)' : 'var(--ctp-blue)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '0.5rem 1rem',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: '500',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s ease'
                }}
                onMouseOver={(e) => {
                  if (!copied) {
                    e.currentTarget.style.opacity = '0.9';
                  }
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginTop: '0.5rem' }}>
              Share this URL with others to import your channel configuration into their Meshtastic devices
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                QR Code
              </label>
              <div style={{
                padding: '1rem',
                background: 'var(--ctp-surface0)',
                borderRadius: '8px',
                display: 'inline-block'
              }}>
                <canvas ref={qrCanvasRef} />
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ctp-subtext0)', marginTop: '0.5rem', textAlign: 'center' }}>
                Scan with the Meshtastic mobile app to import configuration
              </div>
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
