import React, { useState, useRef } from 'react';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { Channel } from '../../types/device';
import { logger } from '../../utils/logger';

interface ChannelsConfigSectionProps {
  baseUrl?: string;
  channels: Channel[];
  onChannelsUpdated?: () => void;
}

interface ChannelEditState {
  slotId: number;
  name: string;
  psk: string;
  role: number;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  positionPrecision: number;
}

const ChannelsConfigSection: React.FC<ChannelsConfigSectionProps> = ({
  channels,
  onChannelsUpdated
}) => {
  const { showToast } = useToast();
  const [editingChannel, setEditingChannel] = useState<ChannelEditState | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importSlotId, setImportSlotId] = useState<number>(0);
  const [importFileContent, setImportFileContent] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Create array of 8 slots (0-7) with channel data
  const channelSlots = Array.from({ length: 8 }, (_, index) => {
    const existingChannel = channels.find(ch => ch.id === index);
    return {
      slotId: index,
      channel: existingChannel || null
    };
  });

  const handleEditChannel = (slotId: number) => {
    const existingChannel = channels.find(ch => ch.id === slotId);
    setEditingChannel({
      slotId,
      name: existingChannel?.name || `Channel ${slotId}`,
      psk: existingChannel?.psk || '',
      role: (existingChannel?.role !== undefined && existingChannel?.role !== null) ? existingChannel.role : (slotId === 0 ? 1 : 2), // Default: 1 for slot 0 (Primary), 2 for others (Secondary)
      uplinkEnabled: existingChannel?.uplinkEnabled !== undefined ? existingChannel.uplinkEnabled : true,
      downlinkEnabled: existingChannel?.downlinkEnabled !== undefined ? existingChannel.downlinkEnabled : true,
      positionPrecision: (existingChannel?.positionPrecision !== undefined && existingChannel?.positionPrecision !== null) ? existingChannel.positionPrecision : 32 // Default: full precision
    });
    setShowEditModal(true);
  };

  const handleSaveChannel = async () => {
    if (!editingChannel) return;

    if (!editingChannel.name || editingChannel.name.trim().length === 0) {
      showToast('Channel name is required', 'error');
      return;
    }

    if (editingChannel.name.length > 11) {
      showToast('Channel name must be 11 characters or less', 'error');
      return;
    }

    setIsSaving(true);
    try {
      await apiService.updateChannel(editingChannel.slotId, {
        name: editingChannel.name,
        psk: editingChannel.psk || undefined,
        role: editingChannel.role,
        uplinkEnabled: editingChannel.uplinkEnabled,
        downlinkEnabled: editingChannel.downlinkEnabled,
        positionPrecision: editingChannel.positionPrecision
      });

      showToast(`Channel ${editingChannel.slotId} updated successfully!`, 'success');
      setShowEditModal(false);
      setEditingChannel(null);
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error updating channel:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to update channel';
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportChannel = async (channelId: number) => {
    try {
      await apiService.exportChannel(channelId);
      showToast(`Channel ${channelId} exported successfully!`, 'success');
    } catch (error) {
      logger.error('Error exporting channel:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to export channel';
      showToast(errorMsg, 'error');
    }
  };

  const handleImportClick = (slotId: number) => {
    setImportSlotId(slotId);
    setImportFileContent('');
    setShowImportModal(true);
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setImportFileContent(content);
    };
    reader.readAsText(file);
  };

  const handleImportChannel = async () => {
    if (!importFileContent) {
      showToast('Please select a file to import', 'error');
      return;
    }

    setIsSaving(true);
    try {
      // Parse the imported JSON
      const importData = JSON.parse(importFileContent);

      if (!importData.channel) {
        throw new Error('Invalid import file format. Expected channel object.');
      }

      // Import the channel
      await apiService.importChannel(importSlotId, importData.channel);

      showToast(`Channel imported to slot ${importSlotId} successfully!`, 'success');
      setShowImportModal(false);
      setImportFileContent('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error importing channel:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to import channel';
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          Channels Configuration
          <a
            href="https://meshtastic.org/docs/configuration/radio/channels/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none'
            }}
            title="View Meshtastic Channels Documentation"
          >
            ❓
          </a>
        </h3>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          Meshtastic devices support up to 8 channels (0-7). Channel 0 is typically the Primary channel.
          You can configure each channel's name, encryption key (PSK), and uplink/downlink settings.
        </p>

        <div style={{ display: 'grid', gap: '1rem' }}>
          {channelSlots.map(({ slotId, channel }) => (
            <div
              key={slotId}
              style={{
                border: '1px solid var(--ctp-surface1)',
                borderRadius: '8px',
                padding: '1rem',
                backgroundColor: channel ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div>
                  <h4 style={{ margin: 0, color: 'var(--ctp-text)' }}>
                    Slot {slotId}: {channel ? channel.name : <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>Empty</span>}
                  </h4>
                  {channel && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'var(--ctp-subtext1)' }}>
                      <div>🔒 {channel.psk ? 'Encrypted' : 'Unencrypted'}</div>
                      <div>
                        {channel.uplinkEnabled && '↑ Uplink '}
                        {channel.downlinkEnabled && '↓ Downlink'}
                        {!channel.uplinkEnabled && !channel.downlinkEnabled && 'No bridge'}
                      </div>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => handleEditChannel(slotId)}
                    style={{
                      padding: '0.5rem 0.75rem',
                      fontSize: '0.9rem',
                      backgroundColor: 'var(--ctp-blue)',
                      color: 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    ✏️ Edit
                  </button>
                  {channel && (
                    <button
                      onClick={() => handleExportChannel(slotId)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.9rem',
                        backgroundColor: 'var(--ctp-green)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      📥 Export
                    </button>
                  )}
                  <button
                    onClick={() => handleImportClick(slotId)}
                    style={{
                      padding: '0.5rem 0.75rem',
                      fontSize: '0.9rem',
                      backgroundColor: 'var(--ctp-yellow)',
                      color: 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    📤 Import
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit Channel Modal */}
      {showEditModal && editingChannel && (
        <div
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
          onClick={() => !isSaving && setShowEditModal(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--ctp-base)',
              borderRadius: '8px',
              padding: '1.5rem',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Edit Channel {editingChannel.slotId}</h3>

            <div className="setting-item">
              <label htmlFor="edit-channel-name">
                Channel Name
                <span className="setting-description">Up to 11 characters</span>
              </label>
              <input
                id="edit-channel-name"
                type="text"
                maxLength={11}
                value={editingChannel.name}
                onChange={(e) => setEditingChannel({ ...editingChannel, name: e.target.value })}
                className="setting-input"
                placeholder="Channel Name"
              />
            </div>

            <div className="setting-item">
              <label htmlFor="edit-channel-psk">
                Pre-Shared Key (PSK)
                <span className="setting-description">
                  Leave empty for no encryption, or enter base64-encoded key (16 or 32 bytes)
                </span>
              </label>
              <input
                id="edit-channel-psk"
                type="text"
                value={editingChannel.psk}
                onChange={(e) => setEditingChannel({ ...editingChannel, psk: e.target.value })}
                className="setting-input"
                placeholder="Optional: base64 PSK"
              />
            </div>

            <div className="setting-item">
              <label htmlFor="edit-channel-role">
                Channel Role
                <span className="setting-description">
                  Primary sets radio frequency; Secondary is for encryption only; Disabled turns off the channel
                </span>
              </label>
              <select
                id="edit-channel-role"
                value={editingChannel.role}
                onChange={(e) => setEditingChannel({ ...editingChannel, role: parseInt(e.target.value) })}
                className="setting-input"
              >
                <option value={0}>Disabled</option>
                <option value={1}>Primary</option>
                <option value={2}>Secondary</option>
              </select>
            </div>

            <div className="setting-item">
              <label htmlFor="edit-channel-precision">
                Location Precision (bits)
                <span className="setting-description">
                  Number of bits for position data (0-32). Higher = more precise. 32 = full precision.
                </span>
              </label>
              <input
                id="edit-channel-precision"
                type="number"
                min="0"
                max="32"
                value={editingChannel.positionPrecision}
                onChange={(e) => setEditingChannel({ ...editingChannel, positionPrecision: parseInt(e.target.value) || 0 })}
                className="setting-input"
                placeholder="32"
              />
            </div>

            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={editingChannel.uplinkEnabled}
                    onChange={(e) => setEditingChannel({ ...editingChannel, uplinkEnabled: e.target.checked })}
                  />
                  <span>Uplink Enabled</span>
                </div>
                <span className="setting-description" style={{ marginLeft: '1.75rem' }}>
                  Allow gateway nodes to forward mesh messages to internet
                </span>
              </label>
            </div>

            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={editingChannel.downlinkEnabled}
                    onChange={(e) => setEditingChannel({ ...editingChannel, downlinkEnabled: e.target.checked })}
                  />
                  <span>Downlink Enabled</span>
                </div>
                <span className="setting-description" style={{ marginLeft: '1.75rem' }}>
                  Allow internet messages to route to local mesh
                </span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
              <button
                onClick={handleSaveChannel}
                disabled={isSaving}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-blue)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.6 : 1
                }}
              >
                {isSaving ? 'Saving...' : 'Save Channel'}
              </button>
              <button
                onClick={() => setShowEditModal(false)}
                disabled={isSaving}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-surface1)',
                  color: 'var(--ctp-text)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Channel Modal */}
      {showImportModal && (
        <div
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
          onClick={() => !isSaving && setShowImportModal(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--ctp-base)',
              borderRadius: '8px',
              padding: '1.5rem',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Import Channel to Slot {importSlotId}</h3>

            <div className="setting-item">
              <label htmlFor="import-file">
                Select Channel Configuration File
                <span className="setting-description">Choose a previously exported channel JSON file</span>
              </label>
              <input
                ref={fileInputRef}
                id="import-file"
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  marginTop: '0.5rem'
                }}
              />
            </div>

            {importFileContent && (
              <div style={{ marginTop: '1rem' }}>
                <label>Preview:</label>
                <pre
                  style={{
                    backgroundColor: 'var(--ctp-surface0)',
                    padding: '0.75rem',
                    borderRadius: '4px',
                    fontSize: '0.85rem',
                    maxHeight: '200px',
                    overflowY: 'auto'
                  }}
                >
                  {importFileContent}
                </pre>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
              <button
                onClick={handleImportChannel}
                disabled={isSaving || !importFileContent}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-green)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: (isSaving || !importFileContent) ? 'not-allowed' : 'pointer',
                  opacity: (isSaving || !importFileContent) ? 0.6 : 1
                }}
              >
                {isSaving ? 'Importing...' : 'Import Channel'}
              </button>
              <button
                onClick={() => setShowImportModal(false)}
                disabled={isSaving}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-surface1)',
                  color: 'var(--ctp-text)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isSaving ? 'not-allowed' : 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ChannelsConfigSection;
