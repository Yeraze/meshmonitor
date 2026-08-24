import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SystemStatus } from '../../types/ui';
import Modal from '../common/Modal';
import './SystemStatusModal.css';

interface SystemStatusModalProps {
  isOpen: boolean;
  systemStatus: SystemStatus | null;
  onClose: () => void;
  /** Current connection state — gates the disconnect/reconnect control (#4908). */
  connectionStatus?: string;
  /** Whether the viewer may manage the connection (connection:write). */
  canManageConnection?: boolean;
  /** Disconnect the current source (moved here from the header, #4908). */
  onDisconnect?: () => void;
  /** Reconnect after a user disconnect. */
  onReconnect?: () => void;
}

export const SystemStatusModal: React.FC<SystemStatusModalProps> = ({
  isOpen,
  systemStatus,
  onClose,
  connectionStatus,
  canManageConnection = false,
  onDisconnect,
  onReconnect,
}) => {
  const { t } = useTranslation();

  if (!systemStatus) return null;

  // Connection control lives in this popup now (opened by clicking the header
  // status indicator) instead of a standalone header button (#4908).
  const canDisconnect = canManageConnection && connectionStatus === 'connected';
  const canReconnect = canManageConnection && connectionStatus === 'user-disconnected';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('system_status.title', 'System Status')}>
      <div className="status-grid">
        <div className="status-item">
          <strong>{t('system_status.version', 'Version')}:</strong>
          <span>{systemStatus.version}</span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.node_version', 'Node.js Version')}:</strong>
          <span>{systemStatus.nodeVersion}</span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.uptime', 'Uptime')}:</strong>
          <span>{systemStatus.uptime}</span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.platform', 'Platform')}:</strong>
          <span>
            {systemStatus.platform} ({systemStatus.architecture})
          </span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.environment', 'Environment')}:</strong>
          <span>{systemStatus.environment}</span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.memory_heap_used', 'Memory (Heap Used)')}:</strong>
          <span>{systemStatus.memoryUsage.heapUsed}</span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.memory_heap_total', 'Memory (Heap Total)')}:</strong>
          <span>{systemStatus.memoryUsage.heapTotal}</span>
        </div>
        <div className="status-item">
          <strong>{t('system_status.memory_rss', 'Memory (RSS)')}:</strong>
          <span>{systemStatus.memoryUsage.rss}</span>
        </div>
        {systemStatus.database && (
          <div className="status-item">
            <strong>{t('system_status.database', 'Database')}:</strong>
            <span>
              {systemStatus.database.type} {systemStatus.database.version}
            </span>
          </div>
        )}
      </div>
      {(canDisconnect || canReconnect) && (
        <div className="status-connection-control">
          {canDisconnect && (
            <button
              type="button"
              className="connection-control-btn"
              onClick={() => { onDisconnect?.(); onClose(); }}
              title={t('header.disconnectTitle')}
            >
              {t('header.disconnect')}
            </button>
          )}
          {canReconnect && (
            <button
              type="button"
              className="connection-control-btn reconnect"
              onClick={() => { onReconnect?.(); onClose(); }}
              title={t('header.connectTitle')}
            >
              {t('header.connect')}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
};
