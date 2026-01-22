import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface RemoteAdminScannerSectionProps {
  baseUrl: string;
}

interface ScanLogEntry {
  nodeNum: number;
  nodeName: string | null;
  timestamp: number;
  hasRemoteAdmin: boolean;
  firmwareVersion: string | null;
}

interface ScannerSettings {
  intervalMinutes: number;
  expirationHours: number;
}

const RemoteAdminScannerSection: React.FC<RemoteAdminScannerSectionProps> = ({
  baseUrl,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  // Local state
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localInterval, setLocalInterval] = useState(5);
  const [expirationHours, setExpirationHours] = useState(168);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Initial settings for change detection
  const [initialSettings, setInitialSettings] = useState<ScannerSettings | null>(null);

  // Scan log
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);

  // Stats
  const [stats, setStats] = useState({
    totalNodes: 0,
    nodesWithAdmin: 0,
    nodesChecked: 0,
  });

  // Fetch current settings
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/settings`);
        if (response.ok) {
          const data = await response.json();
          const interval = parseInt(data.remoteAdminScannerIntervalMinutes) || 0;
          const expiration = parseInt(data.remoteAdminScannerExpirationHours) || 168;

          setLocalEnabled(interval > 0);
          setLocalInterval(interval > 0 ? interval : 5);
          setExpirationHours(expiration);
          setInitialSettings({ intervalMinutes: interval, expirationHours: expiration });
        }
      } catch (error) {
        console.error('Failed to fetch scanner settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, [baseUrl, csrfFetch]);

  // Fetch scan log and stats
  useEffect(() => {
    const fetchLogAndStats = async () => {
      try {
        // Fetch nodes to get stats
        const nodesResponse = await csrfFetch(`${baseUrl}/api/nodes`);
        if (nodesResponse.ok) {
          const nodes = await nodesResponse.json();
          const nodesWithPublicKey = nodes.filter((n: any) => n.publicKey);
          const nodesWithAdmin = nodesWithPublicKey.filter((n: any) => n.hasRemoteAdmin === true);
          const nodesChecked = nodesWithPublicKey.filter((n: any) => n.lastRemoteAdminCheck);

          setStats({
            totalNodes: nodesWithPublicKey.length,
            nodesWithAdmin: nodesWithAdmin.length,
            nodesChecked: nodesChecked.length,
          });

          // Build scan log from recent checks
          const recentlyChecked = nodesWithPublicKey
            .filter((n: any) => n.lastRemoteAdminCheck)
            .sort((a: any, b: any) => (b.lastRemoteAdminCheck || 0) - (a.lastRemoteAdminCheck || 0))
            .slice(0, 20)
            .map((n: any) => {
              let firmwareVersion = null;
              if (n.remoteAdminMetadata) {
                try {
                  const metadata = JSON.parse(n.remoteAdminMetadata);
                  firmwareVersion = metadata.firmwareVersion || null;
                } catch {
                  // Ignore JSON parse errors
                }
              }
              return {
                nodeNum: n.nodeNum,
                nodeName: n.user?.longName || n.longName || null,
                timestamp: n.lastRemoteAdminCheck,
                hasRemoteAdmin: n.hasRemoteAdmin === true,
                firmwareVersion,
              };
            });
          setScanLog(recentlyChecked);
        }
      } catch (error) {
        console.error('Failed to fetch scan log:', error);
      }
    };

    fetchLogAndStats();

    // Refresh every 30 seconds if enabled
    const intervalId = setInterval(() => {
      if (localEnabled) {
        fetchLogAndStats();
      }
    }, 30000);

    return () => clearInterval(intervalId);
  }, [baseUrl, csrfFetch, localEnabled]);

  // Check for changes
  useEffect(() => {
    if (!initialSettings) return;

    const currentInterval = localEnabled ? localInterval : 0;
    const intervalChanged = currentInterval !== initialSettings.intervalMinutes;
    const expirationChanged = expirationHours !== initialSettings.expirationHours;

    setHasChanges(intervalChanged || expirationChanged);
  }, [localEnabled, localInterval, expirationHours, initialSettings]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const intervalToSave = localEnabled ? localInterval : 0;

      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteAdminScannerIntervalMinutes: intervalToSave.toString(),
          remoteAdminScannerExpirationHours: expirationHours.toString(),
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      setInitialSettings({ intervalMinutes: intervalToSave, expirationHours });
      setHasChanges(false);
      showToast(t('automation.remote_admin_scanner.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save scanner settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}>
        {t('common.loading')}...
      </div>
    );
  }

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.remote_admin_scanner.title')}
          <a
            href="https://meshmonitor.org/features/automation#remote-admin-scanner"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="btn-primary"
          style={{
            padding: '0.5rem 1.5rem',
            fontSize: '14px',
            opacity: hasChanges ? 1 : 0.5,
            cursor: hasChanges ? 'pointer' : 'not-allowed'
          }}
        >
          {isSaving ? t('automation.saving') : t('automation.save_changes')}
        </button>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.remote_admin_scanner.description')}
        </p>

        {/* Stats Panel */}
        <div style={{
          marginLeft: '1.75rem',
          marginBottom: '1.5rem',
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '6px',
          display: 'flex',
          gap: '2rem',
        }}>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 600, color: 'var(--ctp-blue)' }}>
              {stats.nodesWithAdmin}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.remote_admin_scanner.nodes_with_admin')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 600, color: 'var(--ctp-text)' }}>
              {stats.nodesChecked}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.remote_admin_scanner.nodes_checked')}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 600, color: 'var(--ctp-subtext0)' }}>
              {stats.totalNodes}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.remote_admin_scanner.eligible_nodes')}
            </div>
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="scannerInterval">
            {t('automation.remote_admin_scanner.interval')}
            <span className="setting-description">
              {t('automation.remote_admin_scanner.interval_description')}
            </span>
          </label>
          <input
            id="scannerInterval"
            type="number"
            min="1"
            max="60"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value) || 5)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="scannerExpiration">
            {t('automation.remote_admin_scanner.expiration_hours')}
            <span className="setting-description">
              {t('automation.remote_admin_scanner.expiration_hours_description')}
            </span>
          </label>
          <input
            id="scannerExpiration"
            type="number"
            min="24"
            max="168"
            value={expirationHours}
            onChange={(e) => setExpirationHours(parseInt(e.target.value) || 168)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        {/* Scan Log */}
        {localEnabled && (
          <div className="setting-item" style={{ marginTop: '2rem' }}>
            <h4 style={{ marginBottom: '0.75rem', color: 'var(--ctp-text)' }}>
              {t('automation.remote_admin_scanner.recent_log')}
            </h4>
            <div style={{
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '6px',
              overflow: 'hidden',
              marginLeft: '1.75rem'
            }}>
              {scanLog.length === 0 ? (
                <div style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: 'var(--ctp-subtext0)',
                  fontSize: '12px'
                }}>
                  {t('automation.remote_admin_scanner.no_log_entries')}
                </div>
              ) : (
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '12px'
                }}>
                  <thead>
                    <tr style={{ background: 'var(--ctp-surface1)' }}>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                        {t('automation.remote_admin_scanner.log_timestamp')}
                      </th>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                        {t('automation.remote_admin_scanner.log_node')}
                      </th>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center', fontWeight: 500 }}>
                        {t('automation.remote_admin_scanner.log_status')}
                      </th>
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
                        {t('automation.remote_admin_scanner.log_firmware')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanLog.map((entry) => (
                      <tr key={`${entry.nodeNum}-${entry.timestamp}`} style={{ borderTop: '1px solid var(--ctp-surface1)' }}>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-text)' }}>
                          {entry.nodeName || `!${entry.nodeNum.toString(16).padStart(8, '0')}`}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', textAlign: 'center' }}>
                          {entry.hasRemoteAdmin ? (
                            <span style={{
                              color: 'var(--ctp-green)',
                              fontSize: '14px'
                            }} title={t('automation.remote_admin_scanner.status_has_admin')}>
                              ✓
                            </span>
                          ) : (
                            <span style={{
                              color: 'var(--ctp-red)',
                              fontSize: '14px'
                            }} title={t('automation.remote_admin_scanner.status_no_admin')}>
                              ✗
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
                          {entry.firmwareVersion || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default RemoteAdminScannerSection;
