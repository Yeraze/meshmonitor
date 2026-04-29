import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { TabType } from '../types/ui';
import { getHardwareModelName } from '../utils/hardwareModel';
import { logger } from '../utils/logger';
import { useSource } from '../contexts/SourceContext';
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
  isExcessivePackets?: boolean;
  packetRatePerHour?: number | null;
  packetRateLastChecked?: number | null;
  isTimeOffsetIssue?: boolean;
  timeOffsetSeconds?: number | null;
}

interface TopBroadcaster {
  nodeNum: number;
  shortName: string | null;
  longName: string | null;
  packetCount: number;
}

interface SecurityIssuesResponse {
  total: number;
  lowEntropyCount: number;
  duplicateKeyCount: number;
  excessivePacketsCount: number;
  timeOffsetCount: number;
  nodes: SecurityNode[];
  topBroadcasters: TopBroadcaster[];
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

interface DeadNode {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  lastHeard: number | null;
  inDeviceDb: boolean;
}

interface DeadNodesResponse {
  nodes: DeadNode[];
  count: number;
  thresholdDays: number;
}

interface SecurityTabProps {
  onTabChange?: (tab: TabType) => void;
  onSelectDMNode?: (nodeId: string) => void;
  setNewMessage?: (message: string) => void;
}

export const SecurityTab: React.FC<SecurityTabProps> = ({ onTabChange, onSelectDMNode, setNewMessage }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { sourceId } = useSource();
  const [issues, setIssues] = useState<SecurityIssuesResponse | null>(null);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expandedNode, setExpandedNode] = useState<number | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [mismatchEvents, setMismatchEvents] = useState<any[]>([]);
  const [deadNodes, setDeadNodes] = useState<DeadNode[]>([]);
  const [selectedDeadNodes, setSelectedDeadNodes] = useState<Set<number>>(new Set());
  const [isDeletingNodes, setIsDeletingNodes] = useState(false);

