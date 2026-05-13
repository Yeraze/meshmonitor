import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

interface MeshCoreStatusBarProps {
  status: ConnectionStatus | null;
  loading: boolean;
  onOpenSettings: () => void;
  actions: MeshCoreActions;
}

export const MeshCoreStatusBar: React.FC<MeshCoreStatusBarProps> = ({
  status,
  loading,
  onOpenSettings,
  actions,
}) => {
  const { t } = useTranslation();
  const connected = status?.connected ?? false;
  const localName = status?.localNode?.name || t('meshcore.unknown', 'Unknown');

  return (
    <div className="meshcore-status-bar">
      <div className="meshcore-status-bar-left">
        <span className={`status-dot ${connected ? 'connected' : ''}`} />
        <span className="status-text">
          {connected
            ? t('meshcore.connected_to', { name: localName, defaultValue: `Connected to ${localName}` })
            : t('meshcore.disconnected', 'Disconnected')}
        </span>
        {connected && status?.deviceTypeName && (
          <span className="status-meta">{status.deviceTypeName}</span>
        )}
      </div>
      <div className="meshcore-status-bar-right">
        {connected ? (
          <>
            <button
              onClick={() => void actions.sendAdvert()}
              disabled={loading}
              title={t('meshcore.send_advert', 'Send advert')}
            >
              {t('meshcore.send_advert', 'Send advert')}
            </button>
            <button
              className="disconnect"
              onClick={() => void actions.disconnect()}
              disabled={loading}
            >
              {t('meshcore.disconnect', 'Disconnect')}
            </button>
          </>
        ) : (
          <button onClick={onOpenSettings} disabled={loading}>
            {loading
              ? t('meshcore.connecting', 'Connecting…')
              : t('meshcore.connect', 'Connect')}
          </button>
        )}
      </div>
    </div>
  );
};
