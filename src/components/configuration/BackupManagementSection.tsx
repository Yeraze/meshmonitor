import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import { useSaveBar } from '../../hooks/useSaveBar';
import { useSource } from '../../contexts/SourceContext';
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
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { sourceId } = useSource();

  // State
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(false);
  const [maxBackups, setMaxBackups] = useState(7);
  const [backupTime, setBackupTime] = useState('02:00');
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [backupList, setBackupList] = useState<BackupFile[]>([]);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [restoringFilename, setRestoringFilename] = useState<string | null>(null);
  const [saveCounter, setSaveCounter] = useState(0); // Triggers hasChanges recalculation

  // Track initial values loaded from API for change detection
  const initialValuesRef = useRef({
    autoBackupEnabled: false,
    maxBackups: 7,
    backupTime: '02:00'
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
    void loadBackupSettings();
  }, []);

  const loadBackupSettings = async () => {
    try {
      const settings = await apiService.get<{ enabled?: boolean; maxBackups?: number; backupTime?: string }>('/api/backup/settings');
      const enabled = settings.enabled || false;
      const max = settings.maxBackups || 7;
      const time = settings.backupTime || '02:00';
      setAutoBackupEnabled(enabled);
      setMaxBackups(max);
      setBackupTime(time);
      // Update initial values to match loaded settings
      initialValuesRef.current = {
        autoBackupEnabled: enabled,
        maxBackups: max,
        backupTime: time
      };
    } catch (error) {
      // Preserve the prior silent-ignore on a non-ok HTTP response; only a
      // genuine network/transport failure gets logged (same split as the
      // old `if (response.ok) {...}` with no else branch).
      if (error instanceof ApiError) return;
      logger.error('Error loading backup settings:', error);
    }
  };

  const handleSaveBackupSettings = async () => {
    try {
      setIsSavingSettings(true);
      await apiService.post('/api/backup/settings', {
        enabled: autoBackupEnabled,
        maxBackups,
        backupTime
      });

      // Update initial values to match saved settings
      initialValuesRef.current = {
        autoBackupEnabled,
        maxBackups,
        backupTime
      };
      // Trigger hasChanges recalculation
      setSaveCounter(c => c + 1);

      showToast(t('backup_management.toast_settings_saved'), 'success');
    } catch (error) {
      logger.error('Error saving backup settings:', error);
      showToast(t('backup_management.toast_settings_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Register with SaveBar
  useSaveBar({
    id: 'backup-management',
    sectionName: t('backup_management.title'),
    hasChanges,
    isSaving: isSavingSettings,
    onSave: handleSaveBackupSettings,
    onDismiss: resetChanges
  });

  const handleManualBackup = async () => {
    try {
      showToast(t('backup_management.toast_creating_backup'), 'info');

      // Scope the backup to the currently-selected source so multi-source
      // setups back up the active source rather than always the primary one.
      // When sourceId is null (legacy/single-source view) the backend falls
      // back to the primary manager, preserving existing behavior.
      const endpoint = sourceId
        ? `/api/device/backup?save=true&sourceId=${encodeURIComponent(sourceId)}`
        : '/api/device/backup?save=true';
      await apiService.download(endpoint, { defaultName: 'meshtastic-backup.yaml' });

      showToast(t('backup_management.toast_backup_created'), 'success');
      if (onBackupCreated) onBackupCreated();
    } catch (error) {
      logger.error('Error creating backup:', error);
      showToast(t('backup_management.toast_backup_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    }
  };

  const handleShowBackups = async () => {
    try {
      setIsLoadingBackups(true);
      const backups = await apiService.get<BackupFile[]>('/api/backup/list');
      setBackupList(backups);
      setIsBackupModalOpen(true);
    } catch (error) {
      logger.error('Error loading backup list:', error);
      showToast(t('backup_management.toast_list_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const handleDownloadBackup = async (filename: string) => {
    try {
      const yamlContent = await apiService.getText(`/api/backup/download/${encodeURIComponent(filename)}`);

      const blob = new Blob([yamlContent], { type: 'application/x-yaml' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      showToast(t('backup_management.toast_downloaded'), 'success');
    } catch (error) {
      logger.error('Error downloading backup:', error);
      showToast(t('backup_management.toast_download_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    }
  };

  const handleRestoreBackup = async (filename: string) => {
    if (!confirm(t('backup_management.confirm_restore', { filename }))) {
      return;
    }

    try {
      setRestoringFilename(filename);
      showToast(t('backup_management.toast_restoring'), 'info');

      // Server envelope: ok(res, result) => { success, data: { applied, failed, channels, requiresReboot } }.
      // ApiService does not unwrap `data`, so read result off the `data` field.
      const resp = await apiService.post<{ data?: { failed?: unknown[]; requiresReboot?: boolean } }>(
        `/api/backup/restore/${encodeURIComponent(filename)}`,
        sourceId ? { sourceId } : {}
      );
      const failedCount = resp?.data?.failed?.length ?? 0;
      // Only mention a reboot when the backend actually applied a change that
      // needs one (a successful LoRa write) — over-warning confuses users, and
      // silently dropping it left them unaware the device restarts.
      const requiresReboot = resp?.data?.requiresReboot ?? false;

      if (failedCount > 0) {
        showToast(
          t(requiresReboot ? 'backup_management.toast_restored_partial_reboot' : 'backup_management.toast_restored_partial', { failed: failedCount }),
          'success'
        );
      } else {
        showToast(
          t(requiresReboot ? 'backup_management.toast_restored_reboot' : 'backup_management.toast_restored'),
          'success'
        );
      }
    } catch (error) {
      logger.error('Error restoring backup:', error);
      showToast(t('backup_management.toast_restore_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setRestoringFilename(null);
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(t('backup_management.confirm_delete', { filename }))) {
      return;
    }

    try {
      await apiService.delete(`/api/backup/delete/${encodeURIComponent(filename)}`);

      showToast(t('backup_management.toast_deleted'), 'success');
      // Refresh the backup list
      void handleShowBackups();
    } catch (error) {
      logger.error('Error deleting backup:', error);
      showToast(t('backup_management.toast_delete_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
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
      <h3>{t('backup_management.title')}</h3>

      <div style={{
        backgroundColor: 'var(--color-surface)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>{t('backup_management.about_title')}</h4>
        <p style={{ color: 'var(--color-text-subtle)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          {t('backup_management.about_description')}
        </p>
      </div>

      {/* Manual Backup */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('backup_management.manual_title')}</h4>
        <p style={{ color: 'var(--color-text-subtle)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {t('backup_management.manual_description')}
        </p>
        <button
          onClick={handleManualBackup}
          style={{
            backgroundColor: 'var(--color-accent-alt)',
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
          {t('backup_management.create_button')}
        </button>
        <button
          onClick={handleShowBackups}
          disabled={isLoadingBackups}
          style={{
            backgroundColor: 'var(--color-accent)',
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
          {isLoadingBackups ? t('backup_management.loading') : t('backup_management.show_backups')}
        </button>
      </div>

      {/* Automated Backup Settings */}
      <div>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('backup_management.auto_title')}</h4>
        <p style={{ color: 'var(--color-text-subtle)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {t('backup_management.auto_description')}
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
            <span style={{ fontWeight: 'bold' }}>{t('backup_management.enable_auto')}</span>
          </label>

          {/* Max Backups to Keep */}
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('backup_management.max_backups')}
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
                border: '1px solid var(--color-surface-active)',
                backgroundColor: 'var(--color-surface)',
                color: 'var(--color-text)',
                width: '100px',
                opacity: autoBackupEnabled ? 1 : 0.5
              }}
            />
            <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)', fontSize: '0.9rem' }}>
              {t('backup_management.max_backups_hint')}
            </span>
          </div>

          {/* Backup Time */}
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('backup_management.backup_time')}
            </label>
            <input
              type="time"
              value={backupTime}
              onChange={(e) => setBackupTime(e.target.value)}
              disabled={!autoBackupEnabled}
              style={{
                padding: '0.5rem',
                borderRadius: '4px',
                border: '1px solid var(--color-surface-active)',
                backgroundColor: 'var(--color-surface)',
                color: 'var(--color-text)',
                width: '150px',
                opacity: autoBackupEnabled ? 1 : 0.5
              }}
            />
            <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)', fontSize: '0.9rem' }}>
              {t('backup_management.backup_time_hint')}
            </span>
          </div>
        </div>
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
            <h3>{t('backup_management.modal_title')}</h3>

            {backupList.length === 0 ? (
              <p style={{ color: 'var(--color-text-subtle)' }}>
                {t('backup_management.no_backups')}
              </p>
            ) : (
              <div>
                <table className="backup-table">
                  <thead>
                    <tr>
                      <th>{t('backup_management.table_filename')}</th>
                      <th>{t('backup_management.table_date')}</th>
                      <th>{t('backup_management.table_type')}</th>
                      <th>{t('backup_management.table_size')}</th>
                      <th>{t('backup_management.table_actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupList.map((backup) => (
                      <tr key={backup.filename}>
                        <td data-label={`${t('backup_management.table_filename')}:`} className="backup-filename">
                          {backup.filename}
                        </td>
                        <td data-label={`${t('backup_management.table_date')}:`} className="backup-date">
                          {formatTimestamp(backup.timestamp)}
                        </td>
                        <td data-label={`${t('backup_management.table_type')}:`}>
                          <span className={`backup-type-badge ${backup.type === 'automatic' ? 'automatic' : 'manual'}`}>
                            {backup.type === 'automatic' ? t('backup_management.type_auto') : t('backup_management.type_manual')}
                          </span>
                        </td>
                        <td data-label={`${t('backup_management.table_size')}:`} className="backup-size">
                          {formatFileSize(backup.size)}
                        </td>
                        <td>
                          <div className="backup-actions">
                            <button
                              onClick={() => handleDownloadBackup(backup.filename)}
                              className="backup-btn download"
                            >
                              {t('backup_management.download')}
                            </button>
                            <button
                              onClick={() => handleRestoreBackup(backup.filename)}
                              disabled={restoringFilename !== null}
                              className="backup-btn restore"
                              style={restoringFilename !== null ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
                            >
                              {restoringFilename === backup.filename
                                ? t('backup_management.restoring')
                                : t('backup_management.restore')}
                            </button>
                            <button
                              onClick={() => handleDeleteBackup(backup.filename)}
                              disabled={restoringFilename !== null}
                              className="backup-btn delete"
                            >
                              {t('backup_management.delete')}
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
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BackupManagementSection;
