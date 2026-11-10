import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { IssueNodeIdentity } from './IssueNodeIdentity';
import { NotifyControl } from './NotifyControl';
import { useSecurityFormat } from './useSecurityFormat';
import type { NotifyState, SecurityIssueView } from './securityTypes';

interface TimeOffsetSectionProps {
  count: number;
  nodes: SecurityIssueView[];
  expandedKey: string | null;
  onToggle: (nodeKey: string) => void;
  onOpenNode: (nodeKey: string) => void;
  notifyState?: (node: SecurityIssueView) => NotifyState | undefined;
  onNotify?: (node: SecurityIssueView) => void;
}

/** Nodes whose clock is off by more than the threshold. One component for both protocols. */
export const TimeOffsetSection: React.FC<TimeOffsetSectionProps> = ({
  count, nodes, expandedKey, onToggle, onOpenNode, notifyState, onNotify,
}) => {
  const { t } = useTranslation();
  const { formatDate, formatRelativeTime, formatTimeOffset } = useSecurityFormat();
  if (count <= 0) return null;
  return (
    <div className="issues-section">
      <h3>{t('security.time_offset_count', { count })}</h3>
      <p className="section-description">{t('security.time_offset_description')}</p>
      <div className="issues-list">
        {nodes.filter(node => node.isTimeOffsetIssue).map((node) => (
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
                <span className="badge time-offset">{t('security.badge_time_offset')}</span>
                <span className="time-offset-value">{formatTimeOffset(node.timeOffsetSeconds)}</span>
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
                  <span className="detail-label">{t('security.clock_offset')}:</span>
                  <span className="detail-value">{formatTimeOffset(node.timeOffsetSeconds)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">{t('security.last_heard')}:</span>
                  <span className="detail-value">{formatDate(node.lastHeard)}</span>
                </div>
                {node.protocol === 'meshcore' ? (
                  node.timeOffsetSource && (
                    <div className="detail-row">
                      <span className="detail-label">{t('security.offset_source', 'Measured from')}:</span>
                      <span className="detail-value">
                        {node.timeOffsetSource === 'advert'
                          ? t('security.offset_source_advert', 'Advert')
                          : t('security.offset_source_message', 'Direct message')}
                      </span>
                    </div>
                  )
                ) : (
                  <div className="detail-row">
                    <span className="detail-label">{t('security.node_reported_time')}:</span>
                    <span className="detail-value">
                      {node.lastHeard && node.timeOffsetSeconds != null
                        ? formatDate(node.lastHeard - node.timeOffsetSeconds)
                        : t('security.unknown')}
                    </span>
                  </div>
                )}
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
  );
};
