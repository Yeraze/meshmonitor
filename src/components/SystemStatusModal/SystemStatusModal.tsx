import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SystemStatus } from '../../types/ui';
import './SystemStatusModal.css';

interface SystemStatusModalProps {
  isOpen: boolean;
  systemStatus: SystemStatus | null;
  onClose: () => void;
}

export const SystemStatusModal: React.FC<SystemStatusModalProps> = ({
  isOpen,
  systemStatus,
  onClose,
}) => {
  const { t } = useTranslation();

  if (!isOpen || !systemStatus) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('system_status.title', 'System Status')}</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
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
          </div>
        </div>
      </div>
    </div>
  );
};
