import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DeviceRole, isRelayRole } from '../constants';
import './RelayNodeModal.css';

interface Node {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hopsAway?: number;
  role?: number;
  avgDirectRssi?: number;   // Average RSSI when heard directly (from zero-hop packets)
  heardDirectly?: boolean;  // Whether we've heard this node with 0 hops
}

interface RelayNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  relayNode: number;
  ackFromNode?: number;  // If provided, show this node instead of relay matches
  rxTime?: Date;
  nodes: Node[];
  onNodeClick: (nodeId: string) => void;
  messageRssi?: number;     // RSSI of the message being analyzed
}

const RelayNodeModal: React.FC<RelayNodeModalProps> = ({
  isOpen,
  onClose,
  relayNode,
  ackFromNode,
  rxTime,
  nodes,
  onNodeClick,
  messageRssi
}) => {
  const { t } = useTranslation();

  if (!isOpen) return null;

  /**
   * Sort nodes by likelihood of being the relay:
   * 1. Nodes heard directly first (heardDirectly === true)
   * 2. For directly heard nodes, sort by RSSI proximity to message RSSI
   * 3. For others, sort by hopsAway (ascending)
   */
  const sortByLikelihood = (nodeList: Node[]): Node[] => {
    return [...nodeList].sort((a, b) => {
      // Priority 1: Nodes heard directly come first
      const aHeard = a.heardDirectly === true;
      const bHeard = b.heardDirectly === true;

      if (aHeard && !bHeard) return -1;
      if (!aHeard && bHeard) return 1;

      // Priority 2: For directly heard nodes with RSSI data, sort by proximity to message RSSI
      if (aHeard && bHeard && messageRssi !== undefined) {
        const aRssiDiff = a.avgDirectRssi !== undefined ? Math.abs(a.avgDirectRssi - messageRssi) : Infinity;
        const bRssiDiff = b.avgDirectRssi !== undefined ? Math.abs(b.avgDirectRssi - messageRssi) : Infinity;
        if (aRssiDiff !== bRssiDiff) {
          return aRssiDiff - bRssiDiff;
        }
      }

      // Priority 3: Sort by hopsAway (ascending, closest first)
      return (a.hopsAway ?? Infinity) - (b.hopsAway ?? Infinity);
    });
  };

  // If ackFromNode is provided (and not null), show that specific node
  // Otherwise, try to match relay_node:
  //   1. If relay_node is 0 (unset), show all relay-capable nodes sorted by RSSI
  //   2. First try exact match (in case relay_node contains full node number)
  //   3. Fall back to matching lowest byte only
  // Filter out CLIENT_MUTE nodes since they don't relay
  // Sort results by likelihood
  const matchingNodes = (ackFromNode !== undefined && ackFromNode !== null)
    ? nodes.filter(node => node.nodeNum === ackFromNode)
    : (() => {
        // Filter out CLIENT_MUTE nodes - they don't relay
        const relayCapableNodes = nodes.filter(node => node.role !== DeviceRole.CLIENT_MUTE);

        // If relay_node is 0 (unset), show all relay-capable direct neighbors sorted by RSSI
        if (relayNode === 0) {
          // Only show nodes we've actually heard directly, sorted by RSSI proximity
          const directNeighbors = relayCapableNodes.filter(node => node.heardDirectly === true);
          return sortByLikelihood(directNeighbors);
        }

        // Try exact match first
        const exactMatches = relayCapableNodes.filter(node => node.nodeNum === relayNode);
        if (exactMatches.length > 0) {
          return sortByLikelihood(exactMatches);
        }

        // Fall back to byte matching
        // A relay MUST be a direct neighbor, so filter to only plausible candidates
        const byteMatches = relayCapableNodes.filter(node => (node.nodeNum & 0xFF) === relayNode);
        const plausibleRelays = byteMatches.filter(node =>
          node.heardDirectly === true || (node.hopsAway !== undefined && node.hopsAway <= 1)
        );
        return sortByLikelihood(plausibleRelays);
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
  const isUnknownRelay = !isAckMode && relayNode === 0;

  const modalContent = (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content relay-node-modal">
        <div className="modal-header">
          <h2>{isAckMode ? t('relay_modal.title_ack') : isUnknownRelay ? t('relay_modal.title_unknown') : t('relay_modal.title_relay')}</h2>
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
            {!isAckMode && !isUnknownRelay && (
              <div className="relay-info-row">
                <span className="relay-info-label">{t('relay_modal.relay_node_byte')}:</span>
                <span className="relay-info-value">0x{relayNode.toString(16).padStart(2, '0').toUpperCase()}</span>
              </div>
            )}
            {isUnknownRelay && (
              <p className="unknown-relay-notice">
                {t('relay_modal.unknown_relay_explanation')}
              </p>
            )}
          </div>

          <div className="potential-relays-section">
            <h3>{isAckMode ? t('relay_modal.acknowledged_by') : isUnknownRelay ? t('relay_modal.estimated_relays') : t('relay_modal.potential_relays')}</h3>
            {matchingNodes.length === 0 ? (
              <p className="no-matches">
                {isUnknownRelay ? t('relay_modal.no_direct_neighbors') : t('relay_modal.no_matches', { byte: `0x${relayNode.toString(16).padStart(2, '0').toUpperCase()}` })}
              </p>
            ) : (
              <div className="relay-nodes-list">
                {matchingNodes.map(node => (
                  <div
                    key={node.nodeId}
                    className={`relay-node-item ${!node.heardDirectly ? 'never-heard' : ''}`}
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
                    <div className="node-main-info">
                      <span className="node-name">
                        {node.heardDirectly && (
                          <span className="direct-indicator" title={t('relay_modal.heard_directly')}>
                            ✓
                          </span>
                        )}
                        {node.longName} ({node.shortName})
                        {isRelayRole(node.role) && (
                          <span className="relay-indicator" title={t('relay_modal.likely_relay')}>
                            📡
                          </span>
                        )}
                      </span>
                      {node.avgDirectRssi !== undefined && (
                        <span className="node-rssi" title={t('relay_modal.avg_rssi')}>
                          {node.avgDirectRssi.toFixed(0)} dBm
                        </span>
                      )}
                    </div>
                    <div className="node-meta-info">
                      {node.hopsAway !== undefined && (
                        <span className="node-hops">
                          {node.hopsAway === 0
                            ? t('relay_modal.direct')
                            : t('relay_modal.hops_away', { count: node.hopsAway })}
                        </span>
                      )}
                      <span className="node-id">[{node.nodeId}]</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {matchingNodes.length > 1 && (
              <p className="multiple-matches-note">
                {isUnknownRelay ? t('relay_modal.rssi_estimate_note') : t('relay_modal.multiple_matches_note')}
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
