import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import './RelayNodeModal.css';

interface Node {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hopsAway?: number;
}

interface RelayNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  relayNode: number;
  ackFromNode?: number;  // If provided, show this node instead of relay matches
  rxTime?: Date;
  nodes: Node[];
  onNodeClick: (nodeId: string) => void;
}

const RelayNodeModal: React.FC<RelayNodeModalProps> = ({
  isOpen,
  onClose,
  relayNode,
  ackFromNode,
  rxTime,
  nodes,
  onNodeClick
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  // If ackFromNode is provided (and not null), show that specific node
  // Otherwise, try to match relay_node:
  //   1. First try exact match (in case relay_node contains full node number)
  //   2. Fall back to matching lowest byte only
  // Sort results by hopsAway ascending (closest nodes first)
  const matchingNodes = (ackFromNode !== undefined && ackFromNode !== null)
    ? nodes.filter(node => node.nodeNum === ackFromNode)
    : (() => {
        // Try exact match first
        const exactMatches = nodes.filter(node => node.nodeNum === relayNode);
        if (exactMatches.length > 0) {
          // Sort by hopsAway (ascending, closest first)
          return exactMatches.sort((a, b) => (a.hopsAway ?? Infinity) - (b.hopsAway ?? Infinity));
        }

        // Fall back to byte matching
        const byteMatches = nodes.filter(node => (node.nodeNum & 0xFF) === relayNode);
        // Sort by hopsAway (ascending, closest first)
        return byteMatches.sort((a, b) => (a.hopsAway ?? Infinity) - (b.hopsAway ?? Infinity));
      })();

  const formatDateTime = (date?: Date) => {
    if (!date) return t('common.unknown');
    return date.toLocaleString();
  };

  const handleNodeClick = (nodeId: string) => {
    onNodeClick(nodeId);
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const isAckMode = ackFromNode !== undefined && ackFromNode !== null;

  const modalContent = (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content relay-node-modal">
        <div className="modal-header">
          <h2>{isAckMode ? t('relay_modal.title_ack') : t('relay_modal.title_relay')}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="relay-info-section">
            <div className="relay-info-row">
              <span className="relay-info-label">{t('relay_modal.acknowledged')}:</span>
              <span className="relay-info-value">{formatDateTime(rxTime)}</span>
            </div>
            {!isAckMode && (
              <div className="relay-info-row">
                <span className="relay-info-label">{t('relay_modal.relay_node_byte')}:</span>
                <span className="relay-info-value">0x{relayNode.toString(16).padStart(2, '0').toUpperCase()}</span>
              </div>
            )}
          </div>

          <div className="potential-relays-section">
            <h3>{isAckMode ? t('relay_modal.acknowledged_by') : t('relay_modal.potential_relays')}</h3>
            {matchingNodes.length === 0 ? (
              <p className="no-matches">
                {t('relay_modal.no_matches', { byte: `0x${relayNode.toString(16).padStart(2, '0').toUpperCase()}` })}
              </p>
            ) : (
              <div className="relay-nodes-list">
                {matchingNodes.map(node => (
                  <div
                    key={node.nodeId}
                    className="relay-node-item"
                    onClick={() => handleNodeClick(node.nodeId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleNodeClick(node.nodeId);
                      }
                    }}
                  >
                    <span className="node-name">
                      {node.longName} ({node.shortName})
                    </span>
                    {node.hopsAway !== undefined && (
                      <span className="node-hops">
                        {node.hopsAway === 0
                          ? t('relay_modal.direct')
                          : t('relay_modal.hops_away', { count: node.hopsAway })}
                      </span>
                    )}
                    <span className="node-id">[{node.nodeId}]</span>
                  </div>
                ))}
              </div>
            )}
            {matchingNodes.length > 1 && (
              <p className="multiple-matches-note">
                {t('relay_modal.multiple_matches_note')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default RelayNodeModal;
