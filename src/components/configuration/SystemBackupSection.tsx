import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import { useSaveBar } from '../../hooks/useSaveBar';
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
  const { t } = useTranslation();
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
  const [saveCounter, setSaveCounter] = useState(0); // Triggers hasChanges recalculation

  // Track initial values loaded from API for change detection
  const initialValuesRef = useRef({
    autoBackupEnabled: false,
    maxBackups: 7,
    backupTime: '03:00'
  });

  // Calculate if there are unsaved changes
  // saveCounter forces recalculation after save updates initialValuesRef
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      autoBackupEnabled !== initial.autoBackupEnabled ||
      maxBackups !== initial.maxBackups ||
      backupTime !== initial.backupTime
    );
  }, [autoBackupEnabled, maxBackups, backupTime, saveCounter]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setAutoBackupEnabled(initial.autoBackupEnabled);
    setMaxBackups(initial.maxBackups);
    setBackupTime(initial.backupTime);
  }, []);

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
        const enabled = settings.enabled || false;
        const max = settings.maxBackups || 7;
        const time = settings.backupTime || '03:00';
        setAutoBackupEnabled(enabled);
        setMaxBackups(max);
        setBackupTime(time);
        // Update initial values to match loaded settings
        initialValuesRef.current = {
          autoBackupEnabled: enabled,
          maxBackups: max,
          backupTime: time
        };
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

      // Update initial values to match saved settings
      initialValuesRef.current = {
        autoBackupEnabled,
        maxBackups,
        backupTime
      };
      // Trigger hasChanges recalculation
      setSaveCounter(c => c + 1);

      showToast(t('system_backup.toast_settings_saved'), 'success');
    } catch (error) {
      logger.error('Error saving system backup settings:', error);
      showToast(t('system_backup.toast_settings_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Register with SaveBar
  useSaveBar({
    id: 'system-backup',
    sectionName: t('system_backup.title'),
    hasChanges,
    isSaving: isSavingSettings,
    onSave: handleSaveBackupSettings,
    onDismiss: resetChanges
  });

  const handleManualBackup = async () => {
    try {
      setIsCreatingBackup(true);
      showToast(t('system_backup.toast_creating'), 'info');

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
      showToast(t('system_backup.toast_backup_created', { dirname: result.dirname }), 'success');

      // Refresh backup list if modal is open
      if (isBackupModalOpen) {
        handleShowBackups();
      }
    } catch (error) {
      logger.error('Error creating system backup:', error);
      showToast(t('system_backup.toast_backup_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
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
      showToast(t('system_backup.toast_list_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleDownloadBackup = async (dirname: string) => {
    try {
      showToast(t('system_backup.toast_downloading'), 'info');
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

      showToast(t('system_backup.toast_downloaded'), 'success');
    } catch (error) {
      logger.error('Error downloading system backup:', error);
      showToast(t('system_backup.toast_download_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    }
  };

  const handleDeleteBackup = async (dirname: string) => {
    if (!confirm(t('system_backup.confirm_delete', { dirname }))) {
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

      showToast(t('system_backup.toast_deleted'), 'success');
      // Refresh the backup list
      handleShowBackups();
    } catch (error) {
      logger.error('Error deleting system backup:', error);
      showToast(t('system_backup.toast_delete_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
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
      <h3>{t('system_backup.title')}</h3>

      <div style={{
        backgroundColor: 'var(--ctp-surface0)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>{t('system_backup.about_title')}</h4>
        <p style={{ color: 'var(--ctp-subtext0)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          {t('system_backup.about_description')}
        </p>
        <div style={{
          backgroundColor: 'var(--ctp-yellow)',
          color: 'var(--ctp-base)',
          padding: '0.75rem',
          borderRadius: '6px',
          marginTop: '1rem',
          fontSize: '0.9rem'
        }}>
          <strong>{t('system_backup.restore_warning_title')}</strong> {t('system_backup.restore_warning_description')}
        </div>
      </div>

      {/* Manual Backup */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('system_backup.manual_title')}</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {t('system_backup.manual_description')}
        </p>
        <div className="settings-buttons">
          <button
            className="save-button"
            onClick={handleManualBackup}
            disabled={isCreatingBackup}
          >
            {isCreatingBackup ? t('system_backup.creating') : t('system_backup.create_button')}
          </button>
          <button
            className="reset-button"
            onClick={handleShowBackups}
            disabled={isLoadingBackups}
          >
            {isLoadingBackups ? t('backup_management.loading') : t('system_backup.view_backups')}
          </button>
        </div>
      </div>

      {/* Automated Backups */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('system_backup.auto_title')}</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {t('system_backup.auto_description')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoBackupEnabled}
              onChange={(e) => setAutoBackupEnabled(e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <span>{t('system_backup.enable_auto')}</span>
          </label>

          {autoBackupEnabled && (
            <>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  {t('system_backup.backup_time')}
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
                  {t('system_backup.max_backups')}
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
                  {t('system_backup.max_backups_hint')}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Backup List Modal */}
      {isBackupModalOpen && (
        <div className="modal-overlay" onClick={() => setIsBackupModalOpen(false)}>
          <div className="modal-content backup-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('system_backup.modal_title')}</h3>
              <button
                className="modal-close"
                onClick={() => setIsBackupModalOpen(false)}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>

            <div className="backup-list">
              {backupList.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--ctp-subtext0)', padding: '2rem' }}>
                  {t('system_backup.no_backups')}
                </p>
              ) : (
                <table className="backup-table">
                  <thead>
                    <tr>
                      <th>{t('system_backup.table_directory')}</th>
                      <th>{t('system_backup.table_created')}</th>
                      <th>{t('system_backup.table_type')}</th>
                      <th>{t('system_backup.table_version')}</th>
                      <th>{t('system_backup.table_tables')}</th>
                      <th>{t('system_backup.table_size')}</th>
                      <th>{t('system_backup.table_actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupList.map((backup) => (
                      <tr key={backup.dirname}>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>{backup.dirname}</td>
                        <td>{formatTimestamp(backup.timestamp)}</td>
                        <td>
                          <span className={`backup-type-badge ${backup.type}`}>
                            {backup.type === 'automatic' ? t('backup_management.type_auto') : t('backup_management.type_manual')}
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
                              title={t('backup_management.download')}
                            >
                              📥
                            </button>
                            <button
                              className="backup-action-button delete"
                              onClick={() => handleDeleteBackup(backup.dirname)}
                              title={t('backup_management.delete')}
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
                className="reset-button"
                onClick={() => setIsBackupModalOpen(false)}
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SystemBackupSection;
