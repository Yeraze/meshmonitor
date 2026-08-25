import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthStatus } from '../../contexts/AuthContext';
import type { ResourceType } from '../../types/permission';
import type { LocalNodeInfo, BasicNodeInfo } from '../../types/device';
import type { ConnectionStatus } from '../../types/ui';
import UserMenu from '../UserMenu';
import './AppHeader.css';
import { UiIcon } from '../icons';
import { CyclingConnectionStatus } from './CyclingConnectionStatus';

interface DeviceInfoProp {
  localNodeInfo?: LocalNodeInfo;
}

/**
 * The header receives full node objects (DeviceInfo[]) from App.tsx even though
 * only the identity + local-node telemetry is used here. Widen the minimal
 * BasicNodeInfo with the metrics the cycling status badge reads (#4917).
 */
export interface HeaderNode extends BasicNodeInfo {
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
  };
}

interface AppHeaderProps {
  baseUrl: string;
  nodeAddress: string;
  currentNodeId: string;
  nodes: HeaderNode[];
  deviceInfo: DeviceInfoProp | null;
  authStatus: AuthStatus | null;
  connectionStatus: ConnectionStatus;
  webSocketConnected: boolean;
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  onFetchSystemStatus: () => void;
  onShowLoginModal: () => void;
  onLogout: () => void;
  onNodeClick?: () => void;
  /** Source name to display when in multi-source mode */
  sourceName?: string | null;
  /** Called when the user clicks the back-to-sources button */
  onBackToSources?: () => void;
  /**
   * MQTT-bridge mirror dashboard. Bridges have no local device, so the
   * fallback `nodeAddress` (env-default Meshtastic IP) would otherwise leak
   * into the header. Hides the node-info slot entirely when true.
   */
  mqttReadOnly?: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  baseUrl,
  nodeAddress,
  currentNodeId,
  nodes,
  deviceInfo,
  authStatus,
  connectionStatus,
  webSocketConnected,
  onFetchSystemStatus,
  onShowLoginModal,
  onLogout,
  onNodeClick,
  sourceName,
  onBackToSources,
  mqttReadOnly = false,
}) => {
  const { t } = useTranslation();

  const getConnectionStatusText = () => {
    switch (connectionStatus) {
      case 'user-disconnected':
        return t('header.status.disconnected');
      case 'configuring':
        return t('header.status.initializing');
      case 'node-offline':
        return t('header.status.nodeOffline');
      case 'connected':
        return t('header.status.connected');
      case 'disconnected':
        return t('header.status.disconnected');
      default:
        return connectionStatus;
    }
  };

  const renderNodeInfo = () => {
    const localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;
    const isClickable = !!onNodeClick;

    if (!localNode && deviceInfo?.localNodeInfo) {
      const { nodeId, longName, shortName } = deviceInfo.localNodeInfo;
      return (
        <span
          className={`node-address${isClickable ? ' clickable' : ''}`}
          title={isClickable ? t('header.clickForNodeInfo') : undefined}
          style={{ cursor: isClickable ? 'pointer' : 'default' }}
          onClick={isClickable ? onNodeClick : undefined}
        >
          {longName} ({shortName}) - {nodeId}
        </span>
      );
    }

    if (localNode && localNode.user) {
      return (
        <span
          className={`node-address${isClickable ? ' clickable' : ''}`}
          title={isClickable ? t('header.clickForNodeInfo') : undefined}
          style={{ cursor: isClickable ? 'pointer' : 'default' }}
          onClick={isClickable ? onNodeClick : undefined}
        >
          {localNode.user.longName} ({localNode.user.shortName}) - {localNode.user.id}
        </span>
      );
    }

    return <span className="node-address">{nodeAddress}</span>;
  };

  // Whether the source name / node identity opens the node-info popup (#4908):
  // needs a handler, and honors the same auth/mqtt gate the node box used.
  const canOpenNodeInfo = !!onNodeClick && !mqttReadOnly && !!authStatus?.authenticated;

  // Local-node telemetry for the cycling status badge (#4917). MQTT-bridge
  // dashboards have no local device, so never surface metrics there.
  const localNodeMetrics = mqttReadOnly
    ? undefined
    : (currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : undefined)?.deviceMetrics;

  return (
    <header className="app-header">
      <div className="header-left">
        {onBackToSources && (
          <button
            className="back-to-sources-btn"
            onClick={onBackToSources}
            title="Back to source list"
          >
            <UiIcon name="back" size={16} /> Sources
          </button>
        )}
        <div className="header-title">
          <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="header-logo" />
          <h1>MeshMonitor</h1>
          {/* Show only the source name (#4908) — clickable to open the node-info
              popup, which now carries the full node identity that used to be
              duplicated in a separate gray box beside it. */}
          {sourceName && (
            <span
              className={`header-source-name${canOpenNodeInfo ? ' clickable' : ''}`}
              title={canOpenNodeInfo ? t('header.clickForNodeInfo') : undefined}
              style={{ cursor: canOpenNodeInfo ? 'pointer' : 'default' }}
              onClick={canOpenNodeInfo ? onNodeClick : undefined}
            >
              {sourceName}
            </span>
          )}
        </div>
        {/* Fallback: when the source has no name, keep the node identity visible
            (still clickable to the popup) so the header isn't blank (#4908). */}
        {!sourceName && !mqttReadOnly && authStatus?.authenticated && (
          <div className="node-info">{renderNodeInfo()}</div>
        )}
      </div>
      <div className="header-right">
        <div className="connection-status-container">
          {/* The badge cycles through Connected → Battery → Airtime for the
              local node when connected and telemetry is available (#4917). The
              colored dot + update-method indicator stay fixed; only the middle
              label rotates. */}
          <CyclingConnectionStatus
            connectionStatus={connectionStatus}
            connectionStatusText={getConnectionStatusText()}
            webSocketConnected={webSocketConnected}
            metrics={localNodeMetrics}
            onClick={onFetchSystemStatus}
            title={`${t('header.clickForStatus')} | ${t('header.updateMethod')}: ${webSocketConnected ? 'WebSocket' : t('header.polling')}`}
          />
          {/* Disconnect/Reconnect moved into the System Status popup that this
              status indicator opens (#4908). */}
        </div>
        {authStatus?.authenticated ? (
          <UserMenu onLogout={onLogout} />
        ) : (
          <button className="login-button" onClick={onShowLoginModal}>
            <span><UiIcon name="encrypted" size={15} /></span>
            <span>{t('header.login')}</span>
          </button>
        )}
      </div>
    </header>
  );
};
