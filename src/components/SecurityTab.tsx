import React, { useState, useEffect } from 'react';
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
  const { hasPermission } = useAuth();
  const [issues, setIssues] = useState<SecurityIssuesResponse | null>(null);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expandedNode, setExpandedNode] = useState<number | null>(null);

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
      setError(err instanceof Error ? err.message : 'Failed to load security data');
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

  const triggerScan = async () => {
    setScanning(true);
    try {
      await api.post('/api/security/scanner/scan', {});

      // Wait a moment then refresh data
      setTimeout(fetchSecurityData, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger scan');
    } finally {
      setScanning(false);
    }
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatRelativeTime = (timestamp: number | null) => {
    if (!timestamp) return 'Never';
    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return `${Math.floor(diff / 86400)} days ago`;
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

  const handleNodeClick = (nodeNum: number) => {
    if (onTabChange && onSelectDMNode) {
      // Convert nodeNum to hex string with leading ! for DM node ID
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      onSelectDMNode(nodeId);
      onTabChange('messages');
    }
  };

  const handleSendNotification = (node: SecurityNode, duplicateCount?: number) => {
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
  };

  if (loading) {
    return (
      <div className="security-tab">
        <div className="loading">Loading security data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="security-tab">
        <div className="error">Error: {error}</div>
        <button onClick={fetchSecurityData}>Retry</button>
      </div>
    );
  }

  return (
    <div className="security-tab">
      <div className="security-header">
        <h2>Security Scanner</h2>
        <p>Monitor encryption key security issues including low-entropy and duplicate keys</p>
      </div>

      {/* Scanner Status */}
      <div className="scanner-status">
        <div className="status-card">
          <h3>Scanner Status</h3>
          <div className="status-details">
            <div className="status-row">
              <span className="label">Status:</span>
              <span className={`value ${scannerStatus?.running ? 'running' : 'stopped'}`}>
                {scannerStatus?.scanningNow ? 'Scanning...' : scannerStatus?.running ? 'Active' : 'Stopped'}
              </span>
            </div>
            <div className="status-row">
              <span className="label">Scan Interval:</span>
              <span className="value">Every {scannerStatus?.intervalHours} hours</span>
            </div>
            <div className="status-row">
              <span className="label">Last Scan:</span>
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
              {scanning || scannerStatus?.scanningNow ? 'Scanning...' : 'Run Scan Now'}
            </button>
          )}
        </div>
      </div>

      {/* Summary Statistics */}
      <div className="security-stats">
        <div className="stat-card total">
          <div className="stat-value">{issues?.total || 0}</div>
          <div className="stat-label">Nodes with Issues</div>
        </div>
        <div className="stat-card low-entropy">
          <div className="stat-value">{issues?.lowEntropyCount || 0}</div>
          <div className="stat-label">Have Low-Entropy Keys</div>
        </div>
        <div className="stat-card duplicate">
          <div className="stat-value">{issues?.duplicateKeyCount || 0}</div>
          <div className="stat-label">Have Duplicate Keys</div>
        </div>
      </div>
      {issues && issues.total > 0 && (issues.lowEntropyCount + issues.duplicateKeyCount > issues.total) && (
        <div className="info-note" style={{marginTop: '0.5rem', fontSize: '0.85rem', color: '#666', fontStyle: 'italic'}}>
          Note: Some nodes have both low-entropy and duplicate keys
        </div>
      )}

      {/* Issues List */}
      <div className="security-issues">
        {!issues || issues.total === 0 ? (
          <div className="no-issues">
            <p>No security issues detected.</p>
            <p className="help-text">
              The scanner checks for known low-entropy keys and duplicate keys across your mesh network.
            </p>
          </div>
        ) : (
          <>
            {/* Low-Entropy Keys Section */}
            {issues.lowEntropyCount > 0 && (
              <div className="issues-section">
                <h3>Low-Entropy Keys ({issues.lowEntropyCount})</h3>
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
                  </div>
                  <div className="issue-types">
                    {node.keyIsLowEntropy && (
                      <span className="badge low-entropy">Low-Entropy</span>
                    )}
                    {node.duplicateKeyDetected && (
                      <span className="badge duplicate">Duplicate</span>
                    )}
                  </div>
                  <button
                    className="send-notification-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSendNotification(node);
                    }}
                    title="Send security notification to this node"
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
                      <span className="detail-label">Last Heard:</span>
                      <span className="detail-value">{formatDate(node.lastHeard)}</span>
                    </div>
                    {node.keySecurityIssueDetails && (
                      <div className="detail-row">
                        <span className="detail-label">Details:</span>
                        <span className="detail-value">{node.keySecurityIssueDetails}</span>
                      </div>
                    )}
                    {node.publicKey && (
                      <div className="detail-row">
                        <span className="detail-label">Public Key:</span>
                        <span className="detail-value key-hash">
                          {node.publicKey.substring(0, 32)}...
                        </span>
                      </div>
                    )}
                    <div className="detail-row recommendations">
                      <span className="detail-label">Recommendations:</span>
                      <ul>
                        {node.keyIsLowEntropy && (
                          <li>This node is using a known weak encryption key that can be easily compromised.</li>
                        )}
                        {node.duplicateKeyDetected && (
                          <li>This key is shared with other nodes, reducing privacy and security.</li>
                        )}
                        <li>Consider reconfiguring the node with a secure, randomly-generated encryption key.</li>
                        <li>Consult the Meshtastic documentation for secure key generation practices.</li>
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
                <h3>Duplicate Keys ({issues.duplicateKeyCount} nodes affected)</h3>
                {groupDuplicateKeyNodes(issues.nodes).map((group, groupIndex) => (
                  <div key={groupIndex} className="duplicate-group">
                    <div className="duplicate-group-header">
                      <div className="group-title">
                        <span className="badge duplicate">Shared Key</span>
                        <span className="key-hash">{group.publicKey.substring(0, 32)}...</span>
                      </div>
                      <div className="node-count">{group.nodes.length} nodes sharing this key</div>
                    </div>
                    <div className="duplicate-node-list">
                      {group.nodes.map((node) => (
                        <div key={node.nodeNum} className="duplicate-node-item">
                          <span
                            className="node-link"
                            onClick={() => handleNodeClick(node.nodeNum)}
                          >
                            {node.longName || node.shortName} ({node.shortName})
                          </span>
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
                              title="Send security notification to this node"
                            >
                              →
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="group-recommendations">
                      <strong>Recommendation:</strong> Each of these nodes is using the same encryption key,
                      compromising network security and privacy. Reconfigure each node with a unique,
                      randomly-generated encryption key.
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
