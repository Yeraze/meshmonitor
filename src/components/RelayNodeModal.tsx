import React from 'react';
import { createPortal } from 'react-dom';
import './RelayNodeModal.css';

interface Node {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
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
  if (!isOpen) return null;

  console.log('[RelayNodeModal] Props:', { relayNode, ackFromNode, rxTime, nodeCount: nodes.length });

  // If ackFromNode is provided (and not null), show that specific node
  // Otherwise, try to match relay_node:
  //   1. First try exact match (in case relay_node contains full node number)
  //   2. Fall back to matching lowest byte only
  const matchingNodes = (ackFromNode !== undefined && ackFromNode !== null)
    ? nodes.filter(node => {
        console.log(`[ACK MODE] Comparing node ${node.longName} (${node.nodeNum}) vs ackFromNode=${ackFromNode}`);
        return node.nodeNum === ackFromNode;
      })
    : (() => {
        // Try exact match first
        const exactMatches = nodes.filter(node => node.nodeNum === relayNode);
        if (exactMatches.length > 0) {
          console.log(`[RELAY MODE - EXACT] Found ${exactMatches.length} exact match(es) for relayNode=${relayNode}`);
          return exactMatches;
        }

        // Fall back to byte matching
        const byteMatches = nodes.filter(node => {
          const lastByte = node.nodeNum & 0xFF;
          console.log(`[RELAY MODE - BYTE] Comparing node ${node.longName} (${node.nodeNum}, 0x${node.nodeNum.toString(16)}) lastByte=0x${lastByte.toString(16)} vs relayNode=0x${relayNode.toString(16)}`);
          return lastByte === relayNode;
        });
        console.log(`[RELAY MODE - BYTE] Found ${byteMatches.length} byte match(es) for relayNode=0x${relayNode.toString(16)}`);
        return byteMatches;
      })();

  const formatDateTime = (date?: Date) => {
    if (!date) return 'Unknown';
    return date.toLocaleString();
  };

  const handleNodeClick = (nodeId: string, e: React.MouseEvent) => {
    e.preventDefault();
    onNodeClick(nodeId);
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const modalContent = (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal-content relay-node-modal">
        <div className="modal-header">
          <h2>{(ackFromNode !== undefined && ackFromNode !== null) ? 'Message Acknowledgment' : 'Message Relay Information'}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="relay-info-section">
            <div className="relay-info-row">
              <span className="relay-info-label">Acknowledged:</span>
              <span className="relay-info-value">{formatDateTime(rxTime)}</span>
            </div>
            {(ackFromNode === undefined || ackFromNode === null) && (
              <div className="relay-info-row">
                <span className="relay-info-label">Relay Node Byte:</span>
                <span className="relay-info-value">0x{relayNode.toString(16).padStart(2, '0').toUpperCase()}</span>
              </div>
            )}
          </div>

          <div className="potential-relays-section">
            <h3>{(ackFromNode !== undefined && ackFromNode !== null) ? 'Acknowledged By' : 'Potential Relay Nodes'}</h3>
            {matchingNodes.length === 0 ? (
              <p className="no-matches">
                No nodes found matching relay byte 0x{relayNode.toString(16).padStart(2, '0').toUpperCase()}.
                The relay node may not be in the node database yet.
              </p>
            ) : (
              <div className="relay-nodes-list">
                {matchingNodes.map(node => (
                  <div
                    key={node.nodeId}
                    className="relay-node-item"
                    onClick={(e) => handleNodeClick(node.nodeId, e)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleNodeClick(node.nodeId, e as unknown as React.MouseEvent);
                      }
                    }}
                  >
                    <span className="node-name">
                      {node.longName} ({node.shortName})
                    </span>
                    <span className="node-id">[{node.nodeId}]</span>
                  </div>
                ))}
              </div>
            )}
            {matchingNodes.length > 1 && (
              <p className="multiple-matches-note">
                Note: Multiple nodes share the same lowest byte. The actual relay node is one of these.
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
