import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { IssueNodeIdentity } from './IssueNodeIdentity';
import { NotifyControl } from './NotifyControl';
import { useSecurityFormat } from './useSecurityFormat';
import type { NotifyState, SecurityIssueView } from './securityTypes';

interface ExcessivePacketsSectionProps {
  count: number;
  nodes: SecurityIssueView[];
  expandedKey: string | null;
  onToggle: (nodeKey: string) => void;
  onOpenNode: (nodeKey: string) => void;
  notifyState?: (node: SecurityIssueView) => NotifyState | undefined;
  onNotify?: (node: SecurityIssueView) => void;
}

/** Nodes above the packets-per-hour threshold. One component for both protocols. */
export const ExcessivePacketsSection: React.FC<ExcessivePacketsSectionProps> = ({
  count, nodes, expandedKey, onToggle, onOpenNode, notifyState, onNotify,
}) => {
  const { t } = useTranslation();
  const { formatDate, formatRelativeTime } = useSecurityFormat();
  if (count <= 0) return null;
  return (
    <div className="issues-section">
      <h3>{t('security.excessive_packets_count', { count })}</h3>
      <div className="issues-list">
        {nodes.filter(node => node.isExcessivePackets).map((node) => (
          <div key={node.nodeKey} className="issue-card">
            <div className="issue-header" onClick={() => onToggle(node.nodeKey)}>
              <div className="node-info">
                <div className="node-name">
                  <span
                    className="node-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenNode(node.nodeKey);
                    }}
                  >
                    {node.longName || node.shortName} ({node.shortName})
                  </span>
                </div>
                <IssueNodeIdentity node={node} />
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
              {onNotify && (
                <NotifyControl state={notifyState?.(node)} onSend={() => onNotify(node)} />
              )}
              <div className="expand-icon">
                <UiIcon name={expandedKey === node.nodeKey ? 'chevronDown' : 'forward'} />
              </div>
            </div>

            {expandedKey === node.nodeKey && (
              <div className="issue-details">
                <div className="detail-row">
                  <span className="detail-label">{t('security.packet_rate')}:</span>
                  <span className="detail-value">{node.packetRatePerHour || 0} {t('security.packets_per_hour')}</span>
                </div>
                {node.protocol === 'meshcore' && node.advertRatePerHour != null && (
                  <div className="detail-row">
                    <span className="detail-label">{t('security.advert_rate', 'Adverts')}:</span>
                    <span className="detail-value">{node.advertRatePerHour} {t('security.packets_per_hour')}</span>
                  </div>
                )}
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
  );
};
