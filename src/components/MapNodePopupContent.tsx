import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceInfo } from '../types/device';
import type { DbTraceroute } from '../services/database';
import type { ResourceType } from '../types/permission';
import { getHardwareModelName, getRoleName, parseNodeId, TRACEROUTE_DISPLAY_HOURS } from '../utils/nodeHelpers';
import { formatDateTime, formatRelativeTime } from '../utils/datetime';
import { formatTracerouteRoute } from '../utils/traceroute';

type PopupTab = 'info' | 'traceroute';

interface MapNodePopupContentProps {
  node: DeviceInfo;
  nodes: DeviceInfo[];
  currentNodeId: string | null;
  timeFormat: '12' | '24';
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
  distanceUnit: 'km' | 'mi' | 'nm';
  traceroutes: DbTraceroute[];
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  onDMNode: () => void;
  onTraceroute?: () => void;
  connectionStatus?: string;
  tracerouteLoading?: string | null;
  getEffectiveHops: (node: DeviceInfo) => number;
}

export const MapNodePopupContent: React.FC<MapNodePopupContentProps> = ({
  node,
  nodes,
  currentNodeId,
  timeFormat,
  dateFormat,
  distanceUnit,
  traceroutes,
  hasPermission,
  onDMNode,
  onTraceroute,
  connectionStatus,
  tracerouteLoading,
  getEffectiveHops,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<PopupTab>('info');

  // Check if traceroute tab should be available
  const hasTracerouteFeatures = hasPermission('traceroute', 'write') && onTraceroute;

  // Find the most recent traceroute between current node and this node
  const recentTraceroute = (() => {
    if (!currentNodeId || !node.user?.id || currentNodeId === node.user.id) return null;

    const currentNodeNum = parseNodeId(currentNodeId);
    if (currentNodeNum === null) return null;

    const cutoff = Date.now() - TRACEROUTE_DISPLAY_HOURS * 60 * 60 * 1000;

    return traceroutes
      .filter(tr => {
        const isRelevant =
          (tr.fromNodeNum === currentNodeNum && tr.toNodeNum === node.nodeNum) ||
          (tr.fromNodeNum === node.nodeNum && tr.toNodeNum === currentNodeNum);
        return isRelevant && tr.timestamp >= cutoff;
      })
      .sort((a, b) => b.timestamp - a.timestamp)[0] || null;
  })();

  return (
    <div className="node-popup">
      {/* Header */}
      <div className="node-popup-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div className="node-popup-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.user?.longName || `Node ${node.nodeNum}`}</div>
        {node.user?.shortName && (
          <div className="node-popup-subtitle" style={{ flexShrink: 0 }}>{node.user.shortName}</div>
        )}
      </div>

      {/* Tab bar - only show if traceroute features are available */}
      {hasTracerouteFeatures && (
        <div className="node-popup-tabs">
          <button
            className={`node-popup-tab ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
            title={t('node_popup.tab_info', 'Node Info')}
          >
            ℹ️
          </button>
          <button
            className={`node-popup-tab ${activeTab === 'traceroute' ? 'active' : ''}`}
            onClick={() => setActiveTab('traceroute')}
            title={t('node_popup.tab_traceroute', 'Traceroute')}
          >
            📡
          </button>
        </div>
      )}

      {/* Info Tab Content */}
      {(activeTab === 'info' || !hasTracerouteFeatures) && (
        <div className="node-popup-content">
          <div className="node-popup-grid">
            {/* Row 1: Node ID (left) + Role (right) */}
            {node.user?.id && (
              <div className="node-popup-item">
                <span className="node-popup-icon">🆔</span>
                <span className="node-popup-value">{node.user.id}</span>
              </div>
            )}

            {node.user?.role !== undefined && (() => {
              const roleNum = typeof node.user.role === 'string'
                ? parseInt(node.user.role, 10)
                : node.user.role;
              const roleName = getRoleName(roleNum);
              return roleName ? (
                <div className="node-popup-item">
                  <span className="node-popup-icon">👤</span>
                  <span className="node-popup-value">{roleName}</span>
                </div>
              ) : null;
            })()}

            {/* Row 2: Hardware Model - full width (can be long text) */}
            {node.user?.hwModel !== undefined && (() => {
              const hwModelName = getHardwareModelName(node.user.hwModel);
              return hwModelName ? (
                <div className="node-popup-item node-popup-item-full">
                  <span className="node-popup-icon">🖥️</span>
                  <span className="node-popup-value">{hwModelName}</span>
                </div>
              ) : null;
            })()}

            {/* Row 3: Hops (left) + Altitude (right) - hops spans full width if alone */}
            {(() => {
              const popupHops = getEffectiveHops(node);
              const hasAltitude = node.position?.altitude != null;
              return popupHops < 999 ? (
                <div className={`node-popup-item${!hasAltitude ? ' node-popup-item-full' : ''}`}>
                  <span className="node-popup-icon">🔗</span>
                  <span className="node-popup-value">{popupHops} hop{popupHops !== 1 ? 's' : ''}</span>
                </div>
              ) : null;
            })()}

            {node.position?.altitude != null && (
              <div className="node-popup-item">
                <span className="node-popup-icon">⛰️</span>
                <span className="node-popup-value">{node.position.altitude}m</span>
              </div>
            )}
          </div>

          {node.lastHeard && (
            <div className="node-popup-footer">
              <span className="node-popup-icon">🕐</span>
              {formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)}
            </div>
          )}

          {/* Action button for info tab */}
          {node.user?.id && hasPermission('messages', 'read') && (
            <button className="node-popup-btn" onClick={onDMNode}>
              🔍 More Details
            </button>
          )}
        </div>
      )}

      {/* Traceroute Tab Content */}
      {activeTab === 'traceroute' && hasTracerouteFeatures && (
        <div className="node-popup-content">
          {/* Recent Traceroute Display */}
          {recentTraceroute ? (
            <div className="node-popup-traceroute">
              <div className="traceroute-header">
                <strong>{t('node_popup.last_traceroute')}</strong>
                <span className="traceroute-age">
                  ({formatRelativeTime(recentTraceroute.timestamp)})
                </span>
              </div>
              {recentTraceroute.route && recentTraceroute.route !== 'null' ? (
                <>
                  <div className="traceroute-path">
                    <span className="traceroute-label">{t('node_popup.forward_path')}:</span>
                    <span className="traceroute-route">
                      {formatTracerouteRoute(
                        recentTraceroute.route,
                        recentTraceroute.snrTowards,
                        recentTraceroute.fromNodeNum,
                        recentTraceroute.toNodeNum,
                        nodes,
                        distanceUnit
                      )}
                    </span>
                  </div>
                  {recentTraceroute.routeBack && recentTraceroute.routeBack !== 'null' && (
                    <div className="traceroute-path">
                      <span className="traceroute-label">{t('node_popup.return_path')}:</span>
                      <span className="traceroute-route">
                        {formatTracerouteRoute(
                          recentTraceroute.routeBack,
                          recentTraceroute.snrBack,
                          recentTraceroute.toNodeNum,
                          recentTraceroute.fromNodeNum,
                          nodes,
                          distanceUnit
                        )}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="traceroute-failed">
                  {t('node_popup.traceroute_failed')}
                </div>
              )}
            </div>
          ) : (
            <div className="node-popup-no-traceroute">
              {t('node_popup.no_recent_traceroute', 'No recent traceroute data')}
            </div>
          )}

          {/* Traceroute action button */}
          {node.user?.id && onTraceroute && (
            <button
              className="node-popup-btn"
              onClick={onTraceroute}
              disabled={connectionStatus !== 'connected' || tracerouteLoading === node.user?.id}
            >
              {tracerouteLoading === node.user?.id ? (
                <span className="spinner"></span>
              ) : (
                '📡'
              )}{' '}
              {t('node_popup.traceroute', 'Traceroute')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
