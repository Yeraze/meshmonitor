import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ChannelDatabaseEntry, RetroactiveDecryptionProgress } from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import { REBROADCAST_MODE_OPTIONS } from './constants';

/**
 * Meshtastic default channel key (shorthand value 1)
 * Used for the "default" encryption setting
 */
const MESHTASTIC_DEFAULT_KEY = new Uint8Array([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01
]);

/**
 * Expand a Meshtastic shorthand PSK (1 byte) to a full 16-byte key
 * Shorthand values:
 *   0 = No crypto (returns null)
 *   1 = Default key
 *   2-10 = Default key with (value-1) added to last byte (simple1-simple9)
 */
function expandShorthandPsk(shorthandValue: number): Uint8Array | null {
  if (shorthandValue === 0) {
    return null; // No crypto
  }

  // Copy the default key
  const key = new Uint8Array(MESHTASTIC_DEFAULT_KEY);

  if (shorthandValue >= 2 && shorthandValue <= 10) {
    // simple1-simple9: add (value-1) to last byte
    key[15] = (key[15] + (shorthandValue - 1)) & 0xff;
  }
  // For value 1, just use the default key as-is

  return key;
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

interface ChannelDatabaseSectionProps {
  isAdmin: boolean;
  rebroadcastMode?: number;
}

interface ChannelEditState {
  id?: number;
  name: string;
  psk: string;
  description: string;
  isEnabled: boolean;
  enforceNameValidation: boolean;
}

const ChannelDatabaseSection: React.FC<ChannelDatabaseSectionProps> = ({ isAdmin, rebroadcastMode }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();

  // Get the rebroadcast mode name for warning display
  const rebroadcastModeName = REBROADCAST_MODE_OPTIONS.find(opt => opt.value === rebroadcastMode)?.name || 'UNKNOWN';

  const [channels, setChannels] = useState<ChannelDatabaseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingChannel, setEditingChannel] = useState<ChannelEditState | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<number | null>(null);
  const [importFileContent, setImportFileContent] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [decryptionProgress, setDecryptionProgress] = useState<RetroactiveDecryptionProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch channels on mount
  useEffect(() => {
    if (isAdmin) {
      fetchChannels();
    }
  }, [isAdmin]);

  // Poll for decryption progress when running
  useEffect(() => {
    if (decryptionProgress?.status === 'running' || decryptionProgress?.status === 'pending') {
      const interval = setInterval(async () => {
        try {
          const response = await apiService.getRetroactiveDecryptionProgress();
          if (response.progress) {
            setDecryptionProgress(response.progress);
            if (response.progress.status === 'completed') {
              // Refresh channels to show updated decrypted counts
              fetchChannels();
              showToast(
                t('channel_database.toast_decryption_completed', {
                  decrypted: response.progress.decrypted,
                  total: response.progress.total
                }),
                'success'
              );
            } else if (response.progress.status === 'failed') {
              // Refresh channels and show error
              fetchChannels();
              const errorMsg = response.progress.error || t('channel_database.toast_decryption_failed');
              showToast(errorMsg, 'error');
            }
          } else if (!response.isRunning) {
            setDecryptionProgress(null);
          }
        } catch (err) {
          logger.warn('Failed to fetch decryption progress:', err);
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [decryptionProgress?.status]);

  const fetchChannels = async () => {
    try {
      setLoading(true);
      const response = await apiService.getChannelDatabaseEntries();
      setChannels(response.data || []);
    } catch (error) {
      logger.error('Error fetching channel database:', error);
      const errorMsg = error instanceof Error ? error.message : t('channel_database.toast_fetch_failed');
      showToast(errorMsg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAddChannel = () => {
    setEditingChannel({
      name: '',
      psk: '',
      description: '',
      isEnabled: true,
      enforceNameValidation: false
    });
    setShowEditModal(true);
  };

  const handleEditChannel = (channel: ChannelDatabaseEntry) => {
    setEditingChannel({
      id: channel.id,
      name: channel.name,
      psk: channel.psk || '',
      description: channel.description || '',
      isEnabled: channel.isEnabled,
      enforceNameValidation: channel.enforceNameValidation ?? false
    });
    setShowEditModal(true);
  };

  const handleSaveChannel = async () => {
    if (!editingChannel) return;

    if (!editingChannel.name.trim()) {
      showToast(t('channel_database.toast_name_required'), 'error');
      return;
    }

    if (!editingChannel.psk.trim()) {
      showToast(t('channel_database.toast_psk_required'), 'error');
      return;
    }

    // Validate PSK is valid Base64 and expand shorthand if needed
    let finalPsk = editingChannel.psk;
    try {
      const pskBytes = atob(editingChannel.psk);

      if (pskBytes.length === 0) {
        // No crypto - not valid for channel database
        showToast(t('channel_database.toast_psk_no_crypto'), 'error');
        return;
      } else if (pskBytes.length === 1) {
        // Shorthand PSK - expand to full key
        const shorthandValue = pskBytes.charCodeAt(0);
        if (shorthandValue === 0) {
          showToast(t('channel_database.toast_psk_no_crypto'), 'error');
          return;
        }
        const expandedKey = expandShorthandPsk(shorthandValue);
        if (!expandedKey) {
          showToast(t('channel_database.toast_psk_no_crypto'), 'error');
          return;
        }
        finalPsk = uint8ArrayToBase64(expandedKey);
        logger.debug(`Expanded shorthand PSK ${shorthandValue} to full 16-byte key`);
      } else if (pskBytes.length !== 16 && pskBytes.length !== 32) {
        showToast(t('channel_database.toast_psk_invalid_length'), 'error');
        return;
      }
    } catch (_e) {
      showToast(t('channel_database.toast_psk_invalid_base64'), 'error');
      return;
    }

    setIsSaving(true);
    try {
      if (editingChannel.id) {
        // Update existing
        await apiService.updateChannelDatabaseEntry(editingChannel.id, {
          name: editingChannel.name,
          psk: finalPsk,
          description: editingChannel.description || undefined,
          isEnabled: editingChannel.isEnabled,
          enforceNameValidation: editingChannel.enforceNameValidation
        });
        showToast(t('channel_database.toast_channel_updated'), 'success');
      } else {
        // Create new
        await apiService.createChannelDatabaseEntry({
          name: editingChannel.name,
          psk: finalPsk,
          description: editingChannel.description || undefined,
          isEnabled: editingChannel.isEnabled,
          enforceNameValidation: editingChannel.enforceNameValidation
        });
        showToast(t('channel_database.toast_channel_created'), 'success');

        // Check for retroactive decryption progress
        const progressResponse = await apiService.getRetroactiveDecryptionProgress();
        if (progressResponse.isRunning && progressResponse.progress) {
          setDecryptionProgress(progressResponse.progress);
        }
      }

      setShowEditModal(false);
      setEditingChannel(null);
      fetchChannels();
    } catch (error) {
      logger.error('Error saving channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channel_database.toast_save_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteChannel = async (id: number) => {
    setIsSaving(true);
    try {
      await apiService.deleteChannelDatabaseEntry(id);
      showToast(t('channel_database.toast_channel_deleted'), 'success');
      setShowDeleteConfirm(null);
      fetchChannels();
    } catch (error) {
      logger.error('Error deleting channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channel_database.toast_delete_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnabled = async (channel: ChannelDatabaseEntry) => {
    try {
      await apiService.updateChannelDatabaseEntry(channel.id, {
        isEnabled: !channel.isEnabled
      });
      showToast(
        channel.isEnabled
          ? t('channel_database.toast_channel_disabled')
          : t('channel_database.toast_channel_enabled'),
        'success'
      );
      fetchChannels();
    } catch (error) {
      logger.error('Error toggling channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channel_database.toast_update_failed');
      showToast(errorMsg, 'error');
    }
  };

  const handleTriggerDecryption = async (channelId: number) => {
    try {
      const response = await apiService.triggerRetroactiveDecryption(channelId);
      if (response.progress) {
        setDecryptionProgress(response.progress);
      }
      showToast(t('channel_database.toast_decryption_started'), 'success');
    } catch (error) {
      logger.error('Error triggering decryption:', error);
      const errorMsg = error instanceof Error ? error.message : t('channel_database.toast_decryption_failed');
      showToast(errorMsg, 'error');
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
      showToast(t('channel_database.toast_key_generated'), 'success');
    }
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

  const handleImportChannels = async () => {
    if (!importFileContent) {
      showToast(t('channel_database.toast_select_file'), 'error');
      return;
    }

    setIsSaving(true);
    try {
      const importData = JSON.parse(importFileContent);

      // Support both single channel and array of channels
      const channelsToImport = Array.isArray(importData) ? importData : [importData];

      let imported = 0;
      for (const channelData of channelsToImport) {
        if (channelData.name && channelData.psk) {
          await apiService.createChannelDatabaseEntry({
            name: channelData.name,
            psk: channelData.psk,
            description: channelData.description,
            isEnabled: channelData.isEnabled ?? true
          });
          imported++;
        }
      }

      showToast(t('channel_database.toast_import_success', { count: imported }), 'success');
      setShowImportModal(false);
      setImportFileContent('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      fetchChannels();
    } catch (error) {
      logger.error('Error importing channels:', error);
      const errorMsg = error instanceof Error ? error.message : t('channel_database.toast_import_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const formatTimestamp = (timestamp: number | null): string => {
    if (!timestamp) return t('common.never');
    return new Date(timestamp).toLocaleString();
  };

  if (!isAdmin) {
    return (
      <div className="settings-section">
        <h3>{t('channel_database.title')}</h3>
        <p className="setting-description">{t('channel_database.admin_required')}</p>
      </div>
    );
  }

  return (
    <>
      <div className="settings-section">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {t('channel_database.title')}
          <a
            href="https://meshmonitor.org/features/channel-database.html"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none'
            }}
            title={t('channel_database.view_docs')}
          >
            ?
          </a>
        </h3>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('channel_database.description')}
        </p>

        {/* Rebroadcast Mode Warning */}
        {rebroadcastMode !== undefined && rebroadcastMode !== 0 && (
          <div
            style={{
              backgroundColor: 'var(--ctp-peach)',
              color: 'var(--ctp-base)',
              padding: '1rem',
              borderRadius: '8px',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem'
            }}
          >
            <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>⚠️</span>
            <div>
              <strong style={{ display: 'block', marginBottom: '0.25rem' }}>
                {t('channel_database.rebroadcast_warning_title', 'Rebroadcast Mode Warning')}
              </strong>
              <span>
                {t('channel_database.rebroadcast_warning_message',
                  'Your node\'s Rebroadcast Mode is set to "{{mode}}". For the Channel Database to decrypt packets from other nodes, Rebroadcast Mode should be set to "ALL". Otherwise, encrypted packets from distant nodes may not be forwarded to MeshMonitor for analysis.',
                  { mode: rebroadcastModeName }
                )}
              </span>
            </div>
          </div>
        )}

        {/* Retroactive Decryption Progress */}
        {decryptionProgress && (decryptionProgress.status === 'running' || decryptionProgress.status === 'pending') && (
          <div
            style={{
              backgroundColor: 'var(--ctp-blue)',
              color: 'var(--ctp-base)',
              padding: '1rem',
              borderRadius: '8px',
              marginBottom: '1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <strong>{t('channel_database.retroactive_decryption')}</strong>
              <span>{decryptionProgress.channelName}</span>
            </div>
            <div style={{ marginBottom: '0.5rem' }}>
              {t('channel_database.progress')}: {decryptionProgress.processed}/{decryptionProgress.total} ({decryptionProgress.decrypted} {t('channel_database.decrypted')})
            </div>
            <div
              style={{
                height: '8px',
                backgroundColor: 'rgba(0,0,0,0.2)',
                borderRadius: '4px',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${decryptionProgress.total > 0 ? (decryptionProgress.processed / decryptionProgress.total) * 100 : 0}%`,
                  backgroundColor: 'var(--ctp-green)',
                  transition: 'width 0.3s ease'
                }}
              />
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <button
            onClick={handleAddChannel}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: 'var(--ctp-green)',
              color: 'var(--ctp-base)',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            + {t('channel_database.add_channel')}
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: 'var(--ctp-yellow)',
              color: 'var(--ctp-base)',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            {t('common.import')}
          </button>
        </div>

        {/* Channel List */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            {t('common.loading')}...
          </div>
        ) : channels.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '2rem',
              color: 'var(--ctp-subtext0)',
              backgroundColor: 'var(--ctp-mantle)',
              borderRadius: '8px'
            }}
          >
            {t('channel_database.no_channels')}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '1rem' }}>
            {channels.map((channel) => (
              <div
                key={channel.id}
                style={{
                  border: channel.isEnabled
                    ? '2px solid var(--ctp-green)'
                    : '1px solid var(--ctp-surface1)',
                  borderRadius: '8px',
                  padding: '1rem',
                  backgroundColor: channel.isEnabled ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)',
                  opacity: channel.isEnabled ? 1 : 0.7
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <h4 style={{ margin: 0, color: 'var(--ctp-text)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {channel.name}
                      {channel.isEnabled ? (
                        <span style={{ color: 'var(--ctp-green)', fontSize: '0.8rem' }}>{t('channel_database.enabled')}</span>
                      ) : (
                        <span style={{ color: 'var(--ctp-overlay0)', fontSize: '0.8rem' }}>{t('channel_database.disabled')}</span>
                      )}
                    </h4>
                    {channel.description && (
                      <p style={{ margin: '0.25rem 0', fontSize: '0.9rem', color: 'var(--ctp-subtext1)' }}>
                        {channel.description}
                      </p>
                    )}
                    <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                      <div>PSK: {channel.pskPreview} ({channel.pskLength === 16 ? 'AES-128' : 'AES-256'})</div>
                      <div>{t('channel_database.decrypted_count')}: {channel.decryptedPacketCount}</div>
                      <div>{t('channel_database.last_decrypted')}: {formatTimestamp(channel.lastDecryptedAt)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleToggleEnabled(channel)}
                      style={{
                        padding: '0.4rem 0.6rem',
                        fontSize: '0.85rem',
                        backgroundColor: channel.isEnabled ? 'var(--ctp-yellow)' : 'var(--ctp-green)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                      title={channel.isEnabled ? t('channel_database.disable') : t('channel_database.enable')}
                    >
                      {channel.isEnabled ? t('channel_database.disable') : t('channel_database.enable')}
                    </button>
                    <button
                      onClick={() => handleEditChannel(channel)}
                      style={{
                        padding: '0.4rem 0.6rem',
                        fontSize: '0.85rem',
                        backgroundColor: 'var(--ctp-blue)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('common.edit')}
                    </button>
                    {channel.isEnabled && (
                      <button
                        onClick={() => handleTriggerDecryption(channel.id)}
                        disabled={decryptionProgress?.status === 'running'}
                        style={{
                          padding: '0.4rem 0.6rem',
                          fontSize: '0.85rem',
                          backgroundColor: 'var(--ctp-mauve)',
                          color: 'var(--ctp-base)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: decryptionProgress?.status === 'running' ? 'not-allowed' : 'pointer',
                          opacity: decryptionProgress?.status === 'running' ? 0.6 : 1
                        }}
                        title={t('channel_database.run_retroactive')}
                      >
                        {t('channel_database.decrypt')}
                      </button>
                    )}
                    <button
                      onClick={() => setShowDeleteConfirm(channel.id)}
                      style={{
                        padding: '0.4rem 0.6rem',
                        fontSize: '0.85rem',
                        backgroundColor: 'var(--ctp-red)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Channel Modal */}
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
            <h3 style={{ marginTop: 0 }}>
              {editingChannel.id ? t('channel_database.edit_channel') : t('channel_database.add_channel')}
            </h3>

            <div className="setting-item">
              <label htmlFor="channel-name">
                {t('channel_database.channel_name')}
                <span className="setting-description">{t('channel_database.channel_name_description')}</span>
              </label>
              <input
                id="channel-name"
                type="text"
                value={editingChannel.name}
                onChange={(e) => setEditingChannel({ ...editingChannel, name: e.target.value })}
                className="setting-input"
                placeholder={t('channel_database.channel_name_placeholder')}
              />
            </div>

            <div className="setting-item">
              <label htmlFor="channel-psk">
                {t('channel_database.psk')}
                <span className="setting-description">{t('channel_database.psk_description')}</span>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  id="channel-psk"
                  type="text"
                  value={editingChannel.psk}
                  onChange={(e) => setEditingChannel({ ...editingChannel, psk: e.target.value })}
                  className="setting-input"
                  placeholder={t('channel_database.psk_placeholder')}
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
                  title={t('channel_database.generate_key_title')}
                >
                  {t('channel_database.generate')}
                </button>
              </div>
            </div>

            <div className="setting-item">
              <label htmlFor="channel-description">
                {t('channel_database.channel_description')}
                <span className="setting-description">{t('channel_database.channel_description_hint')}</span>
              </label>
              <textarea
                id="channel-description"
                value={editingChannel.description}
                onChange={(e) => setEditingChannel({ ...editingChannel, description: e.target.value })}
                className="setting-input"
                placeholder={t('channel_database.channel_description_placeholder')}
                rows={3}
                style={{ resize: 'vertical' }}
              />
            </div>

            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={editingChannel.isEnabled}
                    onChange={(e) => setEditingChannel({ ...editingChannel, isEnabled: e.target.checked })}
                  />
                  <span>{t('channel_database.is_enabled')}</span>
                </div>
                <span className="setting-description" style={{ marginLeft: '1.75rem' }}>
                  {t('channel_database.is_enabled_description')}
                </span>
              </label>
            </div>

            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={editingChannel.enforceNameValidation}
                    onChange={(e) => setEditingChannel({ ...editingChannel, enforceNameValidation: e.target.checked })}
                  />
                  <span>{t('channel_database.enforce_name_validation')}</span>
                </div>
                <span className="setting-description" style={{ marginLeft: '1.75rem' }}>
                  {t('channel_database.enforce_name_validation_description')}
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
                {isSaving ? t('common.saving') : t('common.save')}
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

      {/* Import Modal */}
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
            <h3 style={{ marginTop: 0 }}>{t('channel_database.import_channels')}</h3>

            <div className="setting-item">
              <label htmlFor="import-file">
                {t('channel_database.select_file')}
                <span className="setting-description">{t('channel_database.select_file_description')}</span>
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
                <label>{t('channel_database.preview')}:</label>
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
                onClick={handleImportChannels}
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
                {isSaving ? t('common.importing') : t('common.import')}
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

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm !== null && (
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
          onClick={() => !isSaving && setShowDeleteConfirm(null)}
        >
          <div
            style={{
              backgroundColor: 'var(--ctp-base)',
              borderRadius: '8px',
              padding: '1.5rem',
              maxWidth: '400px',
              width: '90%'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, color: 'var(--ctp-red)' }}>{t('channel_database.confirm_delete')}</h3>
            <p>{t('channel_database.confirm_delete_message')}</p>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
              <button
                onClick={() => handleDeleteChannel(showDeleteConfirm)}
                disabled={isSaving}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-red)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isSaving ? 'not-allowed' : 'pointer',
                  opacity: isSaving ? 0.6 : 1
                }}
              >
                {isSaving ? t('common.deleting') : t('common.delete')}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(null)}
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

export default ChannelDatabaseSection;
