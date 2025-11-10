import React, { useState } from 'react';
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
  status: 'pending' | 'backing_up' | 'downloading' | 'restarting' | 'health_check' | 'complete' | 'failed' | 'rolling_back';
  targetVersion: string;
  startTime: string;
  endTime?: string;
  message?: string;
}

const AutoUpgradeTestSection: React.FC<AutoUpgradeTestSectionProps> = ({ baseUrl }) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<TestResponse | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [isTestUpgrading, setIsTestUpgrading] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState<UpgradeStatus | null>(null);
  const [statusPollInterval, setStatusPollInterval] = useState<NodeJS.Timeout | null>(null);

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
        showToast('All auto-upgrade configuration checks passed!', 'success');
      } else {
        showToast('Auto-upgrade configuration has issues. See details below.', 'warning');
      }
    } catch (error) {
      logger.error('Failed to test auto-upgrade configuration:', error);
      showToast('Failed to test auto-upgrade configuration', 'error');
      setTestResults({
        success: false,
        results: [{
          check: 'Connection Error',
          passed: false,
          message: 'Failed to communicate with server',
          details: error instanceof Error ? error.message : String(error)
        }],
        overallMessage: 'Could not connect to server'
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
          showToast('Test upgrade completed successfully!', 'success');
        } else {
          showToast('Test upgrade failed', 'error');
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
        showToast('Test upgrade started! Monitoring progress...', 'info');

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
      showToast('Failed to start test upgrade', 'error');
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
      pending: { label: 'Pending', icon: '⏳', color: '#6b7280' },
      backing_up: { label: 'Creating Backup', icon: '💾', color: '#3b82f6' },
      downloading: { label: 'Pulling Image', icon: '⬇️', color: '#3b82f6' },
      restarting: { label: 'Recreating Container', icon: '🔄', color: '#f59e0b' },
      health_check: { label: 'Health Check', icon: '🏥', color: '#f59e0b' },
      complete: { label: 'Complete', icon: '✅', color: '#10b981' },
      failed: { label: 'Failed', icon: '❌', color: '#ef4444' },
      rolling_back: { label: 'Rolling Back', icon: '↩️', color: '#f59e0b' }
    };
    return statusMap[status] || { label: status, icon: '❓', color: '#6b7280' };
  };

  return (
    <div className="settings-section">
      <h3>Auto-Upgrade Testing</h3>
      <p className="setting-description">
        Test your auto-upgrade configuration to ensure all components are properly set up.
        The <strong>Configuration Test</strong> checks environment variables, file permissions, the upgrader sidecar, and more.
        The <strong>Upgrade Process Test</strong> performs an actual upgrade with the current version, testing backup creation,
        container recreation, and health checks without changing your version.
      </p>

      <div className="setting-item" style={{ marginTop: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          onClick={handleTestConfiguration}
          disabled={isTesting || isTestUpgrading}
          className="save-button"
          style={{ width: 'auto', padding: '0.5rem 1rem' }}
        >
          {isTesting ? 'Testing Configuration...' : 'Test Auto-Upgrade Configuration'}
        </button>
        <button
          onClick={handleTestUpgrade}
          disabled={isTestUpgrading || isTesting}
          className="save-button"
          style={{ width: 'auto', padding: '0.5rem 1rem', backgroundColor: '#f59e0b' }}
        >
          {isTestUpgrading ? 'Running Test Upgrade...' : 'Test Upgrade Process'}
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
              <div>Target Version: {upgradeStatus.targetVersion}</div>
              <div>Started: {new Date(upgradeStatus.startTime).toLocaleString()}</div>
              {upgradeStatus.endTime && (
                <div>Completed: {new Date(upgradeStatus.endTime).toLocaleString()}</div>
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
              <strong>Note:</strong> {upgradeStatus.status === 'complete'
                ? 'Test upgrade completed successfully! The container was recreated with the same version. Check the system logs to verify everything is working correctly.'
                : 'Test upgrade failed. Check the error message above and the system logs for details.'
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
              {showDetails ? 'Hide Details' : 'Show Details'}
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
                    <th style={{ padding: '0.75rem', textAlign: 'left', width: '3rem' }}>Status</th>
                    <th style={{ padding: '0.75rem', textAlign: 'left', width: '200px' }}>Check</th>
                    <th style={{ padding: '0.75rem', textAlign: 'left' }}>Result</th>
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
            <strong>Note:</strong> If the "Upgrader Sidecar" check fails, ensure you started MeshMonitor with both compose files:
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
