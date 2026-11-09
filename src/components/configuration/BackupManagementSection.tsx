import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { useSource } from '../../contexts/SourceContext';
import { useAuth } from '../../contexts/AuthContext';
import '../../styles/BackupManagement.css';
import { ConfigSection } from '../shared/config/ConfigSection';
import BackupRestoreConfirmDialog, { type BackupProtocol, type BackupSummaryData } from './BackupRestoreConfirmDialog';

interface BackupFile {
  filename: string;
  timestamp: string;
  size: number;
  type: 'manual' | 'automatic';
  /** An unowned (legacy / orphaned) file; the server sends these to admins only. */
  legacy?: boolean;
}

interface BackupManagementSectionProps {
  onBackupCreated?: () => void;
  /** Which device type this section backs up. Default `meshtastic`. */
  protocol?: BackupProtocol;
  /** The source to act on. Default: the surrounding SourceContext. */
  sourceId?: string | null;
  /** False while the radio is offline: create and restore are disabled (list, download and delete still work). */
  connected?: boolean;
  /** False when the viewer lacks configuration:write: create, download, restore, delete and the schedule are disabled. */
  canWrite?: boolean;
}

/** Add `sourceId` to a URL's query string when a source is selected. */
function withSource(url: string, sourceId: string | null): string {
  if (!sourceId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sourceId=${encodeURIComponent(sourceId)}`;
}

const BackupManagementSection: React.FC<BackupManagementSectionProps> = ({
  onBackupCreated,
  protocol = 'meshtastic',
  sourceId: sourceIdProp,
  connected = true,
  canWrite = true,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { sourceId: contextSourceId } = useSource();
  const sourceId = sourceIdProp !== undefined ? sourceIdProp : contextSourceId;
  const { authStatus } = useAuth();
  const isAdmin = authStatus?.user?.isAdmin === true;
  const [lastAuto, setLastAuto] = useState<{ at: string | null; error: string | null }>({ at: null, error: null });
  const [pendingRestore, setPendingRestore] = useState<{ filename: string; summary: BackupSummaryData } | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #6285 reload the schedule when the source changes
  }, [sourceId]);

  const loadBackupSettings = async () => {
    try {
      const settings = await apiService.get<{
        enabled?: boolean; maxBackups?: number; backupTime?: string;
        lastAutomaticBackupAt?: string | null; lastAutomaticBackupError?: string | null;
      }>(withSource('/api/backup/settings', sourceId));
      setLastAuto({ at: settings.lastAutomaticBackupAt ?? null, error: settings.lastAutomaticBackupError ?? null });
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
        backupTime,
        ...(sourceId ? { sourceId } : {}),
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

  // Register with SaveBar. The scope blocks Save while a number field is blank (#5649).
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'backup-management',
    sectionName: t('backup_management.title'),
    hasChanges,
    isSaving: isSavingSettings,
    onSave: handleSaveBackupSettings,
    onDismiss: resetChanges,
    numberScope
  });

  const handleManualBackup = async () => {
    try {
      showToast(t('backup_management.toast_creating_backup'), 'info');

      // Always scoped to this section's source. When sourceId is null
      // (legacy/single-source view) the backend falls back to the primary
      // Meshtastic source, preserving existing behavior.
      const endpoint = withSource('/api/device/backup?save=true', sourceId);
      await apiService.download(endpoint, {
        defaultName: protocol === 'meshcore' ? 'meshcore-backup.yaml' : 'meshtastic-backup.yaml',
      });

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
      const backups = await apiService.get<BackupFile[]>(withSource('/api/backup/list', sourceId));
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
      const yamlContent = await apiService.getText(withSource(`/api/backup/download/${encodeURIComponent(filename)}`, sourceId));

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

  // Step 1: fetch the no-secret summary and show it in the confirm dialog.
  const handleRestoreBackup = async (filename: string) => {
    try {
      setRestoringFilename(filename);
      const resp = await apiService.get<{ data?: BackupSummaryData }>(
        withSource(`/api/backup/summary/${encodeURIComponent(filename)}`, sourceId),
      );
      if (!resp?.data) throw new Error(t('backup_management.summary_missing'));
      setPendingRestore({ filename, summary: resp.data });
    } catch (error) {
      logger.error('Error reading backup summary:', error);
      showToast(t('backup_management.toast_restore_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setRestoringFilename(null);
    }
  };

  // Step 2: the user confirmed in the dialog.
  const confirmRestore = async () => {
    if (!pendingRestore) return;
    const { filename, summary } = pendingRestore;
    setPendingRestore(null);
    try {
      setRestoringFilename(filename);
      showToast(t('backup_management.toast_restoring'), 'info');

      // Server envelope: ok(res, result) => { success, data: { applied, failed, channels, requiresReboot } }.
      // ApiService does not unwrap `data`, so read result off the `data` field.
      const resp = await apiService.post<{ data?: { failed?: unknown[]; requiresReboot?: boolean } }>(
        `/api/backup/restore/${encodeURIComponent(filename)}`,
        { ...(sourceId ? { sourceId } : {}), ...(summary.legacy ? { confirmLegacy: true } : {}) }
      );
      const failedCount = resp?.data?.failed?.length ?? 0;
      // Only mention a reboot when the backend actually applied a change that
      // needs one. Meshtastic restarts to apply LoRa; a MeshCore radio only
      // takes a changed BLE PIN at its next boot.
      const requiresReboot = resp?.data?.requiresReboot ?? false;
      const keySuffix = protocol === 'meshcore' ? '_meshcore_boot' : '_reboot';

      if (failedCount > 0) {
        showToast(
          t(requiresReboot ? `backup_management.toast_restored_partial${keySuffix}` : 'backup_management.toast_restored_partial', { failed: failedCount }),
          'success'
        );
      } else {
        showToast(
          t(requiresReboot ? `backup_management.toast_restored${keySuffix}` : 'backup_management.toast_restored'),
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
      await apiService.delete(withSource(`/api/backup/delete/${encodeURIComponent(filename)}`, sourceId));

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
    <NumberInputScope scope={numberScope}>
    <ConfigSection title={t('backup_management.title')}>

      <div style={{
        backgroundColor: 'var(--color-surface)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>{t('backup_management.about_title')}</h4>
        <p style={{ color: 'var(--color-text-subtle)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          {t(protocol === 'meshcore' ? 'backup_management.about_description_meshcore' : 'backup_management.about_description')}
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
          disabled={!connected || !canWrite}
          title={!connected ? t('backup_management.offline_hint') : undefined}
          style={{
            opacity: connected && canWrite ? 1 : 0.6,
            backgroundColor: 'var(--color-accent-alt)',
            color: '#fff',
            padding: '0.75rem 1.5rem',
            border: 'none',
            borderRadius: '4px',
            cursor: connected && canWrite ? 'pointer' : 'not-allowed',
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

        {(lastAuto.at || lastAuto.error) && (
          <p style={{ color: 'var(--color-text-subtle)', marginBottom: '1rem', fontSize: '0.85rem' }}>
            {lastAuto.error
              ? t('backup_management.last_auto_failed', { when: formatTimestamp(lastAuto.at ?? ''), reason: t(`backup_management.auto_error_${lastAuto.error}`, lastAuto.error) })
              : t('backup_management.last_auto_ok', { when: formatTimestamp(lastAuto.at ?? '') })}
          </p>
        )}

        {/* No bottom margin: this is the last block on the Configuration page,
            and a margin here collapses through the section and adds 16px
            below the list (the stack spaces sections itself). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Enable Automatic Backups */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={autoBackupEnabled}
              onChange={(e) => setAutoBackupEnabled(e.target.checked)}
              disabled={!canWrite}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <span style={{ fontWeight: 'bold' }}>{t('backup_management.enable_auto')}</span>
          </label>

          {/* Max Backups to Keep */}
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('backup_management.max_backups')}
            </label>
            <NumberInput
              min={1}
              max={365}
              integer
              value={maxBackups}
              onChange={setMaxBackups}
              disabled={!autoBackupEnabled || !canWrite}
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
              disabled={!autoBackupEnabled || !canWrite}
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
                          {backup.legacy && isAdmin && (
                            <span className="backup-type-badge manual" style={{ marginLeft: '0.5rem' }}>
                              {t('backup_management.legacy_badge')}
                            </span>
                          )}
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
                              disabled={!canWrite}
                              className="backup-btn download"
                            >
                              {t('backup_management.download')}
                            </button>
                            <button
                              onClick={() => handleRestoreBackup(backup.filename)}
                              disabled={restoringFilename !== null || !connected || !canWrite}
                              title={!connected ? t('backup_management.offline_hint') : undefined}
                              className="backup-btn restore"
                              style={restoringFilename !== null || !connected || !canWrite ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
                            >
                              {restoringFilename === backup.filename
                                ? t('backup_management.restoring')
                                : t('backup_management.restore')}
                            </button>
                            <button
                              onClick={() => handleDeleteBackup(backup.filename)}
                              disabled={restoringFilename !== null || !canWrite}
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
      {pendingRestore && (
        <BackupRestoreConfirmDialog
          filename={pendingRestore.filename}
          protocol={protocol}
          summary={pendingRestore.summary}
          onConfirm={() => { void confirmRestore(); }}
          onCancel={() => setPendingRestore(null)}
        />
      )}
    </ConfigSection>
    </NumberInputScope>
  );
};

export default BackupManagementSection;
