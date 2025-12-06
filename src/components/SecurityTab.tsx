import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { TabType } from '../types/ui';
import { getHardwareModelName } from '../utils/hardwareModel';
import '../styles/SecurityTab.css';

interface SecurityNode {
  nodeNum: number;
  shortName: string;
  longName: string;
  lastHeard: number | null;
  keyIsLowEntropy: boolean;
  duplicateKeyDetected: boolean;
  keySecurityIssueDetails?: string;
  publicKey?: string;
  hwModel?: number;
}

interface SecurityIssuesResponse {
  total: number;
  lowEntropyCount: number;
  duplicateKeyCount: number;
  nodes: SecurityNode[];
}

interface ScannerStatus {
  running: boolean;
  scanningNow: boolean;
  intervalHours: number;
  lastScanTime: number | null;
}

interface DuplicateKeyGroup {
  publicKey: string;
  nodes: SecurityNode[];
}

interface SecurityTabProps {
  onTabChange?: (tab: TabType) => void;
  onSelectDMNode?: (nodeId: string) => void;
  setNewMessage?: (message: string) => void;
}

export const SecurityTab: React.FC<SecurityTabProps> = ({ onTabChange, onSelectDMNode, setNewMessage }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [issues, setIssues] = useState<SecurityIssuesResponse | null>(null);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expandedNode, setExpandedNode] = useState<number | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const canWrite = hasPermission('security', 'write');

  const fetchSecurityData = async () => {
    try {
      const [issuesData, statusData] = await Promise.all([
        api.get<SecurityIssuesResponse>('/api/security/issues'),
        api.get<ScannerStatus>('/api/security/scanner/status')
      ]);

      setIssues(issuesData);
      setScannerStatus(statusData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_load'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSecurityData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchSecurityData, 30000);
    return () => clearInterval(interval);
  }, []);

  const triggerScan = useCallback(async () => {
    setScanning(true);
    try {
      await api.post('/api/security/scanner/scan', {});

      // Wait a moment then refresh data
      setTimeout(fetchSecurityData, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_scan'));
    } finally {
      setScanning(false);
    }
  }, []);

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return t('security.never');
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatRelativeTime = (timestamp: number | null) => {
    if (!timestamp) return t('security.never');
    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return t('security.just_now');
    if (diff < 3600) return t('security.minutes_ago', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('security.hours_ago', { count: Math.floor(diff / 3600) });
    return t('security.days_ago', { count: Math.floor(diff / 86400) });
  };

  const groupDuplicateKeyNodes = (nodes: SecurityNode[]): DuplicateKeyGroup[] => {
    const duplicateNodes = nodes.filter(node => node.duplicateKeyDetected && node.publicKey);
    const groups = new Map<string, SecurityNode[]>();

    duplicateNodes.forEach(node => {
      if (node.publicKey) {
        const existing = groups.get(node.publicKey) || [];
        existing.push(node);
        groups.set(node.publicKey, existing);
      }
    });

    return Array.from(groups.entries())
      .filter(([_, nodeList]) => nodeList.length > 1) // Only show groups with multiple nodes
      .map(([publicKey, nodeList]) => ({ publicKey, nodes: nodeList }));
  };

  const handleNodeClick = useCallback((nodeNum: number) => {
    // Check if user has permission to view messages before navigating
    if (!hasPermission('messages', 'read')) {
      setError(t('security.no_permission_messages'));
      return;
    }

    if (onTabChange && onSelectDMNode) {
      // Convert nodeNum to hex string with leading ! for DM node ID
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      onSelectDMNode(nodeId);
      onTabChange('messages');
    }
  }, [onTabChange, onSelectDMNode, hasPermission, t]);

  const handleSendNotification = useCallback((node: SecurityNode, duplicateCount?: number) => {
    // Check if user has permission to send messages before navigating
    if (!hasPermission('messages', 'read')) {
      setError(t('security.no_permission_send'));
      return;
    }

    if (onTabChange && onSelectDMNode && setNewMessage) {
      // Convert nodeNum to hex string with leading ! for DM node ID
      const nodeId = `!${node.nodeNum.toString(16).padStart(8, '0')}`;

      // Determine the message based on the issue type
      let message = '';
      if (node.keyIsLowEntropy) {
        message = 'MeshMonitor Security Notification: Your node has a low entropy key. Read more: https://bit.ly/4oL5m0P';
      } else if (node.duplicateKeyDetected && duplicateCount) {
        message = `MeshMonitor Security Notification: Your node has a key shared with ${duplicateCount} other nearby nodes. Read more: https://bit.ly/4okVACV`;
      }

      // Set the node, message, and switch to messages tab
      onSelectDMNode(nodeId);
      setNewMessage(message);
      onTabChange('messages');
    }
  }, [onTabChange, onSelectDMNode, setNewMessage, hasPermission, t]);

  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    try {
      setShowExportMenu(false);

      // Get runtime base path from window location
      // If pathname is /meshmonitor, extract that; otherwise use /
      const pathParts = window.location.pathname.split('/').filter(p => p);
      const basePath = pathParts.length > 0 ? `/${pathParts[0]}/` : '/';
      const exportUrl = `${basePath}api/security/export?format=${format}`;

      const response = await fetch(exportUrl, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Export failed');
      }

      // Create a blob from the response
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `security-scan-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_export'));
    }
  }, [t]);

  if (loading) {
    return (
      <div className="security-tab">
        <div className="loading">{t('security.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="security-tab">
        <div className="error">{t('security.error_loading', { error })}</div>
        <button onClick={fetchSecurityData}>{t('security.retry')}</button>
      </div>
    );
  }

  return (
    <div className="security-tab">
      <div className="security-header">
        <div className="header-content">
          <div>
            <h2>{t('security.title')}</h2>
            <p>{t('security.description')}</p>
          </div>
          <div className="header-actions">
            <div className="export-dropdown">
              <button
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="export-button"
                title={t('security.export_results')}
              >
                {t('security.export')} ▼
              </button>
              {showExportMenu && (
                <div className="export-menu">
                  <button onClick={() => handleExport('csv')} className="export-menu-item">
                    {t('security.export_as_csv')}
                  </button>
                  <button onClick={() => handleExport('json')} className="export-menu-item">
                    {t('security.export_as_json')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Scanner Status */}
      <div className="scanner-status">
        <div className="status-card">
          <h3>{t('security.scanner_status')}</h3>
          <div className="status-details">
            <div className="status-row">
              <span className="label">{t('security.status')}:</span>
              <span className={`value ${scannerStatus?.running ? 'running' : 'stopped'}`}>
                {scannerStatus?.scanningNow ? t('security.scanning_now') : scannerStatus?.running ? t('security.active') : t('security.stopped')}
              </span>
            </div>
            <div className="status-row">
              <span className="label">{t('security.scan_interval')}:</span>
              <span className="value">{t('security.every_hours', { hours: scannerStatus?.intervalHours })}</span>
            </div>
            <div className="status-row">
              <span className="label">{t('security.last_scan')}:</span>
              <span className="value">
                {formatRelativeTime(scannerStatus?.lastScanTime || null)}
                {scannerStatus?.lastScanTime && (
                  <span className="timestamp"> ({formatDate(scannerStatus.lastScanTime)})</span>
                )}
              </span>
            </div>
          </div>
          {canWrite && (
            <button
              onClick={triggerScan}
              disabled={scanning || scannerStatus?.scanningNow}
              className="scan-button"
            >
              {scanning || scannerStatus?.scanningNow ? t('security.scanning') : t('security.run_scan_now')}
            </button>
          )}
        </div>
      </div>

      {/* Summary Statistics */}
      <div className="security-stats">
        <div className="stat-card total">
          <div className="stat-value">{issues?.total || 0}</div>
          <div className="stat-label">{t('security.nodes_with_issues')}</div>
        </div>
        <div className="stat-card low-entropy">
          <div className="stat-value">{issues?.lowEntropyCount || 0}</div>
          <div className="stat-label">{t('security.have_low_entropy')}</div>
        </div>
        <div className="stat-card duplicate">
          <div className="stat-value">{issues?.duplicateKeyCount || 0}</div>
          <div className="stat-label">{t('security.have_duplicate')}</div>
        </div>
      </div>
      {issues && issues.total > 0 && (issues.lowEntropyCount + issues.duplicateKeyCount > issues.total) && (
        <div className="info-note" style={{marginTop: '0.5rem', fontSize: '0.85rem', color: '#666', fontStyle: 'italic'}}>
          {t('security.both_issues_note')}
        </div>
      )}

      {/* Issues List */}
      <div className="security-issues">
        {!issues || issues.total === 0 ? (
          <div className="no-issues">
            <p>{t('security.no_issues')}</p>
            <p className="help-text">
              {t('security.scanner_checks')}
            </p>
          </div>
        ) : (
          <>
            {/* Low-Entropy Keys Section */}
            {issues.lowEntropyCount > 0 && (
              <div className="issues-section">
                <h3>{t('security.low_entropy_count', { count: issues.lowEntropyCount })}</h3>
                <div className="issues-list">
                  {issues.nodes.filter(node => node.keyIsLowEntropy).map((node) => (
              <div key={node.nodeNum} className="issue-card">
                <div
                  className="issue-header"
                  onClick={() => setExpandedNode(expandedNode === node.nodeNum ? null : node.nodeNum)}
                >
                  <div className="node-info">
                    <div className="node-name">
                      <span
                        className="node-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNodeClick(node.nodeNum);
                        }}
                      >
                        {node.longName || node.shortName} ({node.shortName})
                      </span>
                    </div>
                    <div className="node-id">
                      Node #{node.nodeNum.toString(16).toUpperCase()}
                      {node.hwModel !== undefined && node.hwModel !== 0 && (
                        <span className="hw-model"> - {getHardwareModelName(node.hwModel)}</span>
                      )}
                    </div>
                    <div className="node-last-seen">
                      {t('security.last_seen', { time: formatRelativeTime(node.lastHeard) })}
                    </div>
                  </div>
                  <div className="issue-types">
                    {node.keyIsLowEntropy && (
                      <span className="badge low-entropy">{t('security.badge_low_entropy')}</span>
                    )}
                    {node.duplicateKeyDetected && (
                      <span className="badge duplicate">{t('security.badge_duplicate')}</span>
                    )}
                  </div>
                  <button
                    className="send-notification-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSendNotification(node);
                    }}
                    title={t('security.send_notification_title')}
                  >
                    →
                  </button>
                  <div className="expand-icon">
                    {expandedNode === node.nodeNum ? '▼' : '▶'}
                  </div>
                </div>

                {expandedNode === node.nodeNum && (
                  <div className="issue-details">
                    <div className="detail-row">
                      <span className="detail-label">{t('security.last_heard')}:</span>
                      <span className="detail-value">{formatDate(node.lastHeard)}</span>
                    </div>
                    {node.keySecurityIssueDetails && (
                      <div className="detail-row">
                        <span className="detail-label">{t('security.details')}:</span>
                        <span className="detail-value">{node.keySecurityIssueDetails}</span>
                      </div>
                    )}
                    {node.publicKey && (
                      <div className="detail-row">
                        <span className="detail-label">{t('security.public_key')}:</span>
                        <span className="detail-value key-hash">
                          {node.publicKey.substring(0, 32)}...
                        </span>
                      </div>
                    )}
                    <div className="detail-row recommendations">
                      <span className="detail-label">{t('security.recommendations')}:</span>
                      <ul>
                        {node.keyIsLowEntropy && (
                          <li>{t('security.recommendation_weak_key')}</li>
                        )}
                        {node.duplicateKeyDetected && (
                          <li>{t('security.recommendation_shared_key')}</li>
                        )}
                        <li>{t('security.recommendation_reconfigure')}</li>
                        <li>{t('security.recommendation_docs')}</li>
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            ))}
                </div>
              </div>
            )}

            {/* Duplicate Keys Section - Grouped by Public Key */}
            {issues.duplicateKeyCount > 0 && (
              <div className="issues-section">
                <h3>{t('security.duplicate_count', { count: issues.duplicateKeyCount })}</h3>
                {groupDuplicateKeyNodes(issues.nodes).map((group, groupIndex) => (
                  <div key={groupIndex} className="duplicate-group">
                    <div className="duplicate-group-header">
                      <div className="group-title">
                        <span className="badge duplicate">{t('security.shared_key')}</span>
                        <span className="key-hash">{group.publicKey.substring(0, 32)}...</span>
                      </div>
                      <div className="node-count">{t('security.nodes_sharing', { count: group.nodes.length })}</div>
                    </div>
                    <div className="duplicate-node-list">
                      {group.nodes.map((node) => (
                        <div key={node.nodeNum} className="duplicate-node-item">
                          <div className="duplicate-node-info">
                            <span
                              className="node-link"
                              onClick={() => handleNodeClick(node.nodeNum)}
                            >
                              {node.longName || node.shortName} ({node.shortName})
                            </span>
                            <div className="node-last-seen">
                              {t('security.last_seen', { time: formatRelativeTime(node.lastHeard) })}
                            </div>
                          </div>
                          <div className="duplicate-node-actions">
                            <span className="node-id">
                              #{node.nodeNum.toString(16).toUpperCase()}
                              {node.hwModel !== undefined && node.hwModel !== 0 && (
                                <span className="hw-model"> - {getHardwareModelName(node.hwModel)}</span>
                              )}
                            </span>
                            <button
                              className="send-notification-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSendNotification(node, group.nodes.length - 1);
                              }}
                              title={t('security.send_notification_title')}
                            >
                              →
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="group-recommendations">
                      <strong>{t('security.group_recommendation')}</strong> {t('security.group_recommendation_text')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
