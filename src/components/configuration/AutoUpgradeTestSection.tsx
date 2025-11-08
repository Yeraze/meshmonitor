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

const AutoUpgradeTestSection: React.FC<AutoUpgradeTestSectionProps> = ({ baseUrl }) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<TestResponse | null>(null);
  const [showDetails, setShowDetails] = useState(false);

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

  const getStatusIcon = (passed: boolean) => {
    return passed ? '✅' : '❌';
  };

  const getStatusColor = (passed: boolean) => {
    return passed ? '#10b981' : '#ef4444';
  };

  return (
    <div className="settings-section">
      <h3>Auto-Upgrade Testing</h3>
      <p className="setting-description">
        Test your auto-upgrade configuration to ensure all components are properly set up.
        This checks environment variables, file permissions, the upgrader sidecar, and more.
      </p>

      <div className="setting-item" style={{ marginTop: '1rem' }}>
        <button
          onClick={handleTestConfiguration}
          disabled={isTesting}
          className="save-button"
          style={{ width: 'auto', padding: '0.5rem 1rem' }}
        >
          {isTesting ? 'Testing Configuration...' : 'Test Auto-Upgrade Configuration'}
        </button>
      </div>

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
