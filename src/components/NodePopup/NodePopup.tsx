import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NodePopupState } from '../../types/ui';
import type { DeviceInfo } from '../../types/device';
import type { ResourceType } from '../../types/permission';
import { getHardwareModelName, getRoleName } from '../../utils/nodeHelpers';
import { formatDateTime } from '../../utils/datetime';
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
}) => {
  const { t } = useTranslation();

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
