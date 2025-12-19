import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthStatus } from '../../contexts/AuthContext';
import type { ResourceType } from '../../types/permission';
import type { LocalNodeInfo, BasicNodeInfo } from '../../types/device';
import type { ConnectionStatus } from '../../types/ui';
import UserMenu from '../UserMenu';
import './AppHeader.css';

interface DeviceInfoProp {
  localNodeInfo?: LocalNodeInfo;
}

interface AppHeaderProps {
  baseUrl: string;
  nodeAddress: string;
  currentNodeId: string;
  nodes: BasicNodeInfo[];
  deviceInfo: DeviceInfoProp | null;
  authStatus: AuthStatus | null;
  connectionStatus: ConnectionStatus;
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  onFetchSystemStatus: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onShowLoginModal: () => void;
  onLogout: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  baseUrl,
  nodeAddress,
  currentNodeId,
  nodes,
  deviceInfo,
  authStatus,
  connectionStatus,
  hasPermission,
  onFetchSystemStatus,
  onDisconnect,
  onReconnect,
  onShowLoginModal,
  onLogout,
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

    if (!localNode && deviceInfo?.localNodeInfo) {
      const { nodeId, longName, shortName } = deviceInfo.localNodeInfo;
      return (
        <span
          className="node-address"
          title={authStatus?.authenticated ? t('header.connectedTo', { address: nodeAddress }) : undefined}
          style={{ cursor: authStatus?.authenticated ? 'help' : 'default' }}
        >
          {longName} ({shortName}) - {nodeId}
        </span>
      );
    }

    if (localNode && localNode.user) {
      return (
        <span
          className="node-address"
          title={authStatus?.authenticated ? t('header.connectedTo', { address: nodeAddress }) : undefined}
          style={{ cursor: authStatus?.authenticated ? 'help' : 'default' }}
        >
          {localNode.user.longName} ({localNode.user.shortName}) - {localNode.user.id}
        </span>
      );
    }

    return <span className="node-address">{nodeAddress}</span>;
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="header-title">
          <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="header-logo" />
          <h1>MeshMonitor</h1>
        </div>
        <div className="node-info">{renderNodeInfo()}</div>
      </div>
      <div className="header-right">
        <div className="connection-status-container">
          <div className="connection-status" onClick={onFetchSystemStatus} title={t('header.clickForStatus')}>
            <span
              className={`status-indicator ${
                connectionStatus === 'user-disconnected' ? 'disconnected' : connectionStatus
              }`}
            ></span>
            <span>{getConnectionStatusText()}</span>
          </div>

          {hasPermission('connection', 'write') && connectionStatus === 'connected' && (
            <button onClick={onDisconnect} className="connection-control-btn" title={t('header.disconnectTitle')}>
              {t('header.disconnect')}
            </button>
          )}

          {hasPermission('connection', 'write') && connectionStatus === 'user-disconnected' && (
            <button onClick={onReconnect} className="connection-control-btn reconnect" title={t('header.connectTitle')}>
              {t('header.connect')}
            </button>
          )}
        </div>
        {authStatus?.authenticated ? (
          <UserMenu onLogout={onLogout} />
        ) : (
          <button className="login-button" onClick={onShowLoginModal}>
            <span>🔒</span>
            <span>{t('header.login')}</span>
          </button>
        )}
      </div>
    </header>
  );
};
