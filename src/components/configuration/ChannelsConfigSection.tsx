import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      name: existingChannel?.name ?? `Channel ${slotId}`,
      psk: existingChannel?.psk ?? '',
      role: (existingChannel?.role !== undefined && existingChannel?.role !== null) ? existingChannel.role : (slotId === 0 ? 1 : 2), // Default: 1 for slot 0 (Primary), 2 for others (Secondary)
      uplinkEnabled: existingChannel?.uplinkEnabled !== undefined ? existingChannel.uplinkEnabled : true,
      downlinkEnabled: existingChannel?.downlinkEnabled !== undefined ? existingChannel.downlinkEnabled : true,
      positionPrecision: (existingChannel?.positionPrecision !== undefined && existingChannel?.positionPrecision !== null) ? existingChannel.positionPrecision : 32 // Default: full precision
    });
    setShowEditModal(true);
  };

  const handleSaveChannel = async () => {
    if (!editingChannel) return;

    // Allow empty names (Meshtastic supports unnamed channels)
    if (editingChannel.name && editingChannel.name.length > 11) {
      showToast(t('channels_config.toast_name_too_long'), 'error');
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

      showToast(t('channels_config.toast_channel_updated', { slot: editingChannel.slotId }), 'success');
      setShowEditModal(false);
      setEditingChannel(null);
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error updating channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_update_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportChannel = async (channelId: number) => {
    try {
      await apiService.exportChannel(channelId);
      showToast(t('channels_config.toast_channel_exported', { slot: channelId }), 'success');
    } catch (error) {
      logger.error('Error exporting channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_export_failed');
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
      showToast(t('channels_config.toast_select_file'), 'error');
      return;
    }

    setIsSaving(true);
    try {
      // Parse the imported JSON
      const importData = JSON.parse(importFileContent);

      if (!importData.channel) {
        throw new Error(t('channels_config.toast_invalid_format'));
      }

      // Normalize boolean values - handle both boolean (true/false) and numeric (1/0) formats
      const normalizeBoolean = (value: any, defaultValue: boolean = true): boolean => {
        if (value === undefined || value === null) {
          return defaultValue;
        }
        // Handle boolean values
        if (typeof value === 'boolean') {
          return value;
        }
        // Handle numeric values (0/1)
        if (typeof value === 'number') {
          return value !== 0;
        }
        // Handle string values ("true"/"false", "1"/"0")
        if (typeof value === 'string') {
          return value.toLowerCase() === 'true' || value === '1';
        }
        // Default to truthy check
        return !!value;
      };

      // Normalize the channel data before sending
      const normalizedChannelData = {
        ...importData.channel,
        uplinkEnabled: normalizeBoolean(importData.channel.uplinkEnabled, true),
        downlinkEnabled: normalizeBoolean(importData.channel.downlinkEnabled, true)
      };

      // Import the channel
      await apiService.importChannel(importSlotId, normalizedChannelData);

      showToast(t('channels_config.toast_channel_imported', { slot: importSlotId }), 'success');
      setShowImportModal(false);
      setImportFileContent('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error importing channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_import_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleGeneratePSK = () => {
    // Generate 32 random bytes (256 bits for AES256)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    // Convert to base64
    const base64Key = btoa(String.fromCharCode(...randomBytes));

    if (editingChannel) {
      setEditingChannel({ ...editingChannel, psk: base64Key });
      showToast(t('channels_config.toast_key_generated'), 'success');
    }
  };

  return (
    <>
      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {t('channels_config.title')}
          <a
            href="https://meshtastic.org/docs/configuration/radio/channels/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none'
            }}
            title={t('channels_config.view_docs')}
          >
            ❓
          </a>
        </h3>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('channels_config.description')}
        </p>

        <div style={{ display: 'grid', gap: '1rem' }}>
          {channelSlots.map(({ slotId, channel }) => (
            <div
              key={slotId}
              style={{
                border: channel?.role === 1
                  ? '2px solid var(--ctp-blue)'
                  : '1px solid var(--ctp-surface1)',
                borderRadius: '8px',
                padding: '1rem',
                backgroundColor: channel ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)',
                opacity: channel?.role === 0 ? 0.5 : 1,
                boxShadow: channel?.role === 1 ? '0 0 10px rgba(137, 180, 250, 0.3)' : 'none'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div>
                  <h4 style={{ margin: 0, color: 'var(--ctp-text)' }}>
                    {t('channels_config.slot', { slot: slotId })}: {channel ? (
                      <>
                        {channel.name || <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>{t('channels_config.unnamed')}</span>}
                        {channel.role === 1 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-blue)', fontSize: '0.8rem' }}>★ {t('channels_config.primary')}</span>}
                        {channel.role === 0 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-overlay0)', fontSize: '0.8rem' }}>⊘ {t('channels_config.disabled')}</span>}
                      </>
                    ) : <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>{t('channels_config.empty')}</span>}
                  </h4>
                  {channel && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'var(--ctp-subtext1)' }}>
                      <div>🔒 {channel.psk ? t('channels_config.encrypted') : t('channels_config.unencrypted')}</div>
                      <div>
                        {channel.uplinkEnabled ? `↑ ${t('channels_config.uplink')} ` : ''}
                        {channel.downlinkEnabled ? `↓ ${t('channels_config.downlink')}` : ''}
                        {!channel.uplinkEnabled && !channel.downlinkEnabled && t('channels_config.no_bridge')}
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
                    ✏️ {t('common.edit')}
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
                      📥 {t('common.export')}
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
                    📤 {t('common.import')}
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
            <h3 style={{ marginTop: 0 }}>{t('channels_config.edit_channel', { slot: editingChannel.slotId })}</h3>

            <div className="setting-item">
              <label htmlFor="edit-channel-name">
                {t('channels_config.channel_name')}
                <span className="setting-description">{t('channels_config.channel_name_description')}</span>
              </label>
              <input
                id="edit-channel-name"
                type="text"
                maxLength={11}
                value={editingChannel.name}
                onChange={(e) => setEditingChannel({ ...editingChannel, name: e.target.value })}
                className="setting-input"
                placeholder={t('channels_config.channel_name_placeholder')}
              />
            </div>

            <div className="setting-item">
              <label htmlFor="edit-channel-psk">
                {t('channels_config.psk')}
                <span className="setting-description">
                  {t('channels_config.psk_description')}
                </span>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  id="edit-channel-psk"
                  type="text"
                  value={editingChannel.psk}
                  onChange={(e) => setEditingChannel({ ...editingChannel, psk: e.target.value })}
                  className="setting-input"
                  placeholder={t('channels_config.psk_placeholder')}
                  style={{ flex: 1 }}
                />
                <button
                  onClick={handleGeneratePSK}
                  type="button"
                  style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-green)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                  title={t('channels_config.generate_key_title')}
                >
                  {t('channels_config.generate')}
                </button>
              </div>
            </div>

            <div className="setting-item">
              <label htmlFor="edit-channel-role">
                {t('channels_config.channel_role')}
                <span className="setting-description">
                  {t('channels_config.channel_role_description')}
                </span>
              </label>
              <select
                id="edit-channel-role"
                value={editingChannel.role}
                onChange={(e) => setEditingChannel({ ...editingChannel, role: parseInt(e.target.value) })}
                className="setting-input"
              >
                <option value={0}>{t('channels_config.role_disabled')}</option>
                <option value={1}>{t('channels_config.role_primary')}</option>
                <option value={2}>{t('channels_config.role_secondary')}</option>
              </select>
            </div>

            <div className="setting-item">
              <label htmlFor="edit-channel-precision">
                {t('channels_config.position_precision')}
                <span className="setting-description">
                  {t('channels_config.position_precision_description')}
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
                  <span>{t('channels_config.uplink_enabled')}</span>
                </div>
                <span className="setting-description" style={{ marginLeft: '1.75rem' }}>
                  {t('channels_config.uplink_description')}
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
                  <span>{t('channels_config.downlink_enabled')}</span>
                </div>
                <span className="setting-description" style={{ marginLeft: '1.75rem' }}>
                  {t('channels_config.downlink_description')}
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
                {isSaving ? t('common.saving') : t('channels_config.save_channel')}
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
                {t('common.cancel')}
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
            <h3 style={{ marginTop: 0 }}>{t('channels_config.import_channel', { slot: importSlotId })}</h3>

            <div className="setting-item">
              <label htmlFor="import-file">
                {t('channels_config.select_file')}
                <span className="setting-description">{t('channels_config.select_file_description')}</span>
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
                <label>{t('channels_config.preview')}:</label>
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
                {isSaving ? t('channels_config.importing') : t('channels_config.import_channel_button')}
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
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ChannelsConfigSection;
