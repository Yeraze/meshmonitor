import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';

interface AutoUpgradeTestSectionProps {
  baseUrl: string;
}

interface TestResult {
  check: string;
  passed: boolean;
  message: string;
  details?: string;
}

interface TestResponse {
  success: boolean;
  results: TestResult[];
  overallMessage: string;
}

interface TriggerUpgradeResponse {
  success: boolean;
  upgradeId: string;
  message: string;
}

interface UpgradeStatus {
  upgradeId: string;
  status: 'pending' | 'backing_up' | 'downloading' | 'restarting' | 'health_check' | 'cleanup' | 'complete' | 'failed' | 'rolling_back';
  targetVersion: string;
  startTime: string;
  endTime?: string;
  message?: string;
}

const AutoUpgradeTestSection: React.FC<AutoUpgradeTestSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<TestResponse | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [isTestUpgrading, setIsTestUpgrading] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState<UpgradeStatus | null>(null);
  const [statusPollInterval, setStatusPollInterval] = useState<NodeJS.Timeout | null>(null);
  const [autoUpgradeImmediate, setAutoUpgradeImmediate] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  // Load the autoUpgradeImmediate setting on mount
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/settings`);
        if (response.ok) {
          const settings = await response.json();
          setAutoUpgradeImmediate(settings.autoUpgradeImmediate === 'true');
        }
      } catch (error) {
        logger.error('Failed to load autoUpgradeImmediate setting:', error);
      } finally {
        setIsLoadingSettings(false);
      }
    };
    loadSettings();
  }, [baseUrl, csrfFetch]);

  const handleAutoUpgradeImmediateChange = async (enabled: boolean) => {
    setAutoUpgradeImmediate(enabled);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUpgradeImmediate: enabled ? 'true' : 'false' }),
      });
      if (response.ok) {
        showToast(t('auto_upgrade_test.setting_saved'), 'success');
      } else {
        showToast(t('auto_upgrade_test.setting_save_failed'), 'error');
        setAutoUpgradeImmediate(!enabled); // Revert on failure
      }
    } catch (error) {
      logger.error('Failed to save autoUpgradeImmediate setting:', error);
      showToast(t('auto_upgrade_test.setting_save_failed'), 'error');
      setAutoUpgradeImmediate(!enabled); // Revert on failure
    }
  };

  const handleTestConfiguration = async () => {
    setIsTesting(true);
    setTestResults(null);
    setShowDetails(true);

    try {
      const response = await csrfFetch(`${baseUrl}/api/upgrade/test-configuration`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: TestResponse = await response.json();
      setTestResults(data);

      if (data.success) {
        showToast(t('auto_upgrade_test.toast_all_passed'), 'success');
      } else {
        showToast(t('auto_upgrade_test.toast_has_issues'), 'warning');
      }
    } catch (error) {
      logger.error('Failed to test auto-upgrade configuration:', error);
      showToast(t('auto_upgrade_test.toast_test_failed'), 'error');
      setTestResults({
        success: false,
        results: [{
          check: t('auto_upgrade_test.check_connection_error'),
          passed: false,
          message: t('auto_upgrade_test.message_server_communication_failed'),
          details: error instanceof Error ? error.message : String(error)
        }],
        overallMessage: t('auto_upgrade_test.message_connect_failed')
      });
    } finally {
      setIsTesting(false);
    }
  };

  const pollUpgradeStatus = async (upgradeId: string) => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/upgrade/status/${upgradeId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const status: UpgradeStatus = await response.json();
      setUpgradeStatus(status);

      // Stop polling if upgrade is complete or failed
      if (status.status === 'complete' || status.status === 'failed') {
        if (statusPollInterval) {
          clearInterval(statusPollInterval);
          setStatusPollInterval(null);
        }
        setIsTestUpgrading(false);

        if (status.status === 'complete') {
          showToast(t('auto_upgrade_test.toast_upgrade_complete'), 'success');
        } else {
          showToast(t('auto_upgrade_test.toast_upgrade_failed'), 'error');
        }
      }
    } catch (error) {
      logger.error('Failed to poll upgrade status:', error);
    }
  };

  const handleTestUpgrade = async () => {
    // Clear any previous status
    setUpgradeStatus(null);
    setIsTestUpgrading(true);

    try {
      // Trigger upgrade with current version (latest)
      const response = await csrfFetch(`${baseUrl}/api/upgrade/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetVersion: 'latest',
          force: true,  // Force re-pull even if same version
          backup: true   // Always create backup during test
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: TriggerUpgradeResponse = await response.json();

      if (data.success) {
        showToast(t('auto_upgrade_test.toast_upgrade_started'), 'info');

        // Start polling for status
        const interval = setInterval(() => {
          pollUpgradeStatus(data.upgradeId);
        }, 2000); // Poll every 2 seconds

        setStatusPollInterval(interval);

        // Do initial poll immediately
        pollUpgradeStatus(data.upgradeId);
      } else {
        throw new Error(data.message || 'Failed to start test upgrade');
      }
    } catch (error) {
      logger.error('Failed to trigger test upgrade:', error);
      showToast(t('auto_upgrade_test.toast_start_failed'), 'error');
      setIsTestUpgrading(false);
    }
  };

  // Cleanup polling on unmount
  React.useEffect(() => {
    return () => {
      if (statusPollInterval) {
        clearInterval(statusPollInterval);
      }
    };
  }, [statusPollInterval]);

  const getStatusIcon = (passed: boolean) => {
    return passed ? '✅' : '❌';
  };

  const getStatusColor = (passed: boolean) => {
    return passed ? '#10b981' : '#ef4444';
  };

  const getUpgradeStatusDisplay = (status: string) => {
    const statusMap: Record<string, { label: string; icon: string; color: string }> = {
      pending: { label: t('auto_upgrade_test.status_pending'), icon: '⏳', color: '#6b7280' },
      backing_up: { label: t('auto_upgrade_test.status_backing_up'), icon: '💾', color: '#3b82f6' },
      downloading: { label: t('auto_upgrade_test.status_downloading'), icon: '⬇️', color: '#3b82f6' },
      restarting: { label: t('auto_upgrade_test.status_restarting'), icon: '🔄', color: '#f59e0b' },
      health_check: { label: t('auto_upgrade_test.status_health_check'), icon: '🏥', color: '#f59e0b' },
      cleanup: { label: t('auto_upgrade_test.status_cleanup'), icon: '🧹', color: '#f59e0b' },
      complete: { label: t('auto_upgrade_test.status_complete'), icon: '✅', color: '#10b981' },
      failed: { label: t('auto_upgrade_test.status_failed'), icon: '❌', color: '#ef4444' },
      rolling_back: { label: t('auto_upgrade_test.status_rolling_back'), icon: '↩️', color: '#f59e0b' }
    };
    return statusMap[status] || { label: status, icon: '❓', color: '#6b7280' };
  };

  return (
    <div className="settings-section">
      <h3>{t('auto_upgrade_test.title')}</h3>
      <p className="setting-description">
        {t('auto_upgrade_test.description_intro')}
        {' '}<strong>{t('auto_upgrade_test.config_test_name')}</strong> {t('auto_upgrade_test.config_test_description')}
        {' '}<strong>{t('auto_upgrade_test.upgrade_test_name')}</strong> {t('auto_upgrade_test.upgrade_test_description')}
      </p>

      <div className="setting-item" style={{ marginTop: '1rem' }}>
        <label className="checkbox-label" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={autoUpgradeImmediate}
            onChange={(e) => handleAutoUpgradeImmediateChange(e.target.checked)}
            disabled={isLoadingSettings}
            style={{ marginTop: '0.25rem' }}
          />
          <div>
            <strong>{t('auto_upgrade_test.immediate_upgrade')}</strong>
            <p className="setting-description" style={{ margin: '0.25rem 0 0 0' }}>
              {t('auto_upgrade_test.immediate_upgrade_description')}
            </p>
          </div>
        </label>
      </div>

      <div className="setting-item" style={{ marginTop: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          onClick={handleTestConfiguration}
          disabled={isTesting || isTestUpgrading}
          className="save-button"
          style={{ width: 'auto', padding: '0.5rem 1rem' }}
        >
          {isTesting ? t('auto_upgrade_test.btn_testing') : t('auto_upgrade_test.btn_test_config')}
        </button>
        <button
          onClick={handleTestUpgrade}
          disabled={isTestUpgrading || isTesting}
          className="save-button"
          style={{ width: 'auto', padding: '0.5rem 1rem', backgroundColor: '#f59e0b' }}
        >
          {isTestUpgrading ? t('auto_upgrade_test.btn_running_upgrade') : t('auto_upgrade_test.btn_test_upgrade')}
        </button>
      </div>

      {upgradeStatus && (
        <div style={{ marginTop: '1.5rem' }}>
          <div style={{
            padding: '1rem',
            borderRadius: '4px',
            backgroundColor: upgradeStatus.status === 'complete' ? '#f0fdf4' : upgradeStatus.status === 'failed' ? '#fef2f2' : '#f0f9ff',
            border: `1px solid ${upgradeStatus.status === 'complete' ? '#10b981' : upgradeStatus.status === 'failed' ? '#ef4444' : '#3b82f6'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '1.5rem' }}>
                {getUpgradeStatusDisplay(upgradeStatus.status).icon}
              </span>
              <span style={{
                fontWeight: 'bold',
                color: getUpgradeStatusDisplay(upgradeStatus.status).color
              }}>
                {getUpgradeStatusDisplay(upgradeStatus.status).label}
              </span>
            </div>
            <div style={{ fontSize: '0.9rem', opacity: 0.9 }}>
              <div>{t('auto_upgrade_test.target_version')}: {upgradeStatus.targetVersion}</div>
              <div>{t('auto_upgrade_test.started')}: {new Date(upgradeStatus.startTime).toLocaleString()}</div>
              {upgradeStatus.endTime && (
                <div>{t('auto_upgrade_test.completed')}: {new Date(upgradeStatus.endTime).toLocaleString()}</div>
              )}
              {upgradeStatus.message && (
                <div style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
                  {upgradeStatus.message}
                </div>
              )}
            </div>
          </div>

          {(upgradeStatus.status === 'complete' || upgradeStatus.status === 'failed') && (
            <div style={{
              marginTop: '1rem',
              padding: '0.75rem',
              backgroundColor: 'var(--background-secondary, #2a2a2a)',
              borderRadius: '4px',
              fontSize: '0.85rem'
            }}>
              <strong>{t('auto_upgrade_test.note_label')}</strong> {upgradeStatus.status === 'complete'
                ? t('auto_upgrade_test.note_complete')
                : t('auto_upgrade_test.note_failed')
              }
            </div>
          )}
        </div>
      )}

      {testResults && (
        <div style={{ marginTop: '1.5rem' }}>
          <div
            style={{
              padding: '1rem',
              borderRadius: '4px',
              backgroundColor: testResults.success ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${testResults.success ? '#10b981' : '#ef4444'}`,
              marginBottom: '1rem'
            }}
          >
            <div style={{
              fontWeight: 'bold',
              marginBottom: '0.5rem',
              color: testResults.success ? '#059669' : '#dc2626'
            }}>
              {testResults.success ? '✅ ' : '⚠️ '}
              {testResults.overallMessage}
            </div>
            <button
              onClick={() => setShowDetails(!showDetails)}
              style={{
                background: 'none',
                border: 'none',
                color: testResults.success ? '#059669' : '#dc2626',
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0,
                font: 'inherit'
              }}
            >
              {showDetails ? t('auto_upgrade_test.hide_details') : t('auto_upgrade_test.show_details')}
            </button>
          </div>

          {showDetails && (
            <div style={{
              border: '1px solid var(--border-color, #333)',
              borderRadius: '4px',
              overflow: 'hidden'
            }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.9rem'
              }}>
                <thead>
                  <tr style={{ backgroundColor: 'var(--background-secondary, #2a2a2a)' }}>
                    <th style={{ padding: '0.75rem', textAlign: 'left', width: '3rem' }}>{t('auto_upgrade_test.table_status')}</th>
                    <th style={{ padding: '0.75rem', textAlign: 'left', width: '200px' }}>{t('auto_upgrade_test.table_check')}</th>
                    <th style={{ padding: '0.75rem', textAlign: 'left' }}>{t('auto_upgrade_test.table_result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {testResults.results.map((result, index) => (
                    <React.Fragment key={index}>
                      <tr
                        style={{
                          borderTop: index > 0 ? '1px solid var(--border-color, #333)' : 'none',
                          backgroundColor: index % 2 === 0 ? 'transparent' : 'var(--background-secondary, #2a2a2a)'
                        }}
                      >
                        <td style={{ padding: '0.75rem', textAlign: 'center', fontSize: '1.2rem' }}>
                          {getStatusIcon(result.passed)}
                        </td>
                        <td style={{ padding: '0.75rem', fontWeight: 500 }}>
                          {result.check}
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          <div style={{ color: getStatusColor(result.passed), fontWeight: 500 }}>
                            {result.message}
                          </div>
                          {result.details && (
                            <div style={{
                              marginTop: '0.25rem',
                              fontSize: '0.85rem',
                              opacity: 0.8,
                              fontFamily: 'monospace'
                            }}>
                              {result.details}
                            </div>
                          )}
                        </td>
                      </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{
            marginTop: '1rem',
            padding: '0.75rem',
            backgroundColor: 'var(--background-secondary, #2a2a2a)',
            borderRadius: '4px',
            fontSize: '0.85rem',
            opacity: 0.9
          }}>
            <strong>{t('auto_upgrade_test.note_label')}</strong> {t('auto_upgrade_test.sidecar_note')}
            <div style={{
              marginTop: '0.5rem',
              fontFamily: 'monospace',
              backgroundColor: 'var(--background-primary, #1a1a1a)',
              padding: '0.5rem',
              borderRadius: '2px'
            }}>
              docker compose -f docker-compose.yml -f docker-compose.upgrade.yml up -d
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutoUpgradeTestSection;
