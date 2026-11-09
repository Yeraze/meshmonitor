import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { TabType } from '../types/ui';
import { getHardwareModelName } from '../utils/hardwareModel';
import { ApiError } from '../services/api';
import { securityCapabilities, type SecurityDeviceType } from '../utils/securityCapabilities';
import { securityNotificationText } from '../utils/securityNotificationText';
import { DeadNodesSection } from './security/DeadNodesSection';
import { PathHashCollisionsSection } from './security/PathHashCollisionsSection';
import { AdvertSignatureSection } from './security/AdvertSignatureSection';
import { NameReuseSection } from './security/NameReuseSection';
import { OwnKeyChangeCard } from './security/OwnKeyChangeCard';
import { ScannerStatusCard } from './security/ScannerStatusCard';
import { SecurityExportMenu } from './security/SecurityExportMenu';
import { SecurityDigestCard } from './security/SecurityDigestCard';
import { TopBroadcastersTable } from './security/TopBroadcastersTable';
import { ExcessivePacketsSection } from './security/ExcessivePacketsSection';
import { TimeOffsetSection } from './security/TimeOffsetSection';
import { useSecurityFormat } from './security/useSecurityFormat';
import securityStyles from './security/SecurityIssues.module.css';
import type {
  DeadNode,
  DeadNodesResponse,
  MeshcoreFindings,
  MeshcoreFindingsResponse,
  NotifyKind,
  NotifyState,
  ScannerStatus,
  SecurityIssueView,
  SecurityIssuesResponse,
} from './security/securityTypes';
import { useResolvedSourceId } from '../hooks/useResolvedSourceId';
import '../styles/SecurityTab.css';

type SecurityNode = SecurityIssueView;

interface DuplicateKeyGroup {
  publicKey: string;
  nodes: SecurityNode[];
}

interface SecurityTabProps {
  onTabChange?: (tab: TabType) => void;
  /**
   * Open a node by `mt:<n>` / `mc:<pk>` key. The host owns navigation
   * (Meshtastic selects the DM thread and switches tab; MeshCore opens Node
   * Details), so the tab only checks the viewer may read messages.
   */
  onOpenNode?: (nodeKey: string) => void;
  /**
   * Open a node's DM AND pre-fill the compose draft atomically. Must be used
   * (rather than separate select + setNewMessage calls) so the #4183
   * draft-scoping effect doesn't treat the switch as a conversation change
   * and wipe the pre-filled notification text.
   */
  onOpenDmWithDraft?: (nodeKey: string, message: string) => void;
  /** Source to inspect; defaults to the context source, else the primary. */
  sourceId?: string;
  /** Source type; anything not MeshCore gets the Meshtastic sections. */
  sourceType?: string;
  /** MeshCore device kind (number enum or label); the notification DM needs a Companion. */
  deviceType?: SecurityDeviceType;
}