  // Security Digest state
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestAppriseUrl, setDigestAppriseUrl] = useState('');
  const [digestTime, setDigestTime] = useState('06:00');
  const [digestReportType, setDigestReportType] = useState<'summary' | 'detailed'>('summary');
  const [digestSuppressEmpty, setDigestSuppressEmpty] = useState(true);
  const [digestFormat, setDigestFormat] = useState<'text' | 'markdown'>('text');
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestSending, setDigestSending] = useState(false);
  const [digestMessage, setDigestMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const canWrite = hasPermission('security', 'write');

  const fetchSecurityData = async () => {
    try {
      const srcParam = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
      const [issuesData, statusData, mismatchData, deadNodesData] = await Promise.all([
        api.get<SecurityIssuesResponse>(`/api/security/issues${srcParam}`),
        api.get<ScannerStatus>(`/api/security/scanner/status${srcParam}`),
        api.get<{ events: any[] }>('/api/security/key-mismatches'),
        sourceId
          ? api.get<DeadNodesResponse>(`/api/security/dead-nodes${srcParam}`)
          : Promise.resolve({ nodes: [], count: 0, thresholdDays: 7 } as unknown as DeadNodesResponse),
      ]);

      setIssues(issuesData);
      setScannerStatus(statusData);
      setMismatchEvents(mismatchData.events || []);
      setDeadNodes(deadNodesData.nodes || []);
      setSelectedDeadNodes(new Set());
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
  }, [sourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load digest settings
  useEffect(() => {
    const loadDigestSettings = async () => {
      try {
        const settings = await api.get<Record<string, string>>('/api/settings');
        setDigestEnabled(settings.securityDigestEnabled === 'true');
        setDigestAppriseUrl(settings.securityDigestAppriseUrl || '');
        setDigestTime(settings.securityDigestTime || '06:00');
        setDigestReportType((settings.securityDigestReportType as 'summary' | 'detailed') || 'summary');
        setDigestSuppressEmpty(settings.securityDigestSuppressEmpty !== 'false');
        setDigestFormat((settings.securityDigestFormat as 'text' | 'markdown') || 'text');
      } catch {
        // Settings may not exist yet, use defaults
      }
    };
    loadDigestSettings();
  }, []);

  const saveDigestSettings = useCallback(async () => {
    setDigestSaving(true);
    setDigestMessage(null);
    try {
      await api.post('/api/settings', {
        securityDigestEnabled: String(digestEnabled),
        securityDigestAppriseUrl: digestAppriseUrl,
        securityDigestTime: digestTime,
        securityDigestReportType: digestReportType,
        securityDigestSuppressEmpty: String(digestSuppressEmpty),
        securityDigestFormat: digestFormat,
      });
      setDigestMessage({ type: 'success', text: t('common.saved', 'Settings saved') });
    } catch {
      setDigestMessage({ type: 'error', text: t('common.save_failed', 'Failed to save settings') });
    } finally {
      setDigestSaving(false);
    }
  }, [digestEnabled, digestAppriseUrl, digestTime, digestReportType, digestSuppressEmpty, digestFormat, t]);

  const sendDigestNow = useCallback(async () => {
    setDigestSending(true);
    setDigestMessage(null);
    try {
      const result = await api.post<{ success: boolean; message: string }>('/api/security/digest/send', {});
      setDigestMessage({
        type: result.success ? 'success' : 'error',
        text: result.message,
      });
    } catch {
      setDigestMessage({ type: 'error', text: t('common.failed', 'Failed to send digest') });
    } finally {
      setDigestSending(false);
    }
  }, [t]);

  const triggerScan = useCallback(async () => {
    if (!sourceId) {
      setError(t('security.failed_scan'));
      return;
    }
    setScanning(true);
    try {
      await api.post('/api/security/scanner/scan', { sourceId });

      // Wait a moment then refresh data
      setTimeout(fetchSecurityData, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_scan'));
    } finally {
      setScanning(false);
    }
  }, [sourceId, t]);

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

  const formatTimeOffset = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return t('security.unknown');
    const abs = Math.abs(Math.round(seconds));
    if (abs < 1) return t('security.offset_synchronized');

    const days = Math.floor(abs / 86400);
    const hours = Math.floor((abs % 86400) / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    const secs = abs % 60;

    const parts: string[] = [];
    if (days > 0) {
      parts.push(t('security.offset_days', { count: days }));
      if (hours > 0) parts.push(t('security.offset_hours', { count: hours }));
    } else if (hours > 0) {
      parts.push(t('security.offset_hours', { count: hours }));
      if (minutes > 0) parts.push(t('security.offset_minutes', { count: minutes }));
    } else if (minutes > 0) {
      parts.push(t('security.offset_minutes', { count: minutes }));
      if (secs > 0) parts.push(t('security.offset_seconds', { count: secs }));
    } else {
      parts.push(t('security.offset_seconds', { count: secs }));
    }

    const value = parts.join(', ');
    // Convention: positive timeOffsetSeconds = node behind server, negative = ahead
    return seconds >= 0
      ? t('security.offset_behind', { value })
      : t('security.offset_ahead', { value });
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
      const exportUrl = `${basePath}api/security/export?format=${format}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}`;

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

  const getMismatchStatusLabel = (action: string): string => {
    switch (action) {
      case 'mismatch': return t('security.key_mismatch_status_pending');
      case 'purge': return t('security.key_mismatch_status_purged');
      case 'fixed': return t('security.key_mismatch_status_fixed');
      case 'exhausted': return t('security.key_mismatch_status_exhausted');
      default: return action;
    }
  };

  const formatLastHeard = (lastHeard: number | null): string => {
    if (!lastHeard) return t('security.dead_nodes_never', 'Never');
    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = now - lastHeard;
    const days = Math.floor(diffSeconds / 86400);
    if (days > 30) {
      const months = Math.floor(days / 30);
      return t('security.dead_nodes_months_ago', '{{count}} month(s) ago', { count: months });
    }
    return t('security.dead_nodes_days_ago', '{{count}} day(s) ago', { count: days });
  };

  const toggleDeadNodeSelection = (nodeNum: number) => {
    setSelectedDeadNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeNum)) next.delete(nodeNum);
      else next.add(nodeNum);
      return next;
    });
  };

  const toggleAllDeadNodes = () => {
    if (selectedDeadNodes.size === deadNodes.length) {
      setSelectedDeadNodes(new Set());
    } else {
      setSelectedDeadNodes(new Set(deadNodes.map(n => n.nodeNum)));
    }
  };

  const handleBulkDeleteDeadNodes = async () => {
    if (selectedDeadNodes.size === 0) return;
    const confirmed = window.confirm(
      t('security.dead_nodes_confirm_delete', 'Are you sure you want to delete {{count}} node(s)? This cannot be undone.', { count: selectedDeadNodes.size })
    );
    if (!confirmed) return;

    setIsDeletingNodes(true);
    try {
      await api.post('/api/security/dead-nodes/bulk-delete', { nodeNums: Array.from(selectedDeadNodes), ...(sourceId ? { sourceId } : {}) });
      setSelectedDeadNodes(new Set());
      await fetchSecurityData();
    } catch (err) {
      logger.error('Error bulk deleting dead nodes:', err);
    } finally {
      setIsDeletingNodes(false);
    }
  };

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

      {/* Security Digest */}
      {canWrite && (
        <div className="issues-section digest-section">
          <h3>{t('security.digest_title', 'Security Digest')}</h3>
          <p className="section-description">
            {t('security.digest_description', 'Schedule a daily security report delivered via Apprise.')}
          </p>
          <div className="digest-controls">
            <div className="digest-row">
              <label className="digest-label">
                <input
                  type="checkbox"
                  checked={digestEnabled}
                  onChange={e => setDigestEnabled(e.target.checked)}
                />
                {t('security.digest_enabled', 'Enable daily digest')}
              </label>
            </div>
            <div className="digest-row">
              <label className="digest-label">{t('security.digest_apprise_url', 'Apprise URL')}</label>
              <input
                type="text"
                className="digest-input"
                value={digestAppriseUrl}
                onChange={e => setDigestAppriseUrl(e.target.value)}
                placeholder="discord://webhook_id/webhook_token"
              />
            </div>
            <div className="digest-row">
              <label className="digest-label">{t('security.digest_time', 'Send at')}</label>
              <input
                type="time"
                className="digest-input digest-time"
                value={digestTime}
                onChange={e => setDigestTime(e.target.value)}
              />
            </div>
            <div className="digest-row">
              <label className="digest-label">{t('security.digest_report_type', 'Report type')}</label>
              <select
                className="digest-input digest-select"
                value={digestReportType}
                onChange={e => setDigestReportType(e.target.value as 'summary' | 'detailed')}
              >
                <option value="summary">{t('security.digest_summary', 'Summary')}</option>
                <option value="detailed">{t('security.digest_detailed', 'Detailed')}</option>
              </select>
            </div>
            <div className="digest-row">
              <label className="digest-label">{t('security.digest_format', 'Format')}</label>
              <select
                className="digest-input digest-select"
                value={digestFormat}
                onChange={e => setDigestFormat(e.target.value as 'text' | 'markdown')}
              >
                <option value="text">{t('security.digest_format_text', 'Plain Text')}</option>
                <option value="markdown">{t('security.digest_format_markdown', 'Markdown')}</option>
              </select>
            </div>
            <div className="digest-row">
              <label className="digest-label">
                <input
                  type="checkbox"
                  checked={digestSuppressEmpty}
                  onChange={e => setDigestSuppressEmpty(e.target.checked)}
                />
                {t('security.digest_suppress_empty', 'Suppress when no issues')}
              </label>
            </div>
            <div className="digest-actions">
              <button
                className="digest-save-btn"
                onClick={saveDigestSettings}
                disabled={digestSaving}
              >
                {digestSaving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
              </button>
              <button
                className="digest-send-btn"
                onClick={sendDigestNow}
                disabled={digestSending || !digestAppriseUrl}
              >
                {digestSending ? t('common.sending', 'Sending...') : t('security.digest_send_now', 'Send Now')}
              </button>
            </div>
            {digestMessage && (
              <div className={`digest-message ${digestMessage.type}`}>
                {digestMessage.text}
              </div>
            )}
          </div>
        </div>
      )}

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
        <div className="stat-card excessive-packets">
          <div className="stat-value">{issues?.excessivePacketsCount || 0}</div>
          <div className="stat-label">{t('security.have_excessive_packets')}</div>
        </div>
        <div className="stat-card time-offset">
          <div className="stat-value">{issues?.timeOffsetCount || 0}</div>
          <div className="stat-label">{t('security.have_time_offset')}</div>
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

            {/* Top Broadcasters Table */}
            {issues.topBroadcasters && issues.topBroadcasters.length > 0 && (
              <div className="issues-section top-broadcasters-section">
                <h3>{t('security.top_broadcasters')}</h3>
                <p className="section-description">{t('security.top_broadcasters_description')}</p>
                <table className="top-broadcasters-table">
                  <thead>
                    <tr>
                      <th>{t('security.rank')}</th>
                      <th>{t('security.node')}</th>
                      <th>{t('security.node_id')}</th>
                      <th>{t('security.packets_hour')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.topBroadcasters.map((broadcaster, index) => (
                      <tr key={broadcaster.nodeNum}>
                        <td className="rank">#{index + 1}</td>
                        <td className="node-name">
                          <span
                            className="node-link"
                            onClick={() => handleNodeClick(broadcaster.nodeNum)}
                          >
                            {broadcaster.longName || broadcaster.shortName || 'Unknown'}
                          </span>
                          {broadcaster.shortName && broadcaster.longName && (
                            <span className="short-name"> ({broadcaster.shortName})</span>
                          )}
                        </td>
                        <td className="node-id">!{broadcaster.nodeNum.toString(16).padStart(8, '0')}</td>
                        <td className="packet-count">{broadcaster.packetCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Excessive Packets Section */}
            {issues.excessivePacketsCount > 0 && (
              <div className="issues-section">
                <h3>{t('security.excessive_packets_count', { count: issues.excessivePacketsCount })}</h3>
                <div className="issues-list">
                  {issues.nodes.filter(node => node.isExcessivePackets).map((node) => (
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
                          <span className="badge excessive-packets">{t('security.badge_excessive_packets')}</span>
                          {node.packetRatePerHour && (
                            <span className="packet-rate">{node.packetRatePerHour} {t('security.packets_per_hour')}</span>
                          )}
                        </div>
                        <div className="expand-icon">
                          {expandedNode === node.nodeNum ? '▼' : '▶'}
                        </div>
                      </div>

                      {expandedNode === node.nodeNum && (
                        <div className="issue-details">
                          <div className="detail-row">
                            <span className="detail-label">{t('security.packet_rate')}:</span>
                            <span className="detail-value">{node.packetRatePerHour || 0} {t('security.packets_per_hour')}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-label">{t('security.rate_last_checked')}:</span>
                            <span className="detail-value">{formatDate(node.packetRateLastChecked || null)}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-label">{t('security.last_heard')}:</span>
                            <span className="detail-value">{formatDate(node.lastHeard)}</span>
                          </div>
                          <div className="detail-row recommendations">
                            <span className="detail-label">{t('security.recommendations')}:</span>
                            <ul>
                              <li>{t('security.recommendation_excessive_packets')}</li>
                              <li>{t('security.recommendation_investigate_spam')}</li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Time Offset Section */}
            {issues.timeOffsetCount > 0 && (
              <div className="issues-section">
                <h3>{t('security.time_offset_count', { count: issues.timeOffsetCount })}</h3>
                <p className="section-description">{t('security.time_offset_description')}</p>
                <div className="issues-list">
                  {issues.nodes.filter(node => node.isTimeOffsetIssue).map((node) => (
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
                          <span className="badge time-offset">{t('security.badge_time_offset')}</span>
                          <span className="time-offset-value">{formatTimeOffset(node.timeOffsetSeconds)}</span>
                        </div>
                        <div className="expand-icon">
                          {expandedNode === node.nodeNum ? '▼' : '▶'}
                        </div>
                      </div>

                      {expandedNode === node.nodeNum && (
                        <div className="issue-details">
                          <div className="detail-row">
                            <span className="detail-label">{t('security.clock_offset')}:</span>
                            <span className="detail-value">{formatTimeOffset(node.timeOffsetSeconds)}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-label">{t('security.last_heard')}:</span>
                            <span className="detail-value">{formatDate(node.lastHeard)}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-label">{t('security.node_reported_time')}:</span>
                            <span className="detail-value">
                              {node.lastHeard && node.timeOffsetSeconds != null
                                ? formatDate(node.lastHeard - node.timeOffsetSeconds)
                                : t('security.unknown')}
                            </span>
                          </div>
                          <div className="detail-row recommendations">
                            <span className="detail-label">{t('security.recommendations')}:</span>
                            <ul>
                              <li>{t('security.recommendation_time_offset')}</li>
                              <li>{t('security.recommendation_check_gps')}</li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Dead Nodes Section */}
            <div className="issues-section">
              <h3>{t('security.dead_nodes_title', 'Dead Nodes')} ({deadNodes.length})</h3>
              {deadNodes.length === 0 ? (
                <div className="no-issues">
                  <p>{t('security.dead_nodes_empty', 'No dead nodes found. All nodes have been heard from within the last 7 days.')}</p>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
                    <button
                      onClick={toggleAllDeadNodes}
                      style={{
                        padding: '0.4rem 0.75rem',
                        fontSize: '0.85rem',
                        backgroundColor: 'var(--ctp-surface1)',
                        color: 'var(--ctp-text)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      {selectedDeadNodes.size === deadNodes.length
                        ? t('security.dead_nodes_deselect_all', 'Deselect All')
                        : t('security.dead_nodes_select_all', 'Select All')}
                    </button>
                    {selectedDeadNodes.size > 0 && canWrite && (
                      <button
                        onClick={handleBulkDeleteDeadNodes}
                        disabled={isDeletingNodes}
                        style={{
                          padding: '0.4rem 0.75rem',
                          fontSize: '0.85rem',
                          backgroundColor: 'var(--ctp-red)',
                          color: 'var(--ctp-base)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: isDeletingNodes ? 'not-allowed' : 'pointer',
                          opacity: isDeletingNodes ? 0.6 : 1
                        }}
                      >
                        {isDeletingNodes
                          ? t('security.dead_nodes_deleting', 'Deleting...')
                          : t('security.dead_nodes_delete_button', 'Delete {{count}} node(s)', { count: selectedDeadNodes.size })}
                      </button>
                    )}
                  </div>
                  <table className="top-broadcasters-table">
                    <thead>
                      <tr>
                        <th style={{ width: '30px' }}></th>
                        <th>{t('security.dead_nodes_name', 'Name')}</th>
                        <th>{t('security.dead_nodes_id', 'ID')}</th>
                        <th>{t('security.dead_nodes_hardware', 'Hardware')}</th>
                        <th>{t('security.dead_nodes_last_heard', 'Last Heard')}</th>
                        <th>{t('security.dead_nodes_location', 'Location')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deadNodes.map(node => (
                        <tr key={node.nodeNum} style={{ opacity: selectedDeadNodes.has(node.nodeNum) ? 1 : 0.8 }}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedDeadNodes.has(node.nodeNum)}
                              onChange={() => toggleDeadNodeSelection(node.nodeNum)}
                            />
                          </td>
                          <td>
                            {node.longName || node.shortName || <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>Unknown</span>}
                            {node.shortName && node.longName && (
                              <span style={{ color: 'var(--ctp-subtext0)', marginLeft: '0.5rem', fontSize: '0.8rem' }}>({node.shortName})</span>
                            )}
                          </td>
                          <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{node.nodeId}</td>
                          <td>{node.hwModel != null ? getHardwareModelName(node.hwModel) : '-'}</td>
                          <td>{formatLastHeard(node.lastHeard)}</td>
                          <td>
                            {node.inDeviceDb ? (
                              <span title={t('security.dead_nodes_in_both', 'In both local and device database')} style={{ color: 'var(--ctp-yellow)' }}>
                                📡 {t('security.dead_nodes_local_and_device', 'Local + Device')}
                              </span>
                            ) : (
                              <span title={t('security.dead_nodes_local_only', 'Only in local database')} style={{ color: 'var(--ctp-subtext0)' }}>
                                💾 {t('security.dead_nodes_local_only_short', 'Local Only')}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>

            {/* Key Mismatch Events Section */}
            <div className="issues-section">
              <h3>{t('security.key_mismatch_title')}</h3>
              {mismatchEvents.length === 0 ? (
                <div className="no-issues">
                  <p>{t('security.key_mismatch_empty')}</p>
                </div>
              ) : (
                <table className="top-broadcasters-table">
                  <thead>
                    <tr>
                      <th>{t('security.node')}</th>
                      <th>{t('security.key_mismatch_detected')}</th>
                      <th>{t('security.key_mismatch_old_key')}</th>
                      <th>{t('security.key_mismatch_new_key')}</th>
                      <th>{t('security.key_mismatch_status')}</th>
                      <th>{t('security.key_mismatch_resolved')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mismatchEvents.map((event) => (
                      <tr key={event.id}>
                        <td>{event.nodeName || `!${event.nodeNum.toString(16).padStart(8, '0')}`}</td>
                        <td>{new Date(event.timestamp).toLocaleString()}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{event.oldKeyFragment || '-'}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{event.newKeyFragment || '-'}</td>
                        <td>{getMismatchStatusLabel(event.action)}</td>
                        <td>{event.action === 'fixed' ? new Date(event.timestamp).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
