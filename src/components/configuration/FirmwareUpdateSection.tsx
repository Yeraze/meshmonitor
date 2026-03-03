import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { usePoll } from '../../hooks/usePoll';

interface FirmwareUpdateSectionProps {
  baseUrl: string;
}

// Mirror the server-side types for the frontend
type UpdateState = 'idle' | 'awaiting-confirm' | 'in-progress' | 'success' | 'error';
type UpdateStep = 'preflight' | 'backup' | 'download' | 'extract' | 'flash' | 'verify' | null;
type FirmwareChannel = 'stable' | 'alpha' | 'custom';

interface PreflightInfo {
  currentVersion: string;
  targetVersion: string;
  gatewayIp: string;
  hwModel: string;
  boardName: string;
  platform: string;
}

interface UpdateStatus {
  state: UpdateState;
  step: UpdateStep;
  message: string;
  progress?: number;
  logs: string[];
  targetVersion?: string;
  error?: string;
  preflightInfo?: PreflightInfo;
  backupPath?: string;
  downloadUrl?: string;
  downloadSize?: number;
  matchedFile?: string;
  rejectedFiles?: Array<{ name: string; reason: string }>;
}

interface FirmwareRelease {
  tagName: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  assets: Array<{ name: string; downloadUrl: string; size: number }>;
}

interface FirmwareStatusResponse {
  success: boolean;
  status: UpdateStatus;
  channel: FirmwareChannel;
  customUrl: string;
  lastChecked: number | null;
}

interface FirmwareReleasesResponse {
  success: boolean;
  releases: FirmwareRelease[];
  channel: FirmwareChannel;
}

interface FirmwareBackup {
  filename: string;
  path: string;
  timestamp: number;
  size: number;
}

interface FirmwareBackupsResponse {
  success: boolean;
  backups: FirmwareBackup[];
}

const STEP_TITLES: Record<string, string> = {
  preflight: 'firmware.wizard_preflight_title',
  backup: 'firmware.wizard_backup_title',
  download: 'firmware.wizard_download_title',
  extract: 'firmware.wizard_extract_title',
  flash: 'firmware.wizard_flash_title',
  verify: 'firmware.wizard_verify_title',
};

const STEP_ORDER: Array<{ key: string; label: string }> = [
  { key: 'preflight', label: 'Preflight' },
  { key: 'backup', label: 'Backup' },
  { key: 'download', label: 'Download' },
  { key: 'extract', label: 'Extract' },
  { key: 'flash', label: 'Flash' },
  { key: 'verify', label: 'Verify' },
];

