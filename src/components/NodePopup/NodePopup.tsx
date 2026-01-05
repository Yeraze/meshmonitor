import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodePopupState } from '../../types/ui';
import type { DeviceInfo } from '../../types/device';
import type { ResourceType } from '../../types/permission';
import type { DbTraceroute } from '../../services/database';
import { getHardwareModelName, getRoleName } from '../../utils/nodeHelpers';
import { formatDateTime, formatRelativeTime } from '../../utils/datetime';
import { formatTracerouteRoute } from '../../utils/traceroute';
import './NodePopup.css';

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
}) => {
  const { t } = useTranslation();

  // Find the most recent traceroute between current node and popup node
  const recentTraceroute = useMemo(() => {
    if (!traceroutes || !currentNodeId || !nodePopup) return null;

    // Get current node number from ID
    const currentNodeNumStr = currentNodeId.replace('!', '');
    const currentNodeNum = parseInt(currentNodeNumStr, 16);
    if (isNaN(currentNodeNum)) return null;

    // Get popup node number from ID
    const popupNodeNumStr = nodePopup.nodeId.replace('!', '');
    const popupNodeNum = parseInt(popupNodeNumStr, 16);
    if (isNaN(popupNodeNum)) return null;

    // Use 7 days for traceroute visibility (same as Messages tab)
    const TRACEROUTE_DISPLAY_HOURS = 7 * 24;
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

  return (
    <div
      className="route-popup node-popup"
      style={{
        position: 'fixed',
        left: nodePopup.position.x,
        top: nodePopup.position.y - 10,
        transform: 'translateX(-50%) translateY(-100%)',
        zIndex: 1000,
      }}
    >
      <h4>{node.user?.longName || t('node_popup.node_fallback', { nodeNum: node.nodeNum })}</h4>
      {node.user?.shortName && (
        <div className="route-endpoints">
          <strong>{node.user.shortName}</strong>
        </div>
      )}

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

      {node.snr != null && (
        <div className="route-usage">{t('node_popup.snr', 'SNR')}: {node.snr.toFixed(1)} dB</div>
      )}

      {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
        <div className="route-usage">
          {node.deviceMetrics.batteryLevel === 101
            ? t('node_popup.power_plugged', 'Power: Plugged In')
            : t('node_popup.battery', 'Battery: {{level}}%', { level: node.deviceMetrics.batteryLevel })}
        </div>
      )}

      {node.lastHeard && (
        <div className="route-usage">
          {t('node_popup.last_seen', 'Last Seen')}: {formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)}
        </div>
      )}

      {/* Traceroute Section */}
      {recentTraceroute && (
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
      )}

      {node.user?.id && hasPermission('messages', 'read') && (
        <button
          className="popup-dm-btn"
          onClick={() => {
            onDMNode(node.user!.id);
            onClose();
          }}
        >
          💬 {t('node_popup.direct_message', 'Direct Message')}
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
  );
};
