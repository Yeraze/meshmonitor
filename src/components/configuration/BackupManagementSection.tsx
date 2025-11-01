import React, { useState, useEffect } from 'react';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import '../../styles/BackupManagement.css';

interface BackupFile {
  filename: string;
  timestamp: string;
  size: number;
  type: 'manual' | 'automatic';
}

interface BackupManagementSectionProps {
  onBackupCreated?: () => void;
}

const BackupManagementSection: React.FC<BackupManagementSectionProps> = ({ onBackupCreated }) => {
  const { showToast } = useToast();

  // State
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(false);
  const [maxBackups, setMaxBackups] = useState(7);
  const [backupTime, setBackupTime] = useState('02:00');
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [backupList, setBackupList] = useState<BackupFile[]>([]);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);

  // Load backup settings on mount
  useEffect(() => {
    loadBackupSettings();
  }, []);

  const loadBackupSettings = async () => {
    try {
      const baseUrl = await apiService.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/backup/settings`, {
        credentials: 'same-origin'
      });

      if (response.ok) {
        const settings = await response.json();
        setAutoBackupEnabled(settings.enabled || false);
        setMaxBackups(settings.maxBackups || 7);
        setBackupTime(settings.backupTime || '02:00');
      }
    } catch (error) {
      logger.error('Error loading backup settings:', error);
    }
  };

  const handleSaveBackupSettings = async () => {
    try {
      setIsSavingSettings(true);
      const baseUrl = await apiService.getBaseUrl();

      // Get CSRF token
      const csrfToken = sessionStorage.getItem('csrfToken');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/backup/settings`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({
          enabled: autoBackupEnabled,
          maxBackups,
          backupTime
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save backup settings');
      }

      showToast('Backup settings saved successfully', 'success');
    } catch (error) {
      logger.error('Error saving backup settings:', error);
      showToast(`Failed to save backup settings: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleManualBackup = async () => {
    try {
      showToast('Creating backup...', 'info');

      const baseUrl = await apiService.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/device/backup?save=true`, {
        method: 'GET',
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error(`Failed to create backup: ${response.statusText}`);
      }

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = 'meshtastic-backup.yaml';
      if (contentDisposition) {
        const matches = /filename="?([^"]+)"?/.exec(contentDisposition);
        if (matches && matches[1]) {
          filename = matches[1];
        }
      }

      const yamlContent = await response.text();

      const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      showToast('Backup created and downloaded successfully', 'success');
      if (onBackupCreated) onBackupCreated();
    } catch (error) {
      logger.error('Error creating backup:', error);
      showToast(`Failed to create backup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  const handleShowBackups = async () => {
    try {
      setIsLoadingBackups(true);
      const baseUrl = await apiService.getBaseUrl();

      const response = await fetch(`${baseUrl}/api/backup/list`, {
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error('Failed to load backup list');
      }

      const backups = await response.json();
      setBackupList(backups);
      setIsBackupModalOpen(true);
    } catch (error) {
      logger.error('Error loading backup list:', error);
      showToast(`Failed to load backup list: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleDownloadBackup = async (filename: string) => {
    try {
      const baseUrl = await apiService.getBaseUrl();

      const response = await fetch(`${baseUrl}/api/backup/download/${encodeURIComponent(filename)}`, {
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error('Failed to download backup');
      }

      const yamlContent = await response.text();

      const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      showToast('Backup downloaded successfully', 'success');
    } catch (error) {
      logger.error('Error downloading backup:', error);
      showToast(`Failed to download backup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(`Are you sure you want to delete the backup "${filename}"?`)) {
      return;
    }

    try {
      const baseUrl = await apiService.getBaseUrl();

      const response = await fetch(`${baseUrl}/api/backup/delete/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error('Failed to delete backup');
      }

      showToast('Backup deleted successfully', 'success');
      // Refresh the backup list
      handleShowBackups();
    } catch (error) {
      logger.error('Error deleting backup:', error);
      showToast(`Failed to delete backup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatTimestamp = (timestamp: string): string => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp;
    }
  };

  return (
    <div className="settings-section" style={{ marginTop: '2rem' }}>
      <h3>📦 Device Backup Management</h3>

      <div style={{
        backgroundColor: 'var(--ctp-surface0)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>About Device Backups</h4>
        <p style={{ color: 'var(--ctp-subtext0)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          Device backups export your complete Meshtastic configuration in YAML format, compatible with the
          Meshtastic CLI <code>--export-config</code> command. Backups include all device settings, module
          configurations, and channel settings. Use these backups to restore your device configuration after
          a firmware update or to clone settings to another device.
        </p>
      </div>

      {/* Manual Backup */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>Manual Backup</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          Create an immediate backup and download it to your computer.
        </p>
        <button
          onClick={handleManualBackup}
          style={{
            backgroundColor: 'var(--ctp-mauve)',
            color: '#fff',
            padding: '0.75rem 1.5rem',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '1rem',
            fontWeight: 'bold',
            marginRight: '1rem'
          }}
        >
          💾 Create Backup Now
        </button>
        <button
          onClick={handleShowBackups}
          disabled={isLoadingBackups}
          style={{
            backgroundColor: 'var(--ctp-blue)',
            color: '#fff',
            padding: '0.75rem 1.5rem',
            border: 'none',
            borderRadius: '4px',
            cursor: isLoadingBackups ? 'not-allowed' : 'pointer',
            fontSize: '1rem',
            fontWeight: 'bold',
            opacity: isLoadingBackups ? 0.6 : 1
          }}
        >
          📋 {isLoadingBackups ? 'Loading...' : 'Show Saved Backups'}
        </button>
      </div>

      {/* Automated Backup Settings */}
      <div>
        <h4 style={{ marginBottom: '0.5rem' }}>Automated Backup Schedule</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          Automatically create backups daily at a specified time. Backups are saved to the server's
          filesystem and can be downloaded or restored later.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1rem' }}>
          {/* Enable Automatic Backups */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={autoBackupEnabled}
              onChange={(e) => setAutoBackupEnabled(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <span style={{ fontWeight: 'bold' }}>Enable Automatic Backups</span>
          </label>

          {/* Max Backups to Keep */}
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              Maximum Backups to Keep:
            </label>
            <input
              type="number"
              min="1"
              max="365"
              value={maxBackups}
              onChange={(e) => setMaxBackups(parseInt(e.target.value) || 7)}
              disabled={!autoBackupEnabled}
              style={{
                padding: '0.5rem',
                borderRadius: '4px',
                border: '1px solid var(--ctp-surface2)',
                backgroundColor: 'var(--ctp-surface0)',
                color: 'var(--ctp-text)',
                width: '100px',
                opacity: autoBackupEnabled ? 1 : 0.5
              }}
            />
            <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)', fontSize: '0.9rem' }}>
              (Oldest backups will be deleted automatically)
            </span>
          </div>

          {/* Backup Time */}
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              Daily Backup Time:
            </label>
            <input
              type="time"
              value={backupTime}
              onChange={(e) => setBackupTime(e.target.value)}
              disabled={!autoBackupEnabled}
              style={{
                padding: '0.5rem',
                borderRadius: '4px',
                border: '1px solid var(--ctp-surface2)',
                backgroundColor: 'var(--ctp-surface0)',
                color: 'var(--ctp-text)',
                width: '150px',
                opacity: autoBackupEnabled ? 1 : 0.5
              }}
            />
            <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)', fontSize: '0.9rem' }}>
              (Server timezone)
            </span>
          </div>
        </div>

        <button
          onClick={handleSaveBackupSettings}
          disabled={isSavingSettings}
          style={{
            backgroundColor: 'var(--ctp-green)',
            color: '#fff',
            padding: '0.75rem 1.5rem',
            border: 'none',
            borderRadius: '4px',
            cursor: isSavingSettings ? 'not-allowed' : 'pointer',
            fontSize: '1rem',
            fontWeight: 'bold',
            opacity: isSavingSettings ? 0.6 : 1
          }}
        >
          {isSavingSettings ? 'Saving...' : '💾 Save Backup Settings'}
        </button>
      </div>

      {/* Backup List Modal */}
      {isBackupModalOpen && (
        <div
          className="backup-modal-overlay"
          onClick={() => setIsBackupModalOpen(false)}
        >
          <div
            className="backup-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>📋 Saved Backups</h3>

            {backupList.length === 0 ? (
              <p style={{ color: 'var(--ctp-subtext0)' }}>
                No backups found. Create your first backup using the button above.
              </p>
            ) : (
              <div>
                <table className="backup-table">
                  <thead>
                    <tr>
                      <th>Filename</th>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Size</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupList.map((backup) => (
                      <tr key={backup.filename}>
                        <td data-label="Filename:" className="backup-filename">
                          {backup.filename}
                        </td>
                        <td data-label="Date:" className="backup-date">
                          {formatTimestamp(backup.timestamp)}
                        </td>
                        <td data-label="Type:">
                          <span className={`backup-type-badge ${backup.type === 'automatic' ? 'automatic' : 'manual'}`}>
                            {backup.type === 'automatic' ? '🤖 Auto' : '👤 Manual'}
                          </span>
                        </td>
                        <td data-label="Size:" className="backup-size">
                          {formatFileSize(backup.size)}
                        </td>
                        <td>
                          <div className="backup-actions">
                            <button
                              onClick={() => handleDownloadBackup(backup.filename)}
                              className="backup-btn download"
                            >
                              ⬇️ Download
                            </button>
                            <button
                              onClick={() => handleDeleteBackup(backup.filename)}
                              className="backup-btn delete"
                            >
                              🗑️ Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="backup-modal-footer">
              <button
                onClick={() => setIsBackupModalOpen(false)}
                className="backup-close-btn"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BackupManagementSection;