const FirmwareUpdateSection: React.FC<FirmwareUpdateSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // Derive gateway info from poll data
  const { data: pollData } = usePoll();
  const gatewayInfo = useMemo(() => {
    const config = pollData?.config;
    const localNodeInfo = config?.localNodeInfo as { nodeId?: string; nodeNum?: number } | undefined;
    const nodeId = localNodeInfo?.nodeId ?? '';
    const nodeNum = localNodeInfo?.nodeNum ?? 0;
    // Find the gateway node in the nodes array to get hwModel
    const gatewayNode = (pollData?.nodes ?? []).find(
      (n: any) => n.nodeNum === nodeNum || n.user?.id === nodeId
    );
    return {
      gatewayIp: config?.meshtasticNodeIp ?? '',
      firmwareVersion: config?.deviceMetadata?.firmwareVersion ?? '',
      hwModel: gatewayNode?.user?.hwModel ?? 0,
      nodeId,
      nodeNum,
    };
  }, [pollData]);

  // Local state
  const [channel, setChannel] = useState<FirmwareChannel>('stable');
  const [customUrl, setCustomUrl] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isSavingChannel, setIsSavingChannel] = useState(false);
  const [showRejectedFiles, setShowRejectedFiles] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  // Ref for auto-scrolling logs
  const logRef = useRef<HTMLPreElement>(null);

  // Query: firmware status (polls every 5s)
  const { data: statusData } = useQuery<FirmwareStatusResponse>({
    queryKey: ['firmware', 'status'],
    queryFn: async () => {
      const res = await csrfFetch(`${baseUrl}/api/firmware/status`);
      if (!res.ok) throw new Error('Failed to fetch firmware status');
      return res.json();
    },
    refetchInterval: 5000,
  });

  // Query: firmware releases (staleTime: 60s)
  const { data: releasesData } = useQuery<FirmwareReleasesResponse>({
    queryKey: ['firmware', 'releases'],
    queryFn: async () => {
      const res = await csrfFetch(`${baseUrl}/api/firmware/releases`);
      if (!res.ok) throw new Error('Failed to fetch firmware releases');
      return res.json();
    },
    staleTime: 60000,
  });

  // Query: firmware backups
  const { data: backupsData } = useQuery<FirmwareBackupsResponse>({
    queryKey: ['firmware', 'backups'],
    queryFn: async () => {
      const res = await csrfFetch(`${baseUrl}/api/firmware/backups`);
      if (!res.ok) throw new Error('Failed to fetch firmware backups');
      return res.json();
    },
  });

  // Live status from Socket.IO (set by useWebSocket)
  const liveStatus = queryClient.getQueryData<UpdateStatus>(['firmware', 'liveStatus']);

  // Determine effective status: prefer live status, fall back to polled status
  const effectiveStatus: UpdateStatus | undefined = liveStatus ?? statusData?.status;

  // Sync channel/customUrl from server on initial load
  useEffect(() => {
    if (statusData) {
      setChannel(statusData.channel);
      setCustomUrl(statusData.customUrl || '');
    }
  }, [statusData?.channel, statusData?.customUrl]);

  // Auto-scroll log output
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [effectiveStatus?.logs]);

  const releases = releasesData?.releases ?? [];
  const backups = backupsData?.backups ?? [];
  const lastChecked = statusData?.lastChecked ?? null;

  // ---- Handlers ----

  const handleSaveChannel = async () => {
    setIsSavingChannel(true);
    try {
      const body: Record<string, string> = { channel };
      if (channel === 'custom') {
        body.customUrl = customUrl;
      }
      const res = await csrfFetch(`${baseUrl}/api/firmware/channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save channel');
      }
      showToast(t('firmware.channel', 'Release channel saved'), 'success');
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['firmware', 'releases'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error saving channel', 'error');
    } finally {
      setIsSavingChannel(false);
    }
  };

  const handleCheckNow = async () => {
    setIsChecking(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/firmware/check`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to check for updates');
      }
      showToast(t('firmware.check_now', 'Check complete'), 'success');
      queryClient.invalidateQueries({ queryKey: ['firmware', 'releases'] });
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error checking for updates', 'error');
    } finally {
      setIsChecking(false);
    }
  };

  const handleInstall = async (release: FirmwareRelease) => {
    try {
      const body = {
        targetVersion: release.version,
        gatewayIp: gatewayInfo.gatewayIp,
        hwModel: gatewayInfo.hwModel,
        currentVersion: gatewayInfo.firmwareVersion,
      };
      const res = await csrfFetch(`${baseUrl}/api/firmware/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start update');
      }
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error starting update', 'error');
    }
  };

  const handleConfirm = async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    try {
      const body = {
        gatewayIp: effectiveStatus?.preflightInfo?.gatewayIp ?? gatewayInfo.gatewayIp,
        nodeId: gatewayInfo.nodeId,
      };
      const res = await csrfFetch(`${baseUrl}/api/firmware/update/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to confirm step');
      }
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error confirming step', 'error');
    } finally {
      setIsConfirming(false);
    }
  };

  const handleCancel = async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/firmware/update/cancel`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to cancel update');
      }
      showToast(t('firmware.wizard_cancel', 'Update cancelled'), 'success');
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error cancelling update', 'error');
    }
  };

  const handleDone = () => {
    // Reset status by re-fetching
    queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    queryClient.removeQueries({ queryKey: ['firmware', 'liveStatus'] });
  };

  const handleRestoreBackup = async (backup: FirmwareBackup) => {
    const confirmed = window.confirm(
      `Restore configuration from backup "${backup.filename}"?\nThis will overwrite current device configuration.`
    );
    if (!confirmed) return;

    try {
      const body = {
        gatewayIp: effectiveStatus?.preflightInfo?.gatewayIp ?? gatewayInfo.gatewayIp,
        backupPath: backup.path,
      };
      const res = await csrfFetch(`${baseUrl}/api/firmware/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to restore backup');
      }
      showToast(t('firmware.restore_backup', 'Backup restored'), 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error restoring backup', 'error');
    }
  };

  // ---- Render helpers ----

  const formatTimestamp = (ts: number | null): string => {
    if (!ts) return t('firmware.never_checked', 'Never');
    return new Date(ts).toLocaleString();
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStepTitle = (step: UpdateStep): string => {
    if (!step) return '';
    const key = STEP_TITLES[step];
    return key ? t(key, step) : step;
  };

  const isUpdateActive = effectiveStatus && effectiveStatus.state !== 'idle';

  return (
    <div id="settings-firmware" className="settings-section" style={{ marginTop: '2rem' }}>
      <h3>{t('firmware.title', 'Firmware Updates')}</h3>
      <p className="setting-description">{t('firmware.description', 'Manage firmware updates for your gateway node.')}</p>

      {/* Gateway Info */}
      {gatewayInfo.firmwareVersion && (
        <div className="setting-item" style={{ marginTop: '0.5rem' }}>
          <span className="setting-description">
            <strong>{t('firmware.current_version', 'Current Firmware')}:</strong> {gatewayInfo.firmwareVersion}
            {gatewayInfo.hwModel > 0 && (
              <> &nbsp;|&nbsp; <strong>{t('firmware.hardware_model', 'Hardware Model')}:</strong> {gatewayInfo.hwModel}</>
            )}
            {gatewayInfo.gatewayIp && (
              <> &nbsp;|&nbsp; <strong>IP:</strong> {gatewayInfo.gatewayIp}</>
            )}
          </span>
        </div>
      )}

      {/* Channel Selector */}
      <div className="setting-item" style={{ marginTop: '1rem' }}>
        <label htmlFor="firmware-channel">
          {t('firmware.channel', 'Release Channel')}
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select
            id="firmware-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as FirmwareChannel)}
            className="setting-input"
            style={{ flex: 1 }}
          >
            <option value="stable">{t('firmware.channel_stable', 'Stable')}</option>
            <option value="alpha">{t('firmware.channel_alpha', 'Alpha (Pre-release)')}</option>
            <option value="custom">{t('firmware.channel_custom', 'Custom URL')}</option>
          </select>
          <button
            className="save-button"
            onClick={handleSaveChannel}
            disabled={isSavingChannel}
            style={{ whiteSpace: 'nowrap' }}
          >
            {isSavingChannel ? '...' : t('firmware.save_channel', 'Save')}
          </button>
        </div>
      </div>

      {/* Custom URL Input */}
      {channel === 'custom' && (
        <div className="setting-item">
          <label htmlFor="firmware-custom-url">
            {t('firmware.channel_custom', 'Custom URL')}
          </label>
          <input
            id="firmware-custom-url"
            type="url"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder={t('firmware.custom_url_placeholder', 'https://example.com/firmware.bin')}
            className="setting-input"
            style={{ width: '100%' }}
          />
        </div>
      )}

      {/* Check Now + Last Checked */}
      <div className="setting-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--ctp-text)', fontSize: '0.9rem' }}>
          {t('firmware.last_checked', 'Last Checked')}: {formatTimestamp(lastChecked)}
        </span>
        <button
          className="save-button"
          onClick={handleCheckNow}
          disabled={isChecking}
        >
          {isChecking ? t('firmware.checking', 'Checking...') : t('firmware.check_now', 'Check Now')}
        </button>
      </div>

      {/* Update Wizard (shown when state !== idle) */}
      {isUpdateActive && effectiveStatus && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          borderRadius: '8px',
          backgroundColor: 'var(--ctp-surface0)',
          border: effectiveStatus.state === 'error'
            ? '1px solid var(--ctp-red)'
            : effectiveStatus.state === 'success'
              ? '1px solid #10b981'
              : '1px solid var(--ctp-blue)',
        }}>
          {/* Step progress indicator */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0',
            marginBottom: '1rem',
            padding: '0.5rem 0',
          }}>
            {STEP_ORDER.map((s, i) => {
              const currentIdx = STEP_ORDER.findIndex(x => x.key === effectiveStatus.step);
              const isComplete = effectiveStatus.state === 'success'
                || (currentIdx >= 0 && i < currentIdx)
                || (effectiveStatus.state === 'error' && i < currentIdx);
              const isCurrent = s.key === effectiveStatus.step;
              const isFailed = isCurrent && effectiveStatus.state === 'error';

              let dotColor = 'var(--ctp-surface2)'; // future
              if (isComplete) dotColor = '#10b981'; // green
              if (isCurrent && !isFailed) dotColor = 'var(--ctp-blue)';
              if (isFailed) dotColor = 'var(--ctp-red)';

              return (
                <React.Fragment key={s.key}>
                  {i > 0 && (
                    <div style={{
                      flex: 1,
                      height: '2px',
                      backgroundColor: isComplete ? '#10b981' : 'var(--ctp-surface2)',
                    }} />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '48px' }}>
                    <div style={{
                      width: isCurrent ? '14px' : '10px',
                      height: isCurrent ? '14px' : '10px',
                      borderRadius: '50%',
                      backgroundColor: dotColor,
                      border: isCurrent ? '2px solid var(--ctp-text)' : 'none',
                      transition: 'all 0.2s',
                    }} />
                    <span style={{
                      fontSize: '0.7rem',
                      color: isCurrent ? 'var(--ctp-text)' : 'var(--ctp-subtext0)',
                      fontWeight: isCurrent ? 600 : 400,
                      marginTop: '4px',
                    }}>
                      {s.label}
                    </span>
                  </div>
                </React.Fragment>
              );
            })}
          </div>

          {/* Step title & message */}
          <div style={{ marginBottom: '0.75rem' }}>
            <h4 style={{ margin: 0, color: 'var(--ctp-text)' }}>
              {getStepTitle(effectiveStatus.step)}
            </h4>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--ctp-text)', fontSize: '0.9rem' }}>
              {effectiveStatus.message}
            </p>
          </div>

          {/* Progress bar */}
          {effectiveStatus.progress !== undefined && effectiveStatus.progress > 0 && (
            <div style={{
              width: '100%',
              height: '6px',
              backgroundColor: 'var(--ctp-surface2)',
              borderRadius: '3px',
              marginBottom: '0.75rem',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.min(effectiveStatus.progress, 100)}%`,
                height: '100%',
                backgroundColor: 'var(--ctp-blue)',
                borderRadius: '3px',
                transition: 'width 0.3s ease',
              }} />
            </div>
          )}

          {/* Preflight info card */}
          {effectiveStatus.preflightInfo && (
            <div style={{
              padding: '0.75rem',
              borderRadius: '6px',
              backgroundColor: 'var(--ctp-surface1)',
              marginBottom: '0.75rem',
              fontSize: '0.85rem',
              lineHeight: '1.6',
            }}>
              <div><strong>{t('firmware.current_version', 'Current Firmware')}:</strong> {effectiveStatus.preflightInfo.currentVersion}</div>
              <div><strong>{t('firmware.version', 'Version')}:</strong> {effectiveStatus.preflightInfo.targetVersion}</div>
              <div><strong>Gateway IP:</strong> {effectiveStatus.preflightInfo.gatewayIp}</div>
              <div><strong>{t('firmware.hardware_model', 'Hardware Model')}:</strong> {effectiveStatus.preflightInfo.hwModel}</div>
              <div><strong>Board:</strong> {effectiveStatus.preflightInfo.boardName}</div>
              <div><strong>Platform:</strong> {effectiveStatus.preflightInfo.platform}</div>
            </div>
          )}

          {/* Extract results: matched file */}
          {effectiveStatus.matchedFile && (
            <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem' }}>
              <strong>{t('firmware.matched_file', 'Selected Firmware')}:</strong>{' '}
              <code style={{ color: 'var(--ctp-blue)' }}>{effectiveStatus.matchedFile}</code>
            </div>
          )}

          {/* Extract results: rejected files (collapsible) */}
          {effectiveStatus.rejectedFiles && effectiveStatus.rejectedFiles.length > 0 && (
            <div style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}>
              <button
                onClick={() => setShowRejectedFiles(!showRejectedFiles)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--ctp-text)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: '0.85rem',
                  textDecoration: 'underline',
                }}
              >
                {t('firmware.rejected_files', 'Rejected Files')} ({effectiveStatus.rejectedFiles.length})
                {showRejectedFiles ? ' \u25B2' : ' \u25BC'}
              </button>
              {showRejectedFiles && (
                <ul style={{
                  margin: '0.25rem 0 0 1rem',
                  padding: 0,
                  listStyle: 'disc',
                  color: 'var(--ctp-text)',
                  opacity: 0.8,
                }}>
                  {effectiveStatus.rejectedFiles.map((f, i) => (
                    <li key={i}><code>{f.name}</code> — {f.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Live log output */}
          {effectiveStatus.logs && effectiveStatus.logs.length > 0 && (
            <pre
              ref={logRef}
              style={{
                maxHeight: '200px',
                overflow: 'auto',
                padding: '0.5rem',
                borderRadius: '4px',
                backgroundColor: 'var(--ctp-base)',
                color: 'var(--ctp-text)',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                marginBottom: '0.75rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <code>{effectiveStatus.logs.join('\n')}</code>
            </pre>
          )}

          {/* Error message */}
          {effectiveStatus.state === 'error' && effectiveStatus.error && (
            <div style={{
              padding: '0.5rem 0.75rem',
              borderRadius: '4px',
              backgroundColor: 'rgba(235, 87, 87, 0.1)',
              color: 'var(--ctp-red)',
              fontSize: '0.85rem',
              marginBottom: '0.75rem',
            }}>
              {effectiveStatus.error}
            </div>
          )}

          {/* Reboot warning */}
          {effectiveStatus.step === 'extract' &&
            effectiveStatus.state === 'awaiting-confirm' && (
            <p style={{
              color: 'var(--ctp-peach)',
              fontSize: '0.85rem',
              margin: '0 0 0.75rem',
            }}>
              {t('firmware.reboot_warning', 'The node will reboot during the update and be briefly unavailable.')}
            </p>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            {effectiveStatus.state === 'awaiting-confirm' && (
              <button className="save-button" onClick={handleConfirm} disabled={isConfirming}>
                {isConfirming ? '⏳ Working...' : t('firmware.wizard_confirm', 'Confirm & Proceed')}
              </button>
            )}
            {(effectiveStatus.state === 'awaiting-confirm' || effectiveStatus.state === 'in-progress') && (
              <button className="danger-btn" onClick={handleCancel}>
                {t('firmware.wizard_cancel', 'Cancel Update')}
              </button>
            )}
            {effectiveStatus.state === 'success' && (
              <button className="save-button" onClick={handleDone}>
                Done
              </button>
            )}
            {effectiveStatus.state === 'error' && (
              <button className="save-button" onClick={handleDone}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* Version List Table (shown when idle) */}
      {!isUpdateActive && (
        <div style={{ marginTop: '1rem' }}>
          {releases.length === 0 ? (
            <p style={{ color: 'var(--ctp-text)', fontStyle: 'italic', fontSize: '0.9rem' }}>
              {t('firmware.no_releases', "No releases found. Click 'Check Now' to fetch available firmware versions.")}
            </p>
          ) : (
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.9rem',
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--ctp-surface2)' }}>
                  <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--ctp-text)' }}>
                    {t('firmware.version', 'Version')}
                  </th>
                  <th style={{ textAlign: 'left', padding: '0.5rem', color: 'var(--ctp-text)' }}>
                    {t('firmware.release_date', 'Release Date')}
                  </th>
                  <th style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--ctp-text)' }}>
                    {t('firmware.release_notes', 'Release Notes')}
                  </th>
                  <th style={{ textAlign: 'right', padding: '0.5rem', color: 'var(--ctp-text)' }}></th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => (
                  <tr key={release.tagName} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                    <td style={{ padding: '0.5rem', color: 'var(--ctp-text)' }}>
                      {release.version}
                      {release.prerelease && (
                        <span style={{
                          marginLeft: '0.5rem',
                          padding: '0.1rem 0.4rem',
                          fontSize: '0.75rem',
                          borderRadius: '3px',
                          backgroundColor: 'var(--ctp-peach)',
                          color: 'var(--ctp-base)',
                        }}>
                          alpha
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '0.5rem', color: 'var(--ctp-text)' }}>
                      {new Date(release.publishedAt).toLocaleDateString()}
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem' }}>
                      <a
                        href={release.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--accent-color)' }}
                      >
                        {t('firmware.release_notes', 'Release Notes')}
                      </a>
                    </td>
                    <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                      <button
                        className="save-button"
                        onClick={() => handleInstall(release)}
                        style={{ padding: '0.25rem 0.75rem', fontSize: '0.85rem' }}
                      >
                        {t('firmware.install', 'Install')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Configuration Backups */}
      <div style={{ marginTop: '2rem' }}>
        <h4 style={{ color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>
          {t('firmware.backups_title', 'Configuration Backups')}
        </h4>
        {backups.length === 0 ? (
          <p style={{ color: 'var(--ctp-text)', fontStyle: 'italic', fontSize: '0.9rem' }}>
            {t('firmware.no_backups', 'No configuration backups found.')}
          </p>
        ) : (
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9rem',
          }}>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.filename} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                  <td style={{ padding: '0.5rem', color: 'var(--ctp-text)' }}>
                    {backup.filename}
                  </td>
                  <td style={{ padding: '0.5rem', color: 'var(--ctp-text)' }}>
                    {new Date(backup.timestamp).toLocaleString()}
                  </td>
                  <td style={{ padding: '0.5rem', color: 'var(--ctp-text)' }}>
                    {formatBytes(backup.size)}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0.5rem' }}>
                    <button
                      className="save-button"
                      onClick={() => handleRestoreBackup(backup)}
                      style={{ padding: '0.25rem 0.75rem', fontSize: '0.85rem' }}
                    >
                      {t('firmware.restore_backup', 'Restore')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default FirmwareUpdateSection;
