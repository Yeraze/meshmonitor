import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodePopupState } from '../../types/ui';
import type { DeviceInfo } from '../../types/device';
import type { ResourceType } from '../../types/permission';
import type { DbTraceroute } from '../../services/database';
import { getHardwareModelName, getRoleName, parseNodeId, TRACEROUTE_DISPLAY_HOURS } from '../../utils/nodeHelpers';
import { formatDateTime, formatRelativeTime } from '../../utils/datetime';
import { formatTracerouteRoute } from '../../utils/traceroute';
import './NodePopup.css';

type PopupTab = 'info' | 'traceroute';

interface NodePopupProps {
  nodePopup: NodePopupState | null;
  nodes: DeviceInfo[];
  timeFormat: '12' | '24';
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  onDMNode: (nodeId: string) => void;
  onShowOnMap: (node: DeviceInfo) => void;
  onClose: () => void;
  traceroutes?: DbTraceroute[];
  currentNodeId?: string | null;
  distanceUnit?: 'km' | 'mi' | 'nm';
  onViewTracerouteHistory?: (fromNodeNum: number, toNodeNum: number, fromNodeName: string, toNodeName: string) => void;
  onTraceroute?: (nodeId: string) => void;
  connectionStatus?: string;
  tracerouteLoading?: string | null;
}

export const NodePopup: React.FC<NodePopupProps> = ({
  nodePopup,
  nodes,
  timeFormat,
  dateFormat,
  hasPermission,
  onDMNode,
  onShowOnMap,
  onClose,
  traceroutes,
  currentNodeId,
  distanceUnit = 'km',
  onViewTracerouteHistory,
  onTraceroute,
  connectionStatus,
  tracerouteLoading,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<PopupTab>('info');

  // Find the most recent traceroute between current node and popup node
  const recentTraceroute = useMemo(() => {
    if (!traceroutes || !currentNodeId || !nodePopup) return null;

    // Get current node number from ID
    const currentNodeNum = parseNodeId(currentNodeId);
    if (currentNodeNum === null) return null;

    // Get popup node number from ID
    const popupNodeNum = parseNodeId(nodePopup.nodeId);
    if (popupNodeNum === null) return null;

    // Use shared constant for traceroute visibility window
    const cutoff = Date.now() - TRACEROUTE_DISPLAY_HOURS * 60 * 60 * 1000;

    // Find traceroutes between these two nodes
    const relevantTraceroutes = traceroutes
      .filter(tr => {
        const isRelevant =
          (tr.fromNodeNum === currentNodeNum && tr.toNodeNum === popupNodeNum) ||
          (tr.fromNodeNum === popupNodeNum && tr.toNodeNum === currentNodeNum);

        if (!isRelevant || tr.timestamp < cutoff) {
          return false;
        }

        // Include all traceroutes, even failed ones
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return relevantTraceroutes.length > 0 ? relevantTraceroutes[0] : null;
  }, [traceroutes, currentNodeId, nodePopup]);

  if (!nodePopup) return null;

  const node = nodes.find(n => n.user?.id === nodePopup.nodeId);
  if (!node) return null;

  // Check if traceroute tab should be available
  const hasTracerouteFeatures = hasPermission('traceroute', 'write') && onTraceroute;

  return (
    <div
      className="route-popup node-popup"
      style={{
        position: 'fixed',
        left: nodePopup.position.x,
        top: nodePopup.position.y - 10,
        transform: 'translateX(-50%) translateY(-100%)',
        zIndex: 10002, // Above sidebar (10001)
      }}
    >
      {/* Header with node name */}
      <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.user?.longName || t('node_popup.node_fallback', { nodeNum: node.nodeNum })}</span>
        {node.user?.shortName && (
          <span style={{ fontSize: '0.75rem', color: 'var(--ctp-blue)', background: 'var(--ctp-surface1)', padding: '0.1rem 0.4rem', borderRadius: '4px', flexShrink: 0 }}>{node.user.shortName}</span>
        )}
      </h4>

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
          {node.user?.id && <div className="route-usage">{t('node_popup.id', 'ID')}: {node.user.id}</div>}

          {node.user?.role !== undefined &&
            (() => {
              const roleNum = typeof node.user.role === 'string' ? parseInt(node.user.role, 10) : node.user.role;
              const roleName = getRoleName(roleNum);
              return roleName ? <div className="route-usage">{t('node_popup.role', 'Role')}: {roleName}</div> : null;
            })()}

          {node.user?.hwModel !== undefined &&
            (() => {
              const hwModelName = getHardwareModelName(node.user.hwModel);
              return hwModelName ? <div className="route-usage">{t('node_popup.hardware', 'Hardware')}: {hwModelName}</div> : null;
            })()}

          {(node.snr != null || (node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null)) && (
            <div className="route-usage" style={{ display: 'flex', gap: '1rem' }}>
              {node.snr != null && (
                <span>📶 {node.snr.toFixed(1)} dB</span>
              )}
              {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                <span>{node.deviceMetrics.batteryLevel === 101 ? '🔌 Plugged In' : `🔋 ${node.deviceMetrics.batteryLevel}%`}</span>
              )}
            </div>
          )}

          {node.lastHeard && (
            <div className="route-usage">
              {t('node_popup.last_seen', 'Last Seen')}: {formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)}
            </div>
          )}

          {/* Action buttons for info tab */}
          {node.user?.id && hasPermission('messages', 'read') && (
            <button
              className="popup-dm-btn"
              onClick={() => {
                onDMNode(node.user!.id);
                onClose();
              }}
            >
              🔍 {t('node_popup.more_details', 'More Details')}
            </button>
          )}
          {node.user?.id && node.position?.latitude != null && node.position?.longitude != null && (
            <button
              className="popup-dm-btn"
              onClick={() => {
                onShowOnMap(node);
                onClose();
              }}
            >
              🗺️ {t('node_popup.show_on_map', 'Show on Map')}
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
                <strong>{t('node_popup.last_traceroute', 'Last Traceroute')}</strong>
                <span className="traceroute-age">
                  ({formatRelativeTime(recentTraceroute.timestamp)})
                </span>
              </div>
              {recentTraceroute.route && recentTraceroute.route !== 'null' ? (
                <>
                  <div className="traceroute-path">
                    <span className="traceroute-label">{t('node_popup.forward_path', 'Forward')}:</span>
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
                      <span className="traceroute-label">{t('node_popup.return_path', 'Return')}:</span>
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
                  {t('node_popup.traceroute_failed', 'No response received')}
                </div>
              )}
              {onViewTracerouteHistory && (
                <button
                  className="popup-dm-btn traceroute-history-btn"
                  onClick={() => {
                    const localNodeName = nodes.find(n => n.user?.id === currentNodeId)?.user?.longName || currentNodeId || 'Local';
                    const remoteNodeName = node.user?.longName || nodePopup.nodeId;
                    onViewTracerouteHistory(
                      recentTraceroute.fromNodeNum,
                      recentTraceroute.toNodeNum,
                      localNodeName,
                      remoteNodeName
                    );
                  }}
                >
                  {t('node_popup.view_traceroute_history', 'View History')}
                </button>
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
              className="popup-dm-btn"
              onClick={() => {
                onTraceroute(node.user!.id);
              }}
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
