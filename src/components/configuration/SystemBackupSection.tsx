import React, { useState, useEffect } from 'react';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import '../../styles/BackupManagement.css';

interface SystemBackupFile {
  dirname: string;
  timestamp: string;
  timestampUnix: number;
  type: 'manual' | 'automatic';
  size: number;
  tableCount: number;
  meshmonitorVersion: string;
  schemaVersion: number;
}

const SystemBackupSection: React.FC = () => {
  const { showToast } = useToast();

  // State
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(false);
  const [maxBackups, setMaxBackups] = useState(7);
  const [backupTime, setBackupTime] = useState('03:00');
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [backupList, setBackupList] = useState<SystemBackupFile[]>([]);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);

  // Load backup settings on mount
  useEffect(() => {
    loadBackupSettings();
  }, []);

  const loadBackupSettings = async () => {
    try {
      const baseUrl = await apiService.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/system/backup/settings`, {
        credentials: 'same-origin'
      });

      if (response.ok) {
        const settings = await response.json();
        setAutoBackupEnabled(settings.enabled || false);
        setMaxBackups(settings.maxBackups || 7);
        setBackupTime(settings.backupTime || '03:00');
      }
    } catch (error) {
      logger.error('Error loading system backup settings:', error);
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

      const response = await fetch(`${baseUrl}/api/system/backup/settings`, {
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
        throw new Error('Failed to save system backup settings');
      }

      showToast('System backup settings saved successfully', 'success');
    } catch (error) {
      logger.error('Error saving system backup settings:', error);
      showToast(`Failed to save settings: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleManualBackup = async () => {
    try {
      setIsCreatingBackup(true);
      showToast('Creating system backup...', 'info');

      const baseUrl = await apiService.getBaseUrl();

      // Get CSRF token
      const csrfToken = sessionStorage.getItem('csrfToken');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/system/backup`, {
        method: 'POST',
        headers,
        credentials: 'same-origin'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.details || 'Failed to create system backup');
      }

      const result = await response.json();
      showToast(`System backup created successfully: ${result.dirname}`, 'success');

      // Refresh backup list if modal is open
      if (isBackupModalOpen) {
        handleShowBackups();
      }
    } catch (error) {
      logger.error('Error creating system backup:', error);
      showToast(`Failed to create backup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsCreatingBackup(false);
    }
  };

  const handleShowBackups = async () => {
    try {
      setIsLoadingBackups(true);
      const baseUrl = await apiService.getBaseUrl();

      const response = await fetch(`${baseUrl}/api/system/backup/list`, {
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error('Failed to load system backup list');
      }

      const backups = await response.json();
      setBackupList(backups);
      setIsBackupModalOpen(true);
    } catch (error) {
      logger.error('Error loading system backup list:', error);
      showToast(`Failed to load backup list: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleDownloadBackup = async (dirname: string) => {
    try {
      showToast('Downloading system backup...', 'info');
      const baseUrl = await apiService.getBaseUrl();

      const response = await fetch(`${baseUrl}/api/system/backup/download/${encodeURIComponent(dirname)}`, {
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error('Failed to download system backup');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${dirname}.tar.gz`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      showToast('System backup downloaded successfully', 'success');
    } catch (error) {
      logger.error('Error downloading system backup:', error);
      showToast(`Failed to download backup: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    }
  };

  const handleDeleteBackup = async (dirname: string) => {
    if (!confirm(`Are you sure you want to delete the system backup "${dirname}"?`)) {
      return;
    }

    try {
      const baseUrl = await apiService.getBaseUrl();

      // Get CSRF token
      const csrfToken = sessionStorage.getItem('csrfToken');
      const headers: Record<string, string> = {};
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/system/backup/delete/${encodeURIComponent(dirname)}`, {
        method: 'DELETE',
        headers,
        credentials: 'same-origin'
      });

      if (!response.ok) {
        throw new Error('Failed to delete system backup');
      }

      showToast('System backup deleted successfully', 'success');
      // Refresh the backup list
      handleShowBackups();
    } catch (error) {
      logger.error('Error deleting system backup:', error);
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
      <h3>🗄️ System Backup Management</h3>

      <div style={{
        backgroundColor: 'var(--ctp-surface0)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>About System Backups</h4>
        <p style={{ color: 'var(--ctp-subtext0)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          System backups export your complete MeshMonitor database including message history, node information,
          telemetry data, user accounts, and system settings. Each backup is a collection of JSON files with
          integrity checksums and version metadata. Use system backups for disaster recovery, server migration,
          or database rollback.
        </p>
        <div style={{
          backgroundColor: 'var(--ctp-yellow)',
          color: 'var(--ctp-base)',
          padding: '0.75rem',
          borderRadius: '6px',
          marginTop: '1rem',
          fontSize: '0.9rem'
        }}>
          <strong>⚠️ Restore Note:</strong> To restore a system backup, you must set the <code>RESTORE_FROM_BACKUP</code> environment
          variable and restart the container. Restores cannot be done through the UI for safety reasons.
        </div>
      </div>

      {/* Manual Backup */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>Manual Backup</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          Create a system backup on demand. Backup will be saved to <code>/data/system-backups</code>.
        </p>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <button
            className="settings-button primary"
            onClick={handleManualBackup}
            disabled={isCreatingBackup}
          >
            {isCreatingBackup ? 'Creating...' : '📦 Create System Backup'}
          </button>
          <button
            className="settings-button secondary"
            onClick={handleShowBackups}
            disabled={isLoadingBackups}
          >
            {isLoadingBackups ? 'Loading...' : '📋 View Saved Backups'}
          </button>
        </div>
      </div>

      {/* Automated Backups */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>Automated Backups</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          Schedule automatic system backups to run daily at a specific time.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoBackupEnabled}
              onChange={(e) => setAutoBackupEnabled(e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <span>Enable automatic system backups</span>
          </label>

          {autoBackupEnabled && (
            <>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Backup Time (24-hour format)
                </label>
                <input
                  type="time"
                  value={backupTime}
                  onChange={(e) => setBackupTime(e.target.value)}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--ctp-surface2)',
                    backgroundColor: 'var(--ctp-surface0)',
                    color: 'var(--ctp-text)',
                    fontSize: '1rem'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  Maximum Backups to Keep
                </label>
                <input
                  type="number"
                  value={maxBackups}
                  onChange={(e) => setMaxBackups(parseInt(e.target.value) || 7)}
                  min="1"
                  max="365"
                  style={{
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--ctp-surface2)',
                    backgroundColor: 'var(--ctp-surface0)',
                    color: 'var(--ctp-text)',
                    fontSize: '1rem',
                    width: '100px'
                  }}
                />
                <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                  Older backups will be automatically deleted when this limit is exceeded.
                </p>
              </div>
            </>
          )}

          <button
            className="settings-button primary"
            onClick={handleSaveBackupSettings}
            disabled={isSavingSettings}
          >
            {isSavingSettings ? 'Saving...' : '💾 Save Backup Settings'}
          </button>
        </div>
      </div>

      {/* Backup List Modal */}
      {isBackupModalOpen && (
        <div className="modal-overlay" onClick={() => setIsBackupModalOpen(false)}>
          <div className="modal-content backup-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>📦 Saved System Backups</h3>
              <button
                className="modal-close"
                onClick={() => setIsBackupModalOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="backup-list">
              {backupList.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--ctp-subtext0)', padding: '2rem' }}>
                  No system backups found. Create one to get started!
                </p>
              ) : (
                <table className="backup-table">
                  <thead>
                    <tr>
                      <th>Backup Directory</th>
                      <th>Created</th>
                      <th>Type</th>
                      <th>Version</th>
                      <th>Tables</th>
                      <th>Size</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupList.map((backup) => (
                      <tr key={backup.dirname}>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>{backup.dirname}</td>
                        <td>{formatTimestamp(backup.timestamp)}</td>
                        <td>
                          <span className={`backup-type-badge ${backup.type}`}>
                            {backup.type === 'automatic' ? '🤖 Auto' : '👤 Manual'}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                          v{backup.meshmonitorVersion}
                        </td>
                        <td style={{ textAlign: 'center' }}>{backup.tableCount}</td>
                        <td>{formatFileSize(backup.size)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                              className="backup-action-button download"
                              onClick={() => handleDownloadBackup(backup.dirname)}
                              title="Download backup"
                            >
                              📥
                            </button>
                            <button
                              className="backup-action-button delete"
                              onClick={() => handleDeleteBackup(backup.dirname)}
                              title="Delete backup"
                            >
                              🗑️
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="settings-button secondary"
                onClick={() => setIsBackupModalOpen(false)}
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

export default SystemBackupSection;
