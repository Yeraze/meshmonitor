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
  webSocketConnected: boolean;
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;
  onFetchSystemStatus: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onShowLoginModal: () => void;
  onLogout: () => void;
  onNodeClick?: () => void;
  /** Source name to display when in multi-source mode */
  sourceName?: string | null;
  /** Called when the user clicks the back-to-sources button */
  onBackToSources?: () => void;
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
  hasPermission,
  onFetchSystemStatus,
  onDisconnect,
  onReconnect,
  onShowLoginModal,
  onLogout,
  onNodeClick,
  sourceName,
  onBackToSources,
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
    const isClickable = authStatus?.authenticated && onNodeClick;

    if (!localNode && deviceInfo?.localNodeInfo) {
      const { nodeId, longName, shortName } = deviceInfo.localNodeInfo;
      return (
        <span
          className={`node-address${isClickable ? ' clickable' : ''}`}
          title={authStatus?.authenticated ? t('header.clickForNodeInfo') : undefined}
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
          title={authStatus?.authenticated ? t('header.clickForNodeInfo') : undefined}
          style={{ cursor: isClickable ? 'pointer' : 'default' }}
          onClick={isClickable ? onNodeClick : undefined}
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
        {onBackToSources && (
          <button
            className="back-to-sources-btn"
            onClick={onBackToSources}
            title="Back to source list"
          >
            ← Sources
          </button>
        )}
        <div className="header-title">
          <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="header-logo" />
          <h1>MeshMonitor</h1>
          {sourceName && (
            <span className="header-source-name">{sourceName}</span>
          )}
        </div>
        <div className="node-info">{renderNodeInfo()}</div>
      </div>
      <div className="header-right">
        <div className="connection-status-container">
          <div
            className="connection-status"
            onClick={onFetchSystemStatus}
            title={`${t('header.clickForStatus')} | ${t('header.updateMethod')}: ${webSocketConnected ? 'WebSocket' : t('header.polling')}`}
          >
            <span
              className={`status-indicator ${
                connectionStatus === 'user-disconnected' ? 'disconnected' : connectionStatus
              }`}
            ></span>
            <span>{getConnectionStatusText()}</span>
            <span
              className={`update-method-indicator ${webSocketConnected ? 'websocket' : 'polling'}`}
              title={webSocketConnected ? 'Real-time via WebSocket' : 'Polling every 5 seconds'}
            >
              {webSocketConnected ? '⚡' : '🔄'}
            </span>
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