export const SecurityTab: React.FC<SecurityTabProps> = ({ onOpenNode, onOpenDmWithDraft, sourceId: sourceIdProp, sourceType, deviceType }) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  // Resolve a concrete sourceId (context source, else the primary) — the
  // security endpoints are source-scoped and now require one.
  const resolvedSourceId = useResolvedSourceId();
  const sourceId = sourceIdProp ?? resolvedSourceId;
  const caps = securityCapabilities(sourceType, deviceType);
  const { formatDate, formatRelativeTime } = useSecurityFormat();
  const isMeshCore = !!sourceType && !caps.lowEntropy;
  const [issues, setIssues] = useState<SecurityIssuesResponse | null>(null);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [mismatchEvents, setMismatchEvents] = useState<any[]>([]);
  const [deadNodes, setDeadNodes] = useState<DeadNode[]>([]);
  const [deadThresholdDays, setDeadThresholdDays] = useState(isMeshCore ? 14 : 7);
  const [deadNodesForbidden, setDeadNodesForbidden] = useState(false);
  const [findings, setFindings] = useState<MeshcoreFindings | null>(null);
  const [findingsForbidden, setFindingsForbidden] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [issuesForbidden, setIssuesForbidden] = useState(false);

  const canWrite = hasPermission('security', 'write');
  const canWriteNodes = hasPermission('nodes', 'write', { sourceId });
  const canEditSettings = hasPermission('settings', 'write');

  // A 403 on a section's route means no nodes:read on this source. Remember
  // it per section and stop asking: the 30 s poll must not retry-loop.
  const deadNodesForbiddenRef = useRef(false);
  const findingsForbiddenRef = useRef(false);
  const issuesForbiddenRef = useRef(false);
  // Bumped on every source switch; a response from an older generation is
  // dropped so a slow request can't repaint the previous source's data.
  const fetchGenRef = useRef(0);

  const fetchDeadNodes = async (srcParam: string, gen: number) => {
    if (deadNodesForbiddenRef.current) return;
    try {
      const data = await api.get<DeadNodesResponse>(`/api/security/dead-nodes${srcParam}`);
      if (gen !== fetchGenRef.current) return;
      setDeadNodes(data.nodes || []);
      if (typeof data.thresholdDays === 'number') setDeadThresholdDays(data.thresholdDays);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        deadNodesForbiddenRef.current = true;
        setDeadNodesForbidden(true);
        setDeadNodes([]);
      } else {
        throw err;
      }
    }
  };

  const fetchFindings = async (srcParam: string, gen: number) => {
    if (findingsForbiddenRef.current) return;
    try {
      const res = await api.get<MeshcoreFindingsResponse>(`/api/security/meshcore/findings${srcParam}`);
      if (gen !== fetchGenRef.current) return;
      setFindings(res.data ?? null);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        findingsForbiddenRef.current = true;
        setFindingsForbidden(true);
        setFindings(null);
      } else {
        throw err;
      }
    }
  };

  /** Issues + scanner status. On MeshCore a 403 (no nodes:read) is remembered and not retried. */
  const fetchIssues = async (srcParam: string, gen: number) => {
    if (issuesForbiddenRef.current) return;
    try {
      const [issuesData, statusData] = await Promise.all([
        api.get<SecurityIssuesResponse>(`/api/security/issues${srcParam}`),
        api.get<ScannerStatus>(`/api/security/scanner/status${srcParam}`),
      ]);
      if (gen !== fetchGenRef.current) return;
      setIssues({
        ...issuesData,
        nodes: (issuesData.nodes ?? []).map(n => ({ ...n, nodeKey: n.nodeKey ?? `mt:${n.nodeNum}` })),
      });
      setScannerStatus(statusData);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      if (isMeshCore && err instanceof ApiError && err.status === 403) {
        issuesForbiddenRef.current = true;
        setIssuesForbidden(true);
        setIssues(null);
      } else {
        throw err;
      }
    }
  };

  const fetchSecurityData = async () => {
    // Defer until a sourceId resolves — the security endpoints require one.
    if (!sourceId) return;
    const gen = fetchGenRef.current;
    try {
      const srcParam = `?sourceId=${encodeURIComponent(sourceId)}`;
      if (isMeshCore) {
        await Promise.all([
          caps.deadNodes ? fetchDeadNodes(srcParam, gen) : Promise.resolve(),
          fetchFindings(srcParam, gen),
          fetchIssues(srcParam, gen),
        ]);
      } else {
        const [mismatchData] = await Promise.all([
          api.get<{ events: any[] }>(`/api/security/key-mismatches${srcParam}`),
          fetchIssues(srcParam, gen),
          fetchDeadNodes(srcParam, gen),
        ]);
        if (gen !== fetchGenRef.current) return;
        setMismatchEvents(mismatchData.events || []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_load'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // New source: invalidate in-flight responses and clear the previous
    // source's lists so they never flash under the new one (#6283 review).
    fetchGenRef.current += 1;
    setDeadNodes([]);
    setFindings(null);
    setIssues(null);
    setScannerStatus(null);
    deadNodesForbiddenRef.current = false;
    findingsForbiddenRef.current = false;
    issuesForbiddenRef.current = false;
    setDeadNodesForbidden(false);
    setFindingsForbidden(false);
    setIssuesForbidden(false);
    void fetchSecurityData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchSecurityData, 30000);
    return () => clearInterval(interval);
  }, [sourceId, isMeshCore]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleNodeClick = useCallback((nodeKey: string) => {
    // Check if user has permission to view messages before navigating
    if (!hasPermission('messages', 'read')) {
      setError(t('security.no_permission_messages'));
      return;
    }
    onOpenNode?.(nodeKey);
  }, [onOpenNode, hasPermission, t]);

  const handleOpenFindingNode = useCallback((nodeKey: string) => {
    if (!hasPermission('messages', 'read')) {
      setError(t('security.no_permission_messages'));
      return;
    }
    onOpenNode?.(nodeKey);
  }, [onOpenNode, hasPermission, t]);

  /**
   * Open the node's DM with a pre-filled draft. The user reads it and presses
   * Send: nothing here sends. The host selects the node and sets the draft
   * atomically (survives the #4183 draft-scoping clear).
   */
  const openNotification = useCallback((node: SecurityNode, message: string) => {
    if (!hasPermission('messages', 'write', { sourceId })) {
      setError(t('security.no_permission_send'));
      return;
    }
    onOpenDmWithDraft?.(node.nodeKey, message);
  }, [onOpenDmWithDraft, hasPermission, sourceId, t]);

  const handleSendNotification = useCallback((node: SecurityNode, duplicateCount?: number) => {
    if (node.keyIsLowEntropy) {
      openNotification(node, securityNotificationText('lowEntropy'));
    } else if (node.duplicateKeyDetected && duplicateCount) {
      openNotification(node, securityNotificationText('duplicateKey', { duplicateCount }));
    } else {
      openNotification(node, '');
    }
  }, [openNotification]);

  const sendKindNotification = useCallback((node: SecurityNode, kind: NotifyKind) => {
    openNotification(
      node,
      kind === 'excessivePackets'
        ? securityNotificationText('excessivePackets', { packetsPerHour: node.packetRatePerHour })
        : securityNotificationText('timeOffset', { offsetSeconds: node.timeOffsetSeconds }),
    );
  }, [openNotification]);

  /**
   * Whether a row gets the "Send notification" button. Needs a DM-capable
   * source (`caps.notifyDm`), a host that opens the draft, and messages:write on
   * this source. MeshCore also needs a chat contact (Repeaters and Room Servers
   * do not read DMs) that is in the radio's table, and warns when the DM would flood.
   */
  const notifyStateFor = useCallback((node: SecurityNode): NotifyState => {
    if (!caps.notifyDm || !onOpenDmWithDraft || !hasPermission('messages', 'write', { sourceId })) {
      return { visible: false };
    }
    if (node.protocol !== 'meshcore') return { visible: true };
    if (node.advType !== 1) return { visible: false };
    if (node.onDevice === false) {
      return {
        visible: true,
        disabled: true,
        hint: t('security.notify_not_on_device', 'This contact is not on the radio, so it cannot receive a DM.'),
      };
    }
    return { visible: true, floodWarning: node.hasKnownPath === false };
  }, [caps.notifyDm, onOpenDmWithDraft, hasPermission, sourceId, t]);

  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    try {
      const exportUrl = `/api/security/export?format=${format}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}`;
      await api.download(exportUrl, { filename: `security-scan-${Date.now()}.${format}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_export'));
    }
  }, [t, sourceId]);

  const getMismatchStatusLabel = (action: string): string => {
    switch (action) {
      case 'mismatch': return t('security.key_mismatch_status_pending');
      case 'purge': return t('security.key_mismatch_status_purged');
      case 'fixed': return t('security.key_mismatch_status_fixed');
      case 'exhausted': return t('security.key_mismatch_status_exhausted');
      default: return action;
    }
  };

  const acknowledgeOwnKey = useCallback(async () => {
    if (!sourceId) return;
    setAcknowledging(true);
    try {
      await api.post('/api/security/own-key/acknowledge', { sourceId });
      await fetchSecurityData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('security.failed_load'));
    } finally {
      setAcknowledging(false);
    }
  }, [sourceId, t]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const deadNodesSection = caps.deadNodes && sourceId ? (
    <DeadNodesSection
      nodes={deadNodes}
      thresholdDays={deadThresholdDays}
      sourceId={sourceId}
      isMeshCore={isMeshCore}
      forbidden={deadNodesForbidden}
      canDelete={canWrite && canWriteNodes}
      canEditThreshold={canEditSettings}
      onChanged={fetchSecurityData}
    />
  ) : null;

  const toggleExpanded = (nodeKey: string) => setExpandedKey(prev => (prev === nodeKey ? null : nodeKey));
  const issueNodes = issues?.nodes ?? [];
  const newRowNotify = onOpenDmWithDraft
    ? {
        excessive: (node: SecurityNode) => sendKindNotification(node, 'excessivePackets'),
        offset: (node: SecurityNode) => sendKindNotification(node, 'timeOffset'),
      }
    : null;

  if (isMeshCore) {
    return (
      <div className="security-tab">
        <div className="security-header">
          <div className="header-content">
            <div>
              <h2>{t('security.title')}</h2>
              <p>{t('security.mc_description', 'Checks on the contacts this source has heard.')}</p>
            </div>
            {caps.scanner && !issuesForbidden && <SecurityExportMenu onExport={handleExport} />}
          </div>
        </div>
        {issuesForbidden ? (
          <p className="no-issues" data-testid="security-issues-forbidden">
            {t('security.mc_no_node_access', 'You do not have access to this source\'s nodes.')}
          </p>
        ) : (
          <>
            {caps.scanner && (
              <ScannerStatusCard status={scannerStatus} canWrite={canWrite} scanning={scanning} onScan={triggerScan} />
            )}
            {issues?.packetLogEnabled === false && (
              <p className={securityStyles.hint} data-testid="security-packet-log-off">
                {t('security.mc_packet_log_off', 'Enable the MeshCore Packet Monitor to measure rates')}
              </p>
            )}
            {caps.digest && canWrite && <SecurityDigestCard sourceId={sourceId} />}
            {issues && (
              <div className="security-stats">
                <div className="stat-card total">
                  <div className="stat-value">{issues.total}</div>
                  <div className="stat-label">{t('security.nodes_with_issues')}</div>
                </div>
                {caps.spam && (
                  <div className="stat-card excessive-packets">
                    <div className="stat-value">{issues.excessivePacketsCount}</div>
                    <div className="stat-label">{t('security.have_excessive_packets')}</div>
                  </div>
                )}
                {caps.timeOffset && (
                  <div className="stat-card time-offset">
                    <div className="stat-value">{issues.timeOffsetCount}</div>
                    <div className="stat-label">{t('security.have_time_offset')}</div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {findingsForbidden ? (
          <p className="no-issues" data-testid="security-findings-forbidden">
            {t('security.mc_no_node_access', 'You do not have access to this source\'s nodes.')}
          </p>
        ) : findings && (
          <>
            {caps.ownKeyChange && (
              <OwnKeyChangeCard
                ownKey={findings.ownKey}
                canAcknowledge={canWrite}
                acknowledging={acknowledging}
                onAcknowledge={acknowledgeOwnKey}
              />
            )}
            {caps.pathHashCollisions && (
              <PathHashCollisionsSection collisions={findings.pathHashCollisions} onOpenNode={onOpenNode ? handleOpenFindingNode : undefined} />
            )}
            {caps.advertSignatures && (
              <AdvertSignatureSection failures={findings.signatureFailures} onOpenNode={onOpenNode ? handleOpenFindingNode : undefined} />
            )}
            {caps.nameReuse && (
              <NameReuseSection groups={findings.nameReuse} onOpenNode={onOpenNode ? handleOpenFindingNode : undefined} />
            )}
          </>
        )}
        {issues && !issuesForbidden && (
          <>
            {caps.spam && (
              <>
                <TopBroadcastersTable broadcasters={issues.topBroadcasters} onOpenNode={handleNodeClick} />
                <ExcessivePacketsSection
                  count={issues.excessivePacketsCount}
                  nodes={issueNodes}
                  expandedKey={expandedKey}
                  onToggle={toggleExpanded}
                  onOpenNode={handleNodeClick}
                  notifyState={notifyStateFor}
                  onNotify={newRowNotify?.excessive}
                />
              </>
            )}
            {caps.timeOffset && (
              <TimeOffsetSection
                count={issues.timeOffsetCount}
                nodes={issueNodes}
                expandedKey={expandedKey}
                onToggle={toggleExpanded}
                onOpenNode={handleNodeClick}
                notifyState={notifyStateFor}
                onNotify={newRowNotify?.offset}
              />
            )}
          </>
        )}
        {deadNodesSection}
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
          <SecurityExportMenu onExport={handleExport} />
        </div>
      </div>

      <ScannerStatusCard status={scannerStatus} canWrite={canWrite} scanning={scanning} onScan={triggerScan} />

      {/* Security Digest */}
      {canWrite && <SecurityDigestCard sourceId={sourceId} />}

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
              <div key={node.nodeKey} className="issue-card">
                <div
                  className="issue-header"
                  onClick={() => toggleExpanded(node.nodeKey)}
                >
                  <div className="node-info">
                    <div className="node-name">
                      <span
                        className="node-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNodeClick(node.nodeKey);
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
                    <UiIcon name="forward" size={14} />
                  </button>
                  <div className="expand-icon">
                    <UiIcon name={expandedKey === node.nodeKey ? 'chevronDown' : 'forward'} />
                  </div>
                </div>

                {expandedKey === node.nodeKey && (
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
                        <div key={node.nodeKey} className="duplicate-node-item">
                          <div className="duplicate-node-info">
                            <span
                              className="node-link"
                              onClick={() => handleNodeClick(node.nodeKey)}
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
                              <UiIcon name="forward" size={14} />
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
            <TopBroadcastersTable broadcasters={issues.topBroadcasters} onOpenNode={handleNodeClick} />

            {/* Excessive Packets Section */}
            <ExcessivePacketsSection
              count={issues.excessivePacketsCount}
              nodes={issueNodes}
              expandedKey={expandedKey}
              onToggle={toggleExpanded}
              onOpenNode={handleNodeClick}
              notifyState={notifyStateFor}
              onNotify={newRowNotify?.excessive}
            />

            {/* Time Offset Section */}
            <TimeOffsetSection
              count={issues.timeOffsetCount}
              nodes={issueNodes}
              expandedKey={expandedKey}
              onToggle={toggleExpanded}
              onOpenNode={handleNodeClick}
              notifyState={notifyStateFor}
              onNotify={newRowNotify?.offset}
            />
            {deadNodesSection}

            {/* Key Mismatch Events Section */}
            <div className="issues-section">
              <h3>{t('security.key_mismatch_title')}</h3>
              {mismatchEvents.length === 0 ? (
                <div className="no-issues">
                  <p>{t('security.key_mismatch_empty')}</p>
                </div>
              ) : (
                <div className="security-table-scroll">
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
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
