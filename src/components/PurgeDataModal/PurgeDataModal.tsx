import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BasicNodeInfo } from '../../types/device';
import './PurgeDataModal.css';

interface PurgeDataModalProps {
  isOpen: boolean;
  selectedNode: BasicNodeInfo | null;
  onClose: () => void;
  onPurgeMessages: (nodeNum: number) => void;
  onPurgeTraceroutes: (nodeNum: number) => void;
  onPurgeTelemetry: (nodeNum: number) => void;
  onPurgePositionHistory: (nodeNum: number) => void;
  onDeleteNode: (nodeNum: number) => void;
  onPurgeFromDevice: (nodeNum: number) => void;
  getNodeName: (nodeId: string) => string;
}

export const PurgeDataModal: React.FC<PurgeDataModalProps> = ({
  isOpen,
  selectedNode,
  onClose,
  onPurgeMessages,
  onPurgeTraceroutes,
  onPurgeTelemetry,
  onPurgePositionHistory,
  onDeleteNode,
  onPurgeFromDevice,
  getNodeName,
}) => {
  const { t } = useTranslation();

  if (!isOpen || !selectedNode) return null;

  const nodeName = selectedNode.user?.id ? getNodeName(selectedNode.user.id) : '';

  const handlePurgeMessages = () => {
    onPurgeMessages(selectedNode.nodeNum);
    onClose();
  };

  const handlePurgeTraceroutes = () => {
    onPurgeTraceroutes(selectedNode.nodeNum);
    onClose();
  };

  const handlePurgeTelemetry = () => {
    onPurgeTelemetry(selectedNode.nodeNum);
    onClose();
  };

  const handlePurgePositionHistory = () => {
    onPurgePositionHistory(selectedNode.nodeNum);
    onClose();
  };

  const handleDeleteNode = () => {
    onDeleteNode(selectedNode.nodeNum);
  };

  const handlePurgeFromDevice = () => {
    onPurgeFromDevice(selectedNode.nodeNum);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content purge-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('purgeModal.title', { nodeName })}</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p className="purge-warning">
            {t('purgeModal.warning')}
          </p>
          <div className="purge-actions-row">
            <button onClick={handlePurgeMessages} className="danger-btn purge-btn">
              {t('purgeModal.purgeMessages')}
            </button>
            <button onClick={handlePurgeTraceroutes} className="danger-btn purge-btn">
              {t('purgeModal.purgeTraceroutes')}
            </button>
            <button onClick={handlePurgeTelemetry} className="danger-btn purge-btn">
              {t('purgeModal.purgeTelemetry')}
            </button>
            <button onClick={handlePurgePositionHistory} className="danger-btn purge-btn">
              {t('purgeModal.purgePositionHistory')}
            </button>
          </div>
          <hr className="purge-divider" />
          <p className="purge-section-title">{t('purgeModal.deleteNodeTitle')}</p>
          <p className="purge-section-description">
            {t('purgeModal.deleteNodeDescription')}
          </p>
          <div className="purge-actions-column">
            <button onClick={handleDeleteNode} className="danger-btn purge-btn-full delete-local">
              {t('purgeModal.deleteLocal')}
            </button>
            <button onClick={handlePurgeFromDevice} className="danger-btn purge-btn-full delete-device">
              {t('purgeModal.deleteDevice')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
